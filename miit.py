"""工信部备案查询客户端。

流程：auth 取 token -> 取滑块验证码 -> 识别缺口 -> checkImage 取 sign ->
queryByCondition 查询。token 约 8 分钟有效可复用；每次查询需要一次验证码。

HTTP 用 curl_cffi 模拟 Chrome 的 TLS 指纹，避免被 MIIT 的反爬直接断连
（普通 requests 可能出现 SSL EOF / 连接被重置）。
"""
import base64
import hashlib
import json
import logging
import random
import threading
import time
import uuid

from curl_cffi import requests

from captcha import detect_gap
from proxy_pool import RateLimited, UpstreamError, as_proxies, mask_proxy

log = logging.getLogger(__name__)

BASE = "https://hlwicpfwc.miit.gov.cn/icpproject_query/api"

# serviceType: 1=网站 6=APP 7=小程序 8=快应用
SERVICE_TYPES = {"网站": 1, "APP": 6, "小程序": 7, "快应用": 8}

# User-Agent 池 - 模拟不同版本的 Chrome
_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
]


def _b64url_json(seg: str) -> dict:
    seg += "=" * (-len(seg) % 4)
    return json.loads(base64.urlsafe_b64decode(seg))


class MiitClient:
    def __init__(self, config=None, proxy_provider=None, rate_limiter=None):
        self._config = config
        self._proxy = proxy_provider
        self._limiter = rate_limiter
        self._seen_version = config.version if config else 0
        self.token = None
        self.token_expire = 0  # 毫秒
        self.client_uid = "point-" + str(uuid.uuid4())
        self._lock = threading.Lock()  # 串行化，token/session 不被并发破坏
        self._proxy_url = self._proxy.current() if self._proxy else None
        self.session = self._build_session()
        log.info("创建 MiitClient，clientUid=%s 代理=%s",
                 self.client_uid, mask_proxy(self._proxy_url))

    def _build_session(self):
        # impersonate 让 TLS/HTTP2 指纹伪装成 Chrome
        return requests.Session(impersonate="chrome",
                                proxies=as_proxies(self._proxy_url))

    def _switch_proxy(self):
        """换下一个代理并重建会话；token/验证码需随新 IP 重来。"""
        if self._proxy and self._proxy.enabled():
            self._proxy_url = self._proxy.rotate()
        try:
            self.session.close()
        except Exception:
            pass
        self.session = self._build_session()
        self.token = None
        self.token_expire = 0

    def _headers(self, extra=None):
        h = {
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "User-Agent": random.choice(_USER_AGENTS),
            "Origin": "https://beian.miit.gov.cn",
            "Referer": "https://beian.miit.gov.cn/",
        }
        if extra:
            h.update(extra)
        return h

    def _post(self, path: str, label: str, **kwargs) -> dict:
        """统一发送 POST 并记录 HTTP 状态/耗时，返回解析后的 JSON。"""
        url = f"{BASE}{path}"
        kwargs.setdefault("timeout", 20)
        if self._limiter:
            self._limiter.acquire()  # 全局节流，降低触发风控概率
        started = time.perf_counter()
        try:
            r = self.session.post(url, **kwargs)
        except Exception as exc:
            log.error("%s 请求异常: POST %s -> %s", label, path, exc)
            raise UpstreamError(f"{label} 请求失败：{exc}") from exc
        elapsed = round((time.perf_counter() - started) * 1000)
        if r.status_code == 200:
            log.debug("%s HTTP 200 %d ms", label, elapsed)
        else:
            log.warning("%s 返回非 200: HTTP %s %d ms body=%.200s",
                        label, r.status_code, elapsed, r.text)
        # 识别工信部按 IP 风控的拦截：403/429 或返回 HTML 拦截页
        ctype = (r.headers.get("content-type") or "").lower()
        head = (r.text or "")[:64].lstrip().lower()
        if r.status_code in (403, 429) or "html" in ctype \
                or head.startswith("<!doctype") or head.startswith("<html"):
            raise RateLimited(
                f"触发工信部频率限制或拦截（{label} HTTP {r.status_code}），请稍后重试",
                status=r.status_code,
            )
        try:
            return r.json()
        except Exception as exc:
            log.error("%s 响应无法解析为 JSON: %s body=%.200s",
                      label, exc, r.text)
            raise

    def _warmup_session(self) -> None:
        """预热 session - 访问首页建立正常浏览行为"""
        try:
            log.debug("预热 session: GET https://beian.miit.gov.cn/")
            self.session.get(
                "https://beian.miit.gov.cn/",
                headers=self._headers(),
                timeout=10
            )
            # 随机延迟，模拟真实用户行为
            time.sleep(random.uniform(0.5, 1.5))
        except Exception as exc:
            log.debug("session 预热失败(不影响查询): %s", exc)

    def get_token(self) -> str:
        if self.token and time.time() * 1000 < self.token_expire - 60_000:
            log.debug("复用 token，剩余有效期约 %d 秒",
                      round((self.token_expire - time.time() * 1000) / 1000))
            return self.token

        # 新 token 前先预热 session
        self._warmup_session()

        ts = str(round(time.time() * 1000))
        auth_key = hashlib.md5(("testtest" + ts).encode()).hexdigest()
        log.debug("请求新 token: POST %s/auth", BASE)
        j = self._post(
            "/auth",
            "获取 token",
            data={"authKey": auth_key, "timeStamp": ts},
            headers=self._headers(
                {"Content-Type": "application/x-www-form-urlencoded"}),
        )
        try:
            self.token = j["params"]["bussiness"]
        except (KeyError, TypeError):
            log.error("获取 token 失败，响应: %s", j)
            raise
        try:
            # bussiness token 是 payload.signature 两段式，payload 在第 0 段
            self.token_expire = _b64url_json(self.token.split(".")[0])["e"]
        except Exception:
            self.token_expire = time.time() * 1000 + 300_000
            log.warning("token 未能解析过期时间，回退为当前时间 +300 秒")
        log.info("获取新 token 成功，过期时间戳 %s", self.token_expire)
        return self.token

    def _get_captcha(self):
        token = self.get_token()
        log.debug("请求验证码: POST %s/image/getCheckImagePoint", BASE)
        j = self._post(
            "/image/getCheckImagePoint",
            "获取验证码",
            json={"clientUid": self.client_uid},
            headers=self._headers({"Content-Type": "application/json",
                                   "token": token}),
        )
        try:
            p = j["params"]
            big = base64.b64decode(p["bigImage"])
            small = base64.b64decode(p["smallImage"])
            uid = p["uuid"]
        except (KeyError, TypeError) as exc:
            log.error("验证码响应缺少字段(%s)，响应: %s", exc, j)
            raise
        log.debug("获得验证码图片 uuid=%s bigImage=%dB smallImage=%dB",
                  uid, len(big), len(small))
        return big, small, uid

    def solve_captcha(self, retries=6):
        """返回 (uuid, sign)。识别失败自动换图重试。"""
        last = None
        for attempt in range(1, retries + 1):
            big, small, uid = self._get_captcha()
            x = detect_gap(big, small)
            log.debug("第 %d/%d 次识别缺口 x=%d uuid=%s",
                      attempt, retries, x, uid)
            token = self.get_token()
            j = self._post(
                "/image/checkImage",
                "校验验证码",
                json={"key": uid, "value": str(x)},
                headers=self._headers({"Content-Type": "application/json",
                                       "token": token}),
            )
            last = j
            if j.get("code") == 200 and j.get("success"):
                log.info("验证码识别成功，第 %d/%d 次尝试，x=%d uuid=%s",
                         attempt, retries, x, uid)
                return uid, j["params"]
            log.warning("验证码校验未通过（第 %d/%d 次）：x=%d code=%s msg=%s",
                        attempt, retries, x, j.get("code"), j.get("msg"))
            time.sleep(0.4)
        log.error("验证码识别失败，已重试 %d 次，最后响应: %s", retries, last)
        raise RuntimeError(f"验证码识别失败: {last}")

    def query_raw(self, unit_name: str, service_type: int = 1) -> dict:
        """查询，返回接口原始 json。遇限流/代理失败换代理退避重试（指数退避）。"""
        with self._lock:
            self._apply_config_if_changed()
            max_retries = self._config.snapshot()["max_retries"] if self._config else 3
            last: Exception | None = None
            for attempt in range(1, max_retries + 1):
                try:
                    result = self._query_once(unit_name, service_type)
                    # 查询成功，标记代理可用
                    if self._proxy:
                        self._proxy.mark_success(self._proxy_url)
                    return result
                except UpstreamError as exc:
                    last = exc
                    # 标记代理失败
                    if self._proxy:
                        self._proxy.mark_failed(self._proxy_url)

                    if attempt < max_retries:
                        # 指数退避 + 随机抖动
                        base_delay = min(2 ** attempt, 30)  # 最多30秒
                        jitter = random.uniform(0, 0.3 * base_delay)
                        delay = base_delay + jitter

                        log.warning("上游访问失败（%s），第 %d/%d 次，等待 %.1fs 后重试",
                                   exc, attempt, max_retries, delay)
                        self._switch_proxy()
                        time.sleep(delay)
                    else:
                        log.error("上游访问失败（%s），已达最大重试次数 %d", exc, max_retries)
            raise RateLimited(
                f"多次重试仍失败，请稍后再试或更换代理（最后错误：{last}）")

    def _apply_config_if_changed(self):
        """前端热更新配置后，下次查询主动切到新代理。"""
        if self._config and self._config.version != self._seen_version:
            self._seen_version = self._config.version
            self._proxy_url = self._proxy.current() if self._proxy else None
            try:
                self.session.close()
            except Exception:
                pass
            self.session = self._build_session()
            self.token = None
            self.token_expire = 0
            log.info("配置变更，切换代理=%s", mask_proxy(self._proxy_url))

    def _query_once(self, unit_name: str, service_type: int = 1) -> dict:
        log.info("开始查询: keyword=%r serviceType=%s", unit_name, service_type)
        started = time.perf_counter()
        self.get_token()
        uid, sign = self.solve_captcha()
        token = self.get_token()
        log.debug("提交查询: POST %s/icpAbbreviateInfo/queryByCondition "
                  "keyword=%r", BASE, unit_name)
        j = self._post(
            "/icpAbbreviateInfo/queryByCondition",
            "查询备案",
            json={"pageNum": "", "pageSize": "",
                  "unitName": unit_name, "serviceType": service_type},
            headers=self._headers({"Content-Type": "application/json",
                                   "token": token, "sign": sign,
                                   "uuid": uid}),
        )
        elapsed = round((time.perf_counter() - started) * 1000)
        if j.get("code") != 200:
            log.warning("查询接口返回异常: keyword=%r code=%s msg=%s",
                        unit_name, j.get("code"), j.get("msg"))
        log.info("查询完成: keyword=%r 耗时 %d ms code=%s",
                 unit_name, elapsed, j.get("code"))
        return j

    def query(self, unit_name: str, service_type: int = 1) -> dict:
        """查询并整理成简洁结果：{keyword, found, records:[...]}。"""
        j = self.query_raw(unit_name, service_type)
        params = j.get("params") or {}
        rows = params.get("list") or []
        records = [{
            "domain": it.get("domain"),
            "unitName": it.get("unitName"),
            "nature": it.get("natureName"),
            "mainLicence": it.get("mainLicence"),
            "serviceLicence": it.get("serviceLicence"),
            "updateTime": it.get("updateRecordTime"),
        } for it in rows]
        log.info("解析结果: keyword=%r 命中 %d 条记录", unit_name, len(records))
        return {
            "keyword": unit_name,
            "found": bool(records),
            "count": params.get("total") or len(records),
            "records": records,
        }
