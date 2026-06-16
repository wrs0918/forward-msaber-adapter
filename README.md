# Forward MSaber Adapter

作者：工位划水冠军

`forward-msaber-adapter` 是一个给 Forward 使用的 MSaber 服务器订阅适配器。它模拟 MoviePilot 的订阅接口，接收 Forward 的服务器订阅请求，并转发到 MSaber 的 API Key 接口。

## 解决什么问题

Forward 的“服务器订阅”按 MoviePilot 接口调用，不能直接对接 MSaber。本服务作为中间层，解决这些问题：

- Forward 可以继续填写一个 MoviePilot 风格的服务器地址。
- MSaber 只需要配置 API Key，不需要账号密码登录。
- Forward 发来的订阅请求会转换成 MSaber `/api/v1/subscribe/save` 所需结构。
- 重复点击 Forward 的订阅按钮时，适配器会按 MSaber 的订阅、下载中、已下载记录做幂等拦截，避免重复创建任务。
- Forward 的联通测试 `tmdbid=-1` 会直接返回成功，不会转发给 MSaber。

## 使用边界

- Forward 当前订阅按钮不会稳定变成“已订阅”，也没有可靠的取消订阅按钮；重复点击仍可能继续发创建请求。
- 本适配器会在服务端防重复：只要 MSaber 订阅列表、下载中任务或已下载历史中已经存在同一 `tmdbId + season`，就不会再次转发创建请求。
- 已下载历史只用于“已存在”判断，不会自动删除历史记录或媒体文件。
- 下载中任务如果 Forward 发起 MoviePilot 风格删除请求，适配器会尝试调用 MSaber 下载删除接口；普通 Forward 订阅按钮通常不会触发这个流程。
- 本服务不处理资源搜索、下载器代理、站点代理、媒体库整理，只负责 Forward 到 MSaber 的服务器订阅桥接。

## Docker Compose

```yaml
services:
  forward-msaber-adapter:
    image: dawds/forward-msaber-adapter:latest
    container_name: forward-msaber-adapter
    restart: unless-stopped
    ports:
      - "8088:8080"
    environment:
      PORT: "8080"
      DATA_DIR: "/data"
      DRY_RUN: "false"
      ADAPTER_TOKEN: ""
      MSABER_BASE_URL: "http://你的-msaber-ip:端口"
      MSABER_API_KEY: "替换成你的-msaber-api-key"
      MSABER_API_KEY_HEADER: "apiKey"
      MSABER_SUBSCRIBE_PATH: "/api/v1/subscribe/save"
      MSABER_DELETE_PATH: "/api/v1/subscribe/delete"
      MSABER_LIST_PATH: "/api/v1/subscribe/page?pageNum=1&pageSize=200"
      MSABER_DOWNLOADING_PATH: "/api/v1/download/downloading"
      MSABER_DOWNLOAD_HISTORY_PATH: "/api/v1/download/history?pageNum=1&pageSize=200"
      MSABER_DOWNLOAD_DELETE_PATH: "/api/v1/download/delete"
      MSABER_REQUEST_TIMEOUT_MS: "10000"
    volumes:
      - ./data:/data
```

启动：

```bash
docker compose up -d
```

健康检查：

```bash
curl http://NAS_IP:8088/health
```

## Forward 里怎么填

在 Forward 的服务器订阅设置里，把服务器地址填成：

```text
http://NAS_IP:8088
```

如果 Forward 要求填写账号密码，可以填任意非空值，例如：

```text
用户名：msaber
密码：msaber
```

账号密码不会用于登录 MSaber。MSaber 只通过 `MSABER_API_KEY` 调用。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 容器内部监听端口。 |
| `DATA_DIR` | `/data` | 请求日志目录。 |
| `DRY_RUN` | `true` | 为 `true` 时只记录请求，不调用 MSaber；正式使用请设为 `false`。 |
| `ADAPTER_TOKEN` | 空 | 可选访问 token；内网使用可留空。 |
| `MSABER_BASE_URL` | 空 | MSaber 服务地址，例如 `http://192.168.1.20:3001`。 |
| `MSABER_API_KEY` | 空 | MSaber API Key。 |
| `MSABER_API_KEY_HEADER` | `apiKey` | API Key 请求头名。 |
| `MSABER_SUBSCRIBE_PATH` | `/api/v1/subscribe/save` | MSaber 新增订阅接口。 |
| `MSABER_DELETE_PATH` | `/api/v1/subscribe/delete` | MSaber 删除订阅接口前缀。 |
| `MSABER_LIST_PATH` | `/api/v1/subscribe/page?pageNum=1&pageSize=200` | MSaber 订阅列表接口。 |
| `MSABER_DOWNLOADING_PATH` | `/api/v1/download/downloading` | MSaber 下载中任务接口。 |
| `MSABER_DOWNLOAD_HISTORY_PATH` | `/api/v1/download/history?pageNum=1&pageSize=200` | MSaber 已下载历史接口。 |
| `MSABER_DOWNLOAD_DELETE_PATH` | `/api/v1/download/delete` | MSaber 下载任务删除接口前缀。 |
| `MSABER_REQUEST_TIMEOUT_MS` | `10000` | 调用 MSaber 超时时间，单位毫秒。 |

## 状态与防重复

Forward 会访问这些 MoviePilot 风格接口：

```text
GET  /api/v1/subscribe/user/
GET  /api/v1/subscribe/media/tmdb:{tmdbId}?season={season}
POST /api/v1/subscribe/
```

适配器会把 MSaber 的以下状态转换成 MoviePilot 风格对象返回给 Forward：

- MSaber 订阅列表：视为已订阅。
- MSaber 下载中任务：视为已存在。
- MSaber 已下载历史：视为已存在。

当 Forward 发起 `POST /api/v1/subscribe/` 时，适配器会先查 MSaber 状态。如果已经存在同一媒体，会返回 `Subscription already exists`，不会调用 MSaber 创建接口。

## 安全建议

- 建议只在内网使用，不要直接暴露公网。
- 如果必须公网访问，请配置 `ADAPTER_TOKEN`，并放在 HTTPS 反向代理后面。
- 不要把真实 `.env`、API Key、请求日志提交到公开仓库。

## 本地开发

```bash
npm install
node --check server.js
PORT=8099 DATA_DIR=/tmp/forward-msaber-adapter DRY_RUN=true node server.js
```

## 镜像

```text
docker.io/dawds/forward-msaber-adapter:latest
```

多架构发布命令：

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t dawds/forward-msaber-adapter:latest \
  --push .
```
