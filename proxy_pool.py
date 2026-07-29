"""上游访问策略：运行时配置真源 + 代理轮换 + 全局请求节流。

工信部按 IP 风控，查询多了会对验证码接口返回 403 拦截页。本模块提供：

- ``RuntimeConfig``：线程安全的运行时配置真源（优先级：配置文件 > 环境变量 >
  默认），支持热更新与落盘，前端「设置」页通过 ``/api/v1/config`` 读写它；
- ``ProxyProvider``：按配置提供代理并轮换（固定列表 + 动态提取 API），换 IP；
- ``RateLimiter``：进程级最小请求间隔限速；
- ``RateLimited`` / ``UpstreamError``：限流或网络/代理失败时抛出，携带中文提示。

``MiitClient`` 在多线程（批量并发）中使用，故均线程安全。
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import urllib.request

log = logging.getLogger(__name__)

_IP_PORT_RE = re.compile(r"\d{1,3}(?:\.\d{1,3}){3}:\d+")
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runtime_config.json")

_DEFAULTS = {
    "proxies": [],
    "api_url": None,
    "auth": None,
    "api_ttl": 10.0,
    "min_interval": 0.8,
    "max_retries": 3,
    "blacklist_threshold": 3,  # 代理连续失败多少次加入黑名单
    "blacklist_duration": 300,  # 黑名单有效期（秒）
}


class UpstreamError(RuntimeError):
    """上游访问失败（网络/代理/限流）的统一基类，可直接作为用户可见错误。"""


class RateLimited(UpstreamError):
    """上游返回 403/拦截页等限流信号时抛出。"""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def as_proxies(url: str | None) -> dict | None:
    """转成 curl_cffi/requests 的 proxies 结构；None 表示直连。"""
    if not url:
        return None
    return {"http": url, "https": url}


def mask_proxy(url: str | None) -> str:
    """隐去代理里的认证信息用于展示。"""
    if not url:
        return "直连"
    return re.sub(r"//[^@/]+@", "//***@", url)


def _normalize_proxy(raw: str, auth: str | None) -> str | None:
    """把一条代理配置规范成 ``http://[user:pass@]host:port``。"""
    raw = (raw or "").strip()
    if not raw:
        return None
    if "://" in raw:
        scheme, rest = raw.split("://", 1)
    else:
        scheme, rest = "http", raw
    if auth and "@" not in rest:
        rest = f"{auth}@{rest}"
    return f"{scheme}://{rest}"


def _coerce_proxies(value, auth: str | None) -> list[str]:
    """把 list 或逗号/换行字符串归一化成 ``http://...`` 列表。"""
    items = re.split(r"[,\n]", value) if isinstance(value, str) else list(value or [])
    out: list[str] = []
    for item in items:
        proxy = _normalize_proxy(item if isinstance(item, str) else "", auth)
        if proxy:
            out.append(proxy)
    return out


def _read_env() -> dict:
    out: dict = {"auth": os.environ.get("MIIT_PROXY_AUTH") or None}
    if os.environ.get("MIIT_PROXIES") is not None:
        out["proxies"] = os.environ["MIIT_PROXIES"]
    if os.environ.get("MIIT_PROXY_API_URL"):
        out["api_url"] = os.environ["MIIT_PROXY_API_URL"]
    for key, env, cast in (("api_ttl", "MIIT_PROXY_API_TTL", float),
                           ("min_interval", "MIIT_MIN_INTERVAL", float),
                           ("max_retries", "MIIT_MAX_RETRIES", int),
                           ("blacklist_threshold", "MIIT_BLACKLIST_THRESHOLD", int),
                           ("blacklist_duration", "MIIT_BLACKLIST_DURATION", int)):
        val = os.environ.get(env)
        if val is not None:
            try:
                out[key] = cast(val)
            except ValueError:
                pass
    return out


