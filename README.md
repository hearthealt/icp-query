# 备案查询工具

[![Docker Build](https://github.com/hearthealt/icp-query/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/hearthealt/icp-query/actions/workflows/docker-publish.yml)
[![Docker Image](https://ghcr-badge.egpl.dev/hearthealt/icp-query/latest_tag?trim=major&label=latest)](https://github.com/hearthealt/icp-query/pkgs/container/icp-query)

查询工信部 ICP 备案信息，支持网站、APP、小程序和快应用。项目包含响应式 Web
界面和命令行工具，批量任务支持设置并发数。

## 环境要求

- **Python**: 3.10 或更高版本
- **支持**: uv、pip、conda、Docker 四种部署方式

## 快速开始

### 🐳 方式一：Docker（推荐，一键部署）

```bash
# 使用 GitHub Container Registry 镜像（推荐）
docker run -d -p 16180:16180 --name beian-query ghcr.io/hearthealt/icp-query:latest

# 或使用 docker-compose
docker-compose up -d

# 或自行构建
docker build -t beian-query .
docker run -d -p 16180:16180 --name beian-query beian-query

# 访问
open http://127.0.0.1:16180
```

**配置代理（可选）:**
```bash
# 复制配置模板
cp .env.example .env

# 编辑 .env 填写代理配置
vim .env

# 重启服务生效
docker-compose down && docker-compose up -d
```

### 🚀 方式二：uv（本地开发）

```bash
# 安装 uv（如果还没有）
curl -LsSf https://astral.sh/uv/install.sh | sh  # macOS/Linux
# 或
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"  # Windows

# 同步依赖并运行
uv sync
uv run uvicorn server:app --host 0.0.0.0 --port 16180
```

### 📦 方式三：pip

```bash
pip install -r requirements.txt
python -m uvicorn server:app --host 0.0.0.0 --port 16180
```

### 🐍 方式四：conda

```bash
conda env create -f environment.yml
conda activate beian-query
python -m uvicorn server:app --host 0.0.0.0 --port 16180
```

## 启动

打开 `http://127.0.0.1:16180` 使用在线查询。

## Web 功能

- 单条查询：输入域名、应用名或主办单位名称即可查询备案状态。
- 批量查询：每行一个查询词，自动去重，最多 100 条。
- 并发控制：批量查询并发范围为 1–10，默认 2。
- 结果汇总：展示备案状态、域名、主办单位、单位性质、备案号、审核时间和耗时。

服务类型为：`1` 网站、`6` APP、`7` 小程序、`8` 快应用。

## 反爬与代理限流

工信部按 IP 风控，短时间查询过多会对验证码接口返回 `403` 拦截页。程序内置全局
节流、遇限流自动换代理退避重试，并支持配置代理（固定列表或动态提取 API）。以下
环境变量均可选，不配置即直连（仍有节流与退避）。

| 变量 | 作用 | 默认 |
|------|------|------|
| `MIIT_PROXIES` | 固定代理列表，逗号/换行分隔（`ip:port` 或 `http://user:pass@ip:port`） | 空 |
| `MIIT_PROXY_API_URL` | 动态提取 API，GET 其返回内容中提取 `ip:port` | 空 |
| `MIIT_PROXY_AUTH` | 给无认证代理统一附加 `user:pass` | 空 |
| `MIIT_PROXY_API_TTL` | 动态提取结果缓存秒数 | 10 |
| `MIIT_MIN_INTERVAL` | 上游请求最小间隔（秒），全局限速 | 0.8 |
| `MIIT_MAX_RETRIES` | 限流/代理失败时换代理重试次数 | 3 |
| `MIIT_BLACKLIST_THRESHOLD` | 代理连续失败多少次加入黑名单 | 3 |
| `MIIT_BLACKLIST_DURATION` | 黑名单有效期（秒） | 300 |

示例（固定代理列表）：

```bash
MIIT_PROXIES="http://user:pass@1.2.3.4:8000,http://5.6.7.8:8000" \
  uv run uvicorn server:app --host 0.0.0.0 --port 16180
```

也可在网页「设置」页直接配置（固定代理 / 动态 API / 认证 / 节流 / 重试 / 黑名单），**保存即时
生效并写入 `runtime_config.json`（重启保留，优先级高于环境变量）**。该文件含代理凭据、
不入库，且配置接口 `POST /api/v1/config` 无鉴权——请仅在本机使用，勿将服务对公网
（`0.0.0.0`）暴露。

**Docker 用户配置代理:**
```bash
# 编辑 .env 文件
cp .env.example .env
vim .env  # 填写代理配置

# 重启容器生效
docker-compose restart
```

## 命令行

```bash
uv run main.py baidu.com
uv run main.py a.com b.com c.com -c 5
uv run main.py -f domains.txt -c 3
uv run main.py -f domains.txt -o result.csv
uv run main.py -t 6 com.example.app
```

**Docker 中使用命令行:**
```bash
docker exec -it beian-query python main.py baidu.com
```

## 项目结构

```text
server.py          FastAPI 应用与页面查询路由
api_models.py      请求模型、校验规则和限制
query_service.py   单条查询与批量并发调度
miit.py            工信部查询客户端
captcha.py         滑块验证码识别
proxy_pool.py      代理轮换与全局请求节流
log_config.py      统一日志配置
log_stream.py      运行日志广播（SSE 推送到 Web 端）
main.py            命令行入口
static/            Web 页面、样式、交互脚本和站点图标
```

每个并发工作线程拥有独立的 `MiitClient` 和 HTTP 会话，线程内复用 token。这样既
能并行执行，又不会让验证码、session 或 token 状态互相覆盖。
