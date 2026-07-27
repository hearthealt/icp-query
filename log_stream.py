"""进程内日志广播：把 logging 记录实时推送到 Web 端（SSE）。

server/query_service/miit/captcha 各模块都用 ``logging.getLogger(__name__)``，
日志经 propagate 冒泡到 root。这里在 root 挂一个 Handler 捕获全部，写入环形缓冲
并广播给所有 SSE 订阅者，业务代码与其日志调用均不改动。

批量查询在线程池中执行，``emit`` 会被多个工作线程并发调用，故共享状态用锁保护，
订阅者用线程安全的 ``queue.Queue``。
"""
from __future__ import annotations

import json
import logging
import queue
import threading
from collections import deque

from log_config import setup_logging

# 这些第三方库的 DEBUG 过于聒噪，压到 WARNING，避免淹没业务日志
_NOISY_LOGGERS = ("curl_cffi", "urllib3", "httpx", "hpack", "asyncio", "PIL")


class LogBroadcaster(logging.Handler):
    """线程安全的日志广播 Handler：环形缓冲 + 多订阅者队列。"""

    def __init__(self, capacity: int = 800):
        super().__init__()
        self._buffer: deque[dict] = deque(maxlen=capacity)
        self._subscribers: set[queue.Queue] = set()
        self._lock = threading.Lock()
        self._seq = 0

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = record.getMessage()
        except Exception:  # 格式化失败不应波及业务
            return

        # 使用高精度时间戳 + 自增序号作为唯一标识
        with self._lock:
            self._seq += 1
            # 组合键：时间戳(微秒) + seq，确保全局唯一且有序
            unique_id = f"{int(record.created * 1000000)}-{self._seq}"
            item = {
                "id": unique_id,  # 替代 seq，更可靠
                "ts": record.created,
                "level": record.levelname,
                "logger": record.name,
                "thread": record.threadName,
                "msg": message,
            }
            self._buffer.append(item)
            dead: list[queue.Queue] = []
            for sub in self._subscribers:
                try:
                    sub.put_nowait(item)
                except queue.Full:  # 消费不及的订阅者丢弃，不阻塞日志线程
                    dead.append(sub)
            for sub in dead:
                self._subscribers.discard(sub)

    def subscribe(self) -> queue.Queue:
        sub: queue.Queue = queue.Queue(maxsize=2000)
        with self._lock:
            self._subscribers.add(sub)
        return sub

    def unsubscribe(self, sub: queue.Queue) -> None:
        with self._lock:
            self._subscribers.discard(sub)

    def snapshot(self) -> list[dict]:
        with self._lock:
            return list(self._buffer)


_broadcaster: LogBroadcaster | None = None


def install_log_stream() -> LogBroadcaster:
    """幂等安装：在 root 挂广播 handler，返回单例。

    ``setup_logging()`` 把 root 设为 INFO，DEBUG 记录默认不生成。为了让前端可选
    查看 DEBUG 明细，这里把 root 降到 DEBUG，同时把终端 StreamHandler 固定回
    INFO，保持终端清爽——业务代码不动。
    """
    global _broadcaster
    if _broadcaster is not None:
        return _broadcaster

    setup_logging()  # 幂等，确保基础配置就绪

    root = logging.getLogger()
    # 终端 handler 保持 INFO，避免被 DEBUG 淹没
    for handler in root.handlers:
        if isinstance(handler, logging.StreamHandler):
            handler.setLevel(logging.INFO)
    # root 放开到 DEBUG，DEBUG 记录才会生成并到达广播 handler
    root.setLevel(logging.DEBUG)

    broadcaster = LogBroadcaster()
    broadcaster.setLevel(logging.DEBUG)
    root.addHandler(broadcaster)

    for name in _NOISY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)

    _broadcaster = broadcaster
    return broadcaster


def sse_event(item: dict) -> str:
    """把一条日志打包成 SSE ``data:`` 帧。"""
    return f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
