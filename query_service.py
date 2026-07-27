"""Application service for single and concurrent batch queries."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import logging
import threading
import time
from collections.abc import Callable, Iterable

from miit import MiitClient
from proxy_pool import ProxyProvider, RateLimiter, RuntimeConfig


log = logging.getLogger(__name__)

ClientFactory = Callable[[], MiitClient]


def unique_keywords(keywords: Iterable[str]) -> list[str]:
    """Trim and de-duplicate keywords while preserving input order."""
    seen: set[str] = set()
    result: list[str] = []
    for keyword in keywords:
        keyword = keyword.strip()
        if keyword and keyword not in seen:
            seen.add(keyword)
            result.append(keyword)
    return result


class QueryService:
    """Run queries with one reusable MIIT client per worker thread.

    ``curl_cffi`` sessions and captcha state must not be shared by concurrent
    workers. Thread-local clients provide real parallelism while allowing each
    worker to reuse its token during a batch.
    """

    def __init__(self, client_factory: ClientFactory | None = None):
        self.config = RuntimeConfig.load()
        self.proxy_provider = ProxyProvider(self.config)
        self._limiter = RateLimiter(self.config)
        self._client_factory = client_factory or (
            lambda: MiitClient(self.config, self.proxy_provider, self._limiter))
        self._local = threading.local()

    def _client(self) -> MiitClient:
        client = getattr(self._local, "client", None)
        if client is None:
            log.debug("为线程 %s 创建新的 MiitClient",
                      threading.current_thread().name)
            client = self._client_factory()
            self._local.client = client
        return client

    def query_one(self, keyword: str, service_type: int = 1) -> dict:
        started = time.perf_counter()
        try:
            result = self._client().query(keyword, service_type)
            elapsed = round((time.perf_counter() - started) * 1000)
            log.info("单条查询成功: keyword=%r found=%s count=%s 耗时 %d ms",
                     keyword, result["found"], result["count"], elapsed)
            return {
                "success": True,
                **result,
                "error": None,
                "elapsed_ms": elapsed,
            }
        except Exception as exc:  # noqa: BLE001 - errors belong in API results
            elapsed = round((time.perf_counter() - started) * 1000)
            log.exception("单条查询失败: keyword=%r 耗时 %d ms 错误=%s",
                          keyword, elapsed, exc)
            return {
                "success": False,
                "keyword": keyword,
                "found": False,
                "count": 0,
                "records": [],
                "error": str(exc),
                "elapsed_ms": elapsed,
            }

    def query_batch(
        self,
        keywords: Iterable[str],
        service_type: int = 1,
        concurrency: int = 3,
    ) -> dict:
        items = unique_keywords(keywords)
        started = time.perf_counter()
        results: list[dict | None] = [None] * len(items)

        raw_count = len(keywords) if hasattr(keywords, "__len__") else None
        if raw_count is not None and raw_count != len(items):
            log.info("批量查询：原始 %d 条，去重后 %d 条", raw_count, len(items))

        if not items:
            log.info("批量查询：去重后无有效查询词，直接返回")
            return {
                "success": True,
                "total": 0,
                "succeeded": 0,
                "failed": 0,
                "concurrency": concurrency,
                "elapsed_ms": 0,
                "results": [],
            }

        workers = min(concurrency, len(items))
        log.info("批量查询开始：%d 条（去重后）并发 %d serviceType=%s",
                 len(items), workers, service_type)
        with ThreadPoolExecutor(
            max_workers=workers,
            thread_name_prefix="miit-query",
        ) as executor:
            futures = {
                executor.submit(self.query_one, keyword, service_type): index
                for index, keyword in enumerate(items)
            }
            for future in as_completed(futures):
                results[futures[future]] = future.result()

        completed = [result for result in results if result is not None]
        succeeded = sum(bool(result["success"]) for result in completed)
        elapsed = round((time.perf_counter() - started) * 1000)
        log.info("批量查询完成：成功 %d 失败 %d 总计 %d 耗时 %d ms",
                 succeeded, len(items) - succeeded, len(items), elapsed)
        return {
            "success": succeeded == len(items),
            "total": len(items),
            "succeeded": succeeded,
            "failed": len(items) - succeeded,
            "concurrency": concurrency,
            "elapsed_ms": elapsed,
            "results": completed,
        }

    def test_proxy(self, proxies=None, auth=None) -> dict:
        """测试代理连通性：优先用传入的（表单）代理，否则从动态API提取新代理。"""
        import re

        from curl_cffi import requests as cffi

        from proxy_pool import _coerce_proxies, as_proxies, mask_proxy

        if proxies is not None:
            proxy_list = _coerce_proxies(proxies, auth)
            proxy_url = proxy_list[0] if proxy_list else None
        else:
            # 强制从动态API提取新代理（而不是使用缓存）
            proxy_url = self.proxy_provider.rotate()

        started = time.perf_counter()
        try:
            session = cffi.Session(impersonate="chrome", proxies=as_proxies(proxy_url))
            resp = session.get("https://myip.ipip.net", timeout=12)
            elapsed = round((time.perf_counter() - started) * 1000)
            match = re.search(r"\d{1,3}(?:\.\d{1,3}){3}", resp.text or "")
            exit_ip = match.group(0) if match else None
            log.info("代理测试成功: 出口 IP=%s 代理=%s 耗时 %d ms",
                     exit_ip, mask_proxy(proxy_url), elapsed)
            return {
                "ok": True,
                "exit_ip": exit_ip,
                "proxy": mask_proxy(proxy_url),
                "elapsed_ms": elapsed,
                "detail": (resp.text or "").strip()[:120],
            }
        except Exception as exc:  # noqa: BLE001 - 结果回传前端
            elapsed = round((time.perf_counter() - started) * 1000)
            message = str(exc)
            low = message.lower()
            if any(k in low for k in ("tls", "ssl", "connect", "invalid library")):
                message += "（该代理可能不支持 HTTPS 隧道或协议不符——试试给地址加 https:// 前缀，或换支持 HTTPS 的代理）"
            log.warning("代理测试失败: 代理=%s 错误=%s", mask_proxy(proxy_url), exc)
            return {
                "ok": False,
                "proxy": mask_proxy(proxy_url),
                "elapsed_ms": elapsed,
                "error": message,
            }
