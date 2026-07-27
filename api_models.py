"""Request models and shared limits for filing queries."""

from typing import Literal

from pydantic import BaseModel, Field, field_validator


ServiceType = Literal[1, 6, 7, 8]

DEFAULT_CONCURRENCY = 2
MAX_CONCURRENCY = 10
MAX_BATCH_SIZE = 100
MAX_KEYWORD_LENGTH = 200


class SingleQueryRequest(BaseModel):
    """Request body for a single filing query."""

    keyword: str = Field(
        min_length=1,
        max_length=MAX_KEYWORD_LENGTH,
        description="域名、APP 名称、小程序名称或主办单位名称",
        examples=["baidu.com"],
    )
    service_type: ServiceType = Field(
        default=1,
        description="服务类型：1 网站、6 APP、7 小程序、8 快应用",
    )

    @field_validator("keyword")
    @classmethod
    def normalize_keyword(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("keyword 不能为空")
        return value


class BatchQueryRequest(BaseModel):
    """Request body for a concurrent batch filing query."""

    keywords: list[str] = Field(
        min_length=1,
        max_length=MAX_BATCH_SIZE,
        description=f"查询词列表，自动去重，最多 {MAX_BATCH_SIZE} 条",
        examples=[["baidu.com", "qq.com"]],
    )
    service_type: ServiceType = Field(
        default=1,
        description="服务类型：1 网站、6 APP、7 小程序、8 快应用",
    )
    concurrency: int = Field(
        default=DEFAULT_CONCURRENCY,
        ge=1,
        le=MAX_CONCURRENCY,
        description=f"并发查询数，范围 1–{MAX_CONCURRENCY}",
    )

    @field_validator("keywords")
    @classmethod
    def normalize_keywords(cls, values: list[str]) -> list[str]:
        normalized: list[str] = []
        for value in values:
            value = (value or "").strip()
            if not value:
                raise ValueError("keywords 不能包含空字符串")
            if len(value) > MAX_KEYWORD_LENGTH:
                raise ValueError(
                    f"单个查询词不能超过 {MAX_KEYWORD_LENGTH} 个字符"
                )
            normalized.append(value)
        return normalized


class FilingRecord(BaseModel):
    """Normalized filing record returned by the upstream service."""

    domain: str | None = None
    unitName: str | None = None
    nature: str | None = None
    mainLicence: str | None = None
    serviceLicence: str | None = None
    updateTime: str | None = None


class QueryResult(BaseModel):
    success: bool
    keyword: str
    found: bool
    count: int = 0
    records: list[FilingRecord]
    error: str | None = None
    elapsed_ms: int


class SingleQueryResponse(BaseModel):
    success: bool
    data: QueryResult


class BatchQueryResponse(BaseModel):
    success: bool
    total: int
    succeeded: int
    failed: int
    concurrency: int
    elapsed_ms: int
    results: list[QueryResult]


class ConfigUpdate(BaseModel):
    """运行时代理/节流配置更新（字段均可选，仅更新提供的项）。"""

    proxies: list[str] | str | None = None
    api_url: str | None = None
    auth: str | None = None
    api_ttl: float | None = Field(default=None, ge=0)
    min_interval: float | None = Field(default=None, ge=0)
    max_retries: int | None = Field(default=None, ge=1, le=10)


class ProxyTestRequest(BaseModel):
    """测试代理连通性：测表单当前填写的值；proxies 省略则测全局，空字符串测直连。"""

    proxies: list[str] | str | None = None
    auth: str | None = None
