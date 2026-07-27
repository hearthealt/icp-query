"""统一日志配置。

Web 服务（server.py）和命令行（main.py）都在启动时调用 ``setup_logging()``，
各模块内用 ``logging.getLogger(__name__)`` 取 logger，即可输出带时间、线程名、
模块名的详细日志。日志级别可用环境变量 ``LOG_LEVEL`` 覆盖（默认 INFO）。
"""

from __future__ import annotations

import logging
import os
import sys

_CONFIGURED = False

LOG_FORMAT = "%(asctime)s %(levelname)-5s [%(threadName)s] %(name)s: %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


def setup_logging(level: str | int | None = None) -> None:
    """配置根 logger，重复调用只生效一次。"""
    global _CONFIGURED
    if _CONFIGURED:
        return

    if level is None:
        level = os.environ.get("LOG_LEVEL", "INFO")
    if isinstance(level, str):
        level = logging.getLevelName(level.upper())

    # Windows 控制台默认 GBK，中文日志会乱码；尽量把标准流切到 UTF-8。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError, OSError):
            pass

    logging.basicConfig(level=level, format=LOG_FORMAT, datefmt=DATE_FORMAT)
    _CONFIGURED = True
