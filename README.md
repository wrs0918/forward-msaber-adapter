# Forward MSaber Adapter

作者：工位划水冠军

`forward-msaber-adapter` 是一个给 Forward 用的 MSaber 服务器订阅适配器。它把 Forward 里“服务器订阅”功能发出来的 MoviePilot 风格请求，转换成 MSaber 可以接收的订阅请求。

## 解决什么问题

Forward 官方的服务器订阅功能主要按 MoviePilot 的接口设计。如果你用的是 MSaber，就会遇到这些问题：

- Forward 能发起“订阅到服务器”的动作，但 MSaber 不是 MoviePilot 接口，不能直接无缝接上。
- MSaber 有 API Key 机制，但不同版本、部署方式里的“新增订阅 / 取消订阅”接口路径可能不完全一样。
- Forward 实际传了哪些字段不容易确认，调试时需要一个中间层记录请求。
- NAS Docker 部署时，希望只暴露一个简单服务给 Forward，不想改 Forward 本体。

这个适配器做的事就是：

- 接收 Forward 发来的服务器订阅请求。
- 兼容常见 MoviePilot / Forward 字段，比如 `title`、`tmdb_id`、`season`、`type`、`year`。
- 默认以 `DRY_RUN=true` 运行，只记录请求不真正调用 MSaber，方便先摸清 Forward 和 MSaber 的请求格式。
- 配好 MSaber 地址、API Key 和订阅接口后，把请求转发给 MSaber。
- 保存请求日志和订阅映射，方便排查问题。

## 适合谁用

- 你在用 Forward 看影片详情，希望点“服务器订阅”时把任务发到 MSaber。
- 你的 MSaber 跑在 NAS、Docker、群晖、绿联、飞牛、Unraid 或其他本地服务器上。
- 你不想改 Forward 或 MSaber 源码，只想加一个轻量中转服务。

## 快速开始

推荐先用 dry-run 模式跑起来，确认 Forward 会发什么请求，再接入真实 MSaber 接口。

```bash
git clone git@github.com:wrs0918/forward-msaber-adapter.git
cd forward-msaber-adapter
docker compose up -d --build
```

默认访问地址：

```text
http://NAS_IP:8088
```

健康检查：

```bash
curl http://NAS_IP:8088/health
```

返回里看到 `success: true` 就说明服务已启动。

## DockerHub 镜像

如果 DockerHub 镜像已经发布，可以不用 clone 仓库，直接在 NAS 上写 compose：

```yaml
services:
  forward-msaber-adapter:
    image: wrs0918/forward-msaber-adapter:latest
    container_name: forward-msaber-adapter
    restart: unless-stopped
    ports:
      - "8088:8080"
    environment:
      PORT: "8080"
      DATA_DIR: "/data"
      DRY_RUN: "true"
      ADAPTER_TOKEN: ""
      MSABER_BASE_URL: "http://你的-msaber-ip:端口"
      MSABER_API_KEY: "替换成你的-msaber-api-key"
      MSABER_API_KEY_HEADER: "apiKey"
      MSABER_SUBSCRIBE_PATH: ""
      MSABER_DELETE_PATH: ""
    volumes:
      - ./data:/data
```

启动：

```bash
docker compose up -d
```

镜像地址：

```text
docker.io/wrs0918/forward-msaber-adapter:latest
```

## 在 Forward 里怎么填

在 Forward 的服务器订阅设置里，把这个适配器当成 MoviePilot 服务器地址填进去。

推荐先填：

```text
http://NAS_IP:8088
```

如果你设置了 `ADAPTER_TOKEN`，需要确保 Forward 或你的反代能带上下面任意一种请求头：

```text
Authorization: Bearer 你的-token
x-adapter-token: 你的-token
```

如果 Forward 当前界面不能加自定义请求头，建议只在内网使用，或者通过反向代理给请求补 header。

## 第一次使用建议

第一次请保持：

```yaml
DRY_RUN: "true"
```

然后在 Forward 里尝试订阅一部电影和一部剧集。适配器会把请求记录到：

```text
./data/requests.jsonl
./data/mappings.json
```

`requests.jsonl` 能看到 Forward 访问了什么路径、传了什么 body。确认字段没问题后，再去配置真实 MSaber 转发。

## 配置真实 MSaber 转发

MSaber 的公开文档没有稳定说明所有版本的“新增订阅 / 删除订阅”接口路径，所以建议先用浏览器抓一次你自己 MSaber 的真实接口。

步骤：

