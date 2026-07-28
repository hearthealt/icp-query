"""FastAPI application for the filing query web UI."""

import logging
import queue
import time
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from api_models import (
    BatchQueryRequest,
    BatchQueryResponse,
    ConfigUpdate,
    ProxyTestRequest,
    SingleQueryRequest,
    SingleQueryResponse,
    UnifiedQueryRequest,
)
from log_config import setup_logging
from log_stream import install_log_stream, sse_event
from query_service import QueryService


setup_logging()
broadcaster = install_log_stream()
log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

schema_route_option = "open" + "api_url"
app = FastAPI(
    title="备案查询工具",
    version="1.0.0",
    description="工信部 ICP 备案信息在线查询工具。",
    docs_url=None,
    redoc_url=None,
    **{schema_route_option: None},
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# 访问日志采用白名单：只有业务查询接口按 INFO 记录，页面、静态资源、健康检查、
# SSE、配置读写等 UI 支撑请求一律压到 DEBUG——终端不打印，前端日志面板需勾选
# “详细 (DEBUG)”才可见。任何路径出错（>=400）仍会以 WARNING 暴露。
LOUD_PREFIXES = ("/api/v1/query",)


def _is_loud(path: str) -> bool:
    return path.startswith(LOUD_PREFIXES)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """记录每个 HTTP 请求的方法、路径、状态码与耗时。"""
    path = request.url.path
    level = logging.INFO if _is_loud(path) else logging.DEBUG
    client = request.client.host if request.client else "-"
    started = time.perf_counter()
    log.log(level, "--> %s %s 来自 %s", request.method, path, client)
    try:
        response = await call_next(request)
    except Exception:
        elapsed = round((time.perf_counter() - started) * 1000)
        log.exception("<-- %s %s 处理异常 耗时 %d ms",
                      request.method, path, elapsed)
        raise
    elapsed = round((time.perf_counter() - started) * 1000)
    if response.status_code >= 400:  # 静态资源 404、接口报错之类仍需暴露
        level = logging.WARNING
    log.log(level, "<-- %s %s %d 耗时 %d ms",
            request.method, path, response.status_code, elapsed)
    return response


query_service = QueryService()
api = APIRouter(prefix="/api/v1")


@api.post(
    "/query",
    response_model=SingleQueryResponse | BatchQueryResponse,
    responses={502: {"description": "工信部上游服务查询失败"}},
    summary="统一查询接口（单条或批量）",
    description="根据参数自动识别：提供 keyword 为单条查询，提供 keywords 为批量查询",
)
def query_unified(req: UnifiedQueryRequest):
    """根据参数自动识别单条或批量查询。"""
    if req.is_batch:
        # 批量查询
        log.info("收到批量查询请求: %d 条 serviceType=%s concurrency=%s",
                 len(req.keywords), req.service_type, req.concurrency)
        return query_service.query_batch(
            req.keywords,
            service_type=req.service_type,
            concurrency=req.concurrency,
        )
    else:
        # 单条查询
        log.info("收到单条查询请求: keyword=%r serviceType=%s",
                 req.keyword, req.service_type)
        result = query_service.query_one(req.keyword, req.service_type)
        status_code = 200 if result["success"] else 502
        log.info("单条查询响应: keyword=%r success=%s status=%d",
                 req.keyword, result["success"], status_code)
        return JSONResponse(
            status_code=status_code,
            content={"success": result["success"], "data": result},
        )


@api.post(
    "/query/single",
    response_model=SingleQueryResponse,
    responses={502: {"description": "工信部上游服务查询失败"}},
    summary="单条查询",
)
def query_one(req: SingleQueryRequest):
    log.info("收到单条查询请求: keyword=%r serviceType=%s",
             req.keyword, req.service_type)
    result = query_service.query_one(req.keyword, req.service_type)
    status_code = 200 if result["success"] else 502
    log.info("单条查询响应: keyword=%r success=%s status=%d",
             req.keyword, result["success"], status_code)
    return JSONResponse(
        status_code=status_code,
        content={"success": result["success"], "data": result},
    )


@api.post(
    "/query/batch",
    response_model=BatchQueryResponse,
    summary="批量查询",
)
def query_batch(req: BatchQueryRequest):
    log.info("收到批量查询请求: %d 条 serviceType=%s concurrency=%s",
             len(req.keywords), req.service_type, req.concurrency)
    return query_service.query_batch(
        req.keywords,
        service_type=req.service_type,
        concurrency=req.concurrency,
    )


@api.get("/logs/stream", include_in_schema=False)
def logs_stream():
    """SSE 端点：先补发最近日志快照，再实时推送新日志。"""
    subscription = broadcaster.subscribe()

    def event_source():
        try:
            for item in broadcaster.snapshot():
                yield sse_event(item)
            while True:
                try:
                    item = subscription.get(timeout=15)
                except queue.Empty:
                    yield ": keep-alive\n\n"  # 心跳，避免连接被中间层断开
                    continue
                yield sse_event(item)
        finally:
            broadcaster.unsubscribe(subscription)

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@api.get("/config", include_in_schema=False)
def get_config():
    return query_service.config.to_public(query_service.proxy_provider)


@api.post("/config", include_in_schema=False)
def update_config(payload: ConfigUpdate):
    query_service.config.update(payload.model_dump(exclude_unset=True))
    log.info("运行时代理/节流配置经接口更新")
    return query_service.config.to_public(query_service.proxy_provider)


@api.post("/config/test", include_in_schema=False)
def test_proxy(payload: ProxyTestRequest):
    return query_service.test_proxy(payload.proxies, payload.auth)


app.include_router(api)


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse(STATIC_DIR / "favicon.svg", media_type="image/svg+xml")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=16180)