class RuntimeConfig:
    """运行时可变配置真源（线程安全）。优先级：配置文件 > 环境变量 > 默认。"""

    def __init__(self, values: dict, path: str = CONFIG_PATH):
        self._path = path
        self._lock = threading.Lock()
        self._v = 0
        self._data = dict(_DEFAULTS)
        self._data.update(values or {})

    @classmethod
    def load(cls, path: str = CONFIG_PATH) -> "RuntimeConfig":
        data = dict(_DEFAULTS)
        data.update({k: v for k, v in _read_env().items() if v is not None})
        try:
            with open(path, encoding="utf-8") as fp:
                file_data = json.load(fp)
            if isinstance(file_data, dict):
                data.update({k: file_data[k] for k in _DEFAULTS if k in file_data})
        except FileNotFoundError:
            pass
        except Exception as exc:  # 坏文件不致命，回退到 env/默认
            log.warning("读取 %s 失败：%s", path, exc)
        data["proxies"] = _coerce_proxies(data.get("proxies"), data.get("auth"))
        cfg = cls(data, path)
        if data["proxies"] or data.get("api_url"):
            log.info("代理配置已加载：固定 %d 条%s", len(data["proxies"]),
                     "，动态 API 开启" if data.get("api_url") else "")
        return cfg

    @property
    def version(self) -> int:
        with self._lock:
            return self._v

    def snapshot(self) -> dict:
        with self._lock:
            snap = dict(self._data)
            snap["version"] = self._v
            return snap

    def update(self, patch: dict) -> None:
        with self._lock:
            data = dict(self._data)
            if "auth" in patch:
                data["auth"] = patch["auth"] or None
            if "api_url" in patch:
                data["api_url"] = patch["api_url"] or None
            if "proxies" in patch:
                data["proxies"] = _coerce_proxies(patch["proxies"], data.get("auth"))
            if "api_ttl" in patch and patch["api_ttl"] is not None:
                data["api_ttl"] = max(0.0, float(patch["api_ttl"]))
            if "min_interval" in patch and patch["min_interval"] is not None:
                data["min_interval"] = max(0.0, float(patch["min_interval"]))
            if "max_retries" in patch and patch["max_retries"] is not None:
                data["max_retries"] = max(1, int(patch["max_retries"]))
            if "blacklist_threshold" in patch and patch["blacklist_threshold"] is not None:
                data["blacklist_threshold"] = max(1, int(patch["blacklist_threshold"]))
            if "blacklist_duration" in patch and patch["blacklist_duration"] is not None:
                data["blacklist_duration"] = max(0, int(patch["blacklist_duration"]))
            self._data = data
            self._v += 1
            self._save_locked()
            log.info("运行时配置已更新 version=%d（代理 %d 条，间隔 %.2fs，重试 %d，黑名单 %d次/%ds）",
                     self._v, len(data["proxies"]), data["min_interval"], data["max_retries"],
                     data["blacklist_threshold"], data["blacklist_duration"])

    def to_public(self, provider: "ProxyProvider | None" = None) -> dict:
        snap = self.snapshot()
        status = {"enabled": bool(snap["proxies"] or snap["api_url"])}
        if provider is not None:
            status.update(provider.status())
        return {
            "proxies": snap["proxies"],
            "api_url": snap["api_url"],
            "auth": snap["auth"],
            "api_ttl": snap["api_ttl"],
            "min_interval": snap["min_interval"],
            "max_retries": snap["max_retries"],
            "blacklist_threshold": snap["blacklist_threshold"],
            "blacklist_duration": snap["blacklist_duration"],
            "status": status,
        }

    def _save_locked(self) -> None:
        try:
            with open(self._path, "w", encoding="utf-8") as fp:
                json.dump({k: self._data[k] for k in _DEFAULTS}, fp,
                          ensure_ascii=False, indent=2)
        except Exception as exc:
            log.warning("保存 %s 失败：%s", self._path, exc)