1. 打开 MSaber Web UI。
2. 打开浏览器开发者工具的 Network 面板。
3. 在 MSaber 页面手动新增一个电影订阅。
4. 找到新增订阅对应的请求路径和 JSON body。
5. 把请求路径填到 `MSABER_SUBSCRIBE_PATH`。
6. 再手动取消一个订阅，找到删除路径，填到 `MSABER_DELETE_PATH`。
7. 把 `DRY_RUN` 改成 `false`，重启服务。

示例配置：

```yaml
environment:
  DRY_RUN: "false"
  MSABER_BASE_URL: "http://192.168.1.20:3000"
  MSABER_API_KEY: "你的-msaber-api-key"
  MSABER_API_KEY_HEADER: "apiKey"
  MSABER_SUBSCRIBE_PATH: "/api/你的新增订阅路径"
  MSABER_DELETE_PATH: "/api/你的删除订阅路径"
```

重启：

```bash
docker compose up -d
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 容器内部监听端口。 |
| `DATA_DIR` | `/data` | 请求日志和映射文件保存目录。 |
| `DRY_RUN` | `true` | 只记录请求，不调用 MSaber。第一次使用建议保持 `true`。 |
| `ADAPTER_TOKEN` | 空 | 可选的适配器访问 token。 |
| `MSABER_BASE_URL` | 空 | MSaber 服务地址，比如 `http://192.168.1.20:3000`。 |
| `MSABER_API_KEY` | 空 | MSaber API Key。 |
| `MSABER_API_KEY_HEADER` | `apiKey` | 发送 API Key 使用的请求头名。 |
| `MSABER_SUBSCRIBE_PATH` | 空 | MSaber 新增订阅接口路径。 |
| `MSABER_DELETE_PATH` | 空 | MSaber 删除或取消订阅接口路径。 |

## 已兼容的字段

适配器会尽量从 Forward / MoviePilot 风格 payload 里提取这些字段：

```text
title, name, cn_name, original_title,
year, release_year,
type, media_type, mediaType, category,
tmdbid, tmdb_id, tmdbId, tmdb,
imdbid, imdb_id, imdbId, imdb,
season, season_number, seasonNumber,
episode, episode_number, episodeNumber,
poster, poster_path, backdrop, cover, image
```

最终会转换成发给 MSaber 的通用结构：

```json
{
  "title": "权力的游戏",
  "year": "2011",
  "type": "tv",
  "tmdbid": "1399",
  "imdbid": "",
  "season": "1",
  "episode": "",
  "poster": ""
}
```

如果你的 MSaber 接口需要不同字段名，可以改 `server.js` 里的 `toMsaberPayload()`。

## 本地开发

```bash
npm install
node --check server.js
PORT=8099 DATA_DIR=/tmp/forward-msaber-adapter DRY_RUN=true node server.js
```

测试：

```bash
curl http://127.0.0.1:8099/health
curl -X POST http://127.0.0.1:8099/api/v1/subscribe \
  -H 'Content-Type: application/json' \
  -d '{"title":"权力的游戏","type":"tv","tmdb_id":"1399","season":1,"year":"2011"}'
```

## 构建和推送 Docker 镜像

本地构建：

```bash
docker build -t forward-msaber-adapter:test .
```

发布到 DockerHub：

```bash
docker login
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t wrs0918/forward-msaber-adapter:latest \
  -t wrs0918/forward-msaber-adapter:0.1.0 \
  --push .
```

如果只想推当前 Mac 架构的普通镜像：

```bash
docker build -t wrs0918/forward-msaber-adapter:latest .
docker push wrs0918/forward-msaber-adapter:latest
```

NAS 一般建议使用上面的多架构 `buildx` 发布方式，这样 x86 NAS 和 ARM NAS 都能拉。

## 常见问题

### 为什么默认不开启真实转发？

因为不同 MSaber 版本的订阅接口可能不一样。默认 `DRY_RUN=true` 能先安全记录 Forward 请求，避免一上来就把错误请求打到 MSaber。

### Forward 订阅后没有进入 MSaber 怎么办？

先检查：

- `docker logs forward-msaber-adapter`
- `./data/requests.jsonl`
- `MSABER_BASE_URL` 是否能从容器访问
- `MSABER_API_KEY_HEADER` 是否和你的 MSaber 要求一致
- `MSABER_SUBSCRIBE_PATH` 是否是你抓包得到的真实路径

### 可以公网暴露吗？

不建议直接裸露公网。如果必须公网访问，请至少配置 `ADAPTER_TOKEN`，并放在 HTTPS 反向代理后面。