class ProxyProvider:
    """按 RuntimeConfig 提供代理并轮换（线程安全）。动态 API 优先，固定列表兜底。"""

    def __init__(self, config: RuntimeConfig):
        self._config = config
        self._lock = threading.Lock()
        self._idx = -1
        self._current: str | None = None
        self._api_cached: str | None = None
        self._api_cached_at = 0.0
        self._seen_version = -1
        self._rotations = 0
        self._failed_proxies = {}  # {proxy_url: (fail_count, last_fail_time)}

    def enabled(self) -> bool:
        snap = self._config.snapshot()
        return bool(snap["proxies"] or snap["api_url"])

    def current(self) -> str | None:
        with self._lock:
            snap = self._config.snapshot()
            self._reset_if_changed(snap)
            if self._current is None and (snap["proxies"] or snap["api_url"]):
                self._current = self._pick_locked(snap)
            return self._current

    def rotate(self) -> str | None:
        with self._lock:
            snap = self._config.snapshot()
            self._reset_if_changed(snap)
            self._current = self._pick_locked(snap, force=True)
            self._rotations += 1
            log.info("切换代理 -> %s", mask_proxy(self._current))
            return self._current

    def status(self) -> dict:
        with self._lock:
            snap = self._config.snapshot()
            enabled = bool(snap["proxies"] or snap["api_url"])
            # 先固化 key：_is_blacklisted_locked 会删除过期记录，直接遍历字典会抛
            # RuntimeError: dictionary changed size during iteration
            blacklisted = [mask_proxy(p) for p in list(self._failed_proxies)
                          if self._is_blacklisted_locked(p)]
            return {"current": mask_proxy(self._current if enabled else None),
                    "rotations": self._rotations,
                    "blacklisted": blacklisted}

    def mark_failed(self, proxy_url: str | None) -> None:
        """标记代理失败，用于健康检查"""
        if not proxy_url:
            return
        with self._lock:
            snap = self._config.snapshot()
            threshold = snap["blacklist_threshold"]
            duration = snap["blacklist_duration"]
            now = time.time()
            if proxy_url in self._failed_proxies:
                count, _ = self._failed_proxies[proxy_url]
                self._failed_proxies[proxy_url] = (count + 1, now)
                if count + 1 >= threshold:
                    log.warning("代理 %s 连续失败 %d 次，加入黑名单 %d 秒",
                              mask_proxy(proxy_url), count + 1, duration)
            else:
                self._failed_proxies[proxy_url] = (1, now)

    def mark_success(self, proxy_url: str | None) -> None:
        """标记代理成功，清除失败记录"""
        if not proxy_url:
            return
        with self._lock:
            if proxy_url in self._failed_proxies:
                del self._failed_proxies[proxy_url]

    def _is_blacklisted_locked(self, proxy_url: str) -> bool:
        """检查代理是否在黑名单（需持有锁）"""
        if proxy_url not in self._failed_proxies:
            return False
        snap = self._config.snapshot()
        threshold = snap["blacklist_threshold"]
        duration = snap["blacklist_duration"]
        count, last_fail = self._failed_proxies[proxy_url]
        if time.time() - last_fail > duration:
            del self._failed_proxies[proxy_url]  # 过期清除
            return False
        return count >= threshold

    def _reset_if_changed(self, snap: dict) -> None:
        if snap["version"] != self._seen_version:
            self._seen_version = snap["version"]
            self._idx = -1
            self._current = None
            self._api_cached = None
            self._api_cached_at = 0.0

    def _pick_locked(self, snap: dict, force: bool = False) -> str | None:
        if snap["api_url"]:
            got = self._fetch_api_locked(snap, force=force)
            if got and not self._is_blacklisted_locked(got):
                return got
        proxies = snap["proxies"]
        if proxies:
            # 过滤黑名单代理
            available = [p for p in proxies if not self._is_blacklisted_locked(p)]
            if not available:
                log.warning("所有代理均在黑名单中，重置黑名单")
                self._failed_proxies.clear()
                available = proxies
            self._idx = (self._idx + 1) % len(available)
            return available[self._idx]
        return None

    def _fetch_api_locked(self, snap: dict, force: bool) -> str | None:
        now = time.monotonic()
        if not force and self._api_cached and (now - self._api_cached_at) < snap["api_ttl"]:
            return self._api_cached
        try:
            with urllib.request.urlopen(snap["api_url"], timeout=8) as resp:
                text = resp.read().decode("utf-8", "ignore")
        except Exception as exc:  # 提取失败回退上次缓存
            log.warning("动态代理 API 提取失败：%s", exc)
            return self._api_cached

        # 支持两种格式：user:pass@ip:port 或 ip:port
        text = text.strip()
        if '@' in text:
            # 完整格式 user:pass@ip:port，直接使用
            proxy = _normalize_proxy(text, None)
        else:
            # 简单格式 ip:port，使用配置的auth
            match = _IP_PORT_RE.search(text)
            if not match:
                log.warning("动态代理 API 未解析出格式，响应片段：%.120s", text)
                return self._api_cached
            proxy = _normalize_proxy(match.group(0), snap["auth"])

        self._api_cached = proxy
        self._api_cached_at = now
        return proxy


class RateLimiter:
    """进程级最小请求间隔（线程安全），间隔取自 RuntimeConfig。"""

    def __init__(self, config: RuntimeConfig):
        self._config = config
        self._lock = threading.Lock()
        self._last = 0.0

    def acquire(self) -> None:
        min_interval = self._config.snapshot()["min_interval"]
        if min_interval <= 0:
            return
        with self._lock:
            wait = min_interval - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
