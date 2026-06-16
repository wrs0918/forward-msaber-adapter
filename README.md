# Forward MSaber Adapter

Author: 工位划水冠军

This service lets Forward's MoviePilot-style server subscription feature talk to MSaber through a small adapter.

The adapter has two jobs:

1. Accept MoviePilot-like requests from Forward and normalize the media payload.
2. Forward the normalized payload to MSaber, or run in dry-run mode and log requests while you confirm the real MSaber subscription endpoint.

## Why An Adapter

Forward currently documents server subscription integration for MoviePilot. MSaber has API key based access, but the public docs do not clearly document a stable "create subscription" endpoint. This adapter bridges that gap and logs the exact requests Forward sends.

## Quick Start On NAS

```bash
git clone git@github.com:wrs0918/forward-msaber-adapter.git
cd forward-msaber-adapter
docker compose up -d --build
```

Default URL:

```text
http://NAS_IP:8088
```

Health check:

```bash
curl http://NAS_IP:8088/health
```

## First Run: Dry Run Mode

Keep this in `docker-compose.yml`:

```yaml
DRY_RUN: "true"
```

Then put the adapter URL into Forward's server subscription settings, using the adapter as the MoviePilot server URL.

Recommended first URL:

```text
http://NAS_IP:8088
```

After testing add/cancel subscription in Forward, inspect:

```text
msaber-adapter/data/requests.jsonl
msaber-adapter/data/mappings.json
```

These files show which endpoints Forward called and which payload fields it sent.

## Find The MSaber Subscription Endpoint

MSaber's public docs describe API key authentication, but the exact create/delete subscription endpoints may vary by version. Use this process once:

1. Open MSaber Web UI in a browser.
2. Open DevTools Network.
3. Manually add a movie subscription and a TV subscription.
4. Find the request that creates the subscription.
5. Copy the request path and JSON body shape.
6. Put the path into `MSABER_SUBSCRIBE_PATH`.
7. Repeat with deleting/canceling a subscription and put that path into `MSABER_DELETE_PATH`.

The adapter forwards a normalized payload first:

```json
{
  "title": "Example",
  "year": "2026",
  "type": "tv",
  "tmdbid": "123",
  "imdbid": "",
  "season": "1",
  "episode": "",
  "poster": ""
}
```

If your MSaber endpoint needs a different body shape, adjust `toMsaberPayload()` in `server.js`.

## Connect To MSaber

After you confirm MSaber's real subscription endpoint from browser DevTools, set:

```yaml
DRY_RUN: "false"
MSABER_BASE_URL: "http://YOUR_MSABER_HOST:PORT"
MSABER_API_KEY: "your-api-key"
MSABER_API_KEY_HEADER: "apiKey"
MSABER_SUBSCRIBE_PATH: "/api/..."
MSABER_DELETE_PATH: "/api/..."
```

Then restart:

```bash
docker compose up -d --build
```

## Optional Security

If this adapter is exposed outside your LAN, set:

```yaml
ADAPTER_TOKEN: "a-long-random-token"
```

Forward must then send one of these headers:

```text
Authorization: Bearer a-long-random-token
x-adapter-token: a-long-random-token
```

If Forward cannot set custom headers, keep the adapter inside your LAN or behind a reverse proxy that adds the token.

## Environment Variables

| Name | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Container listen port. |
| `DATA_DIR` | `/data` | Request log and mapping storage. |
| `DRY_RUN` | `true` | Log requests without calling MSaber. |
| `ADAPTER_TOKEN` | empty | Optional inbound token for the adapter. |
| `MSABER_BASE_URL` | empty | Base URL of your MSaber instance. |
| `MSABER_API_KEY` | empty | MSaber API key. |
| `MSABER_API_KEY_HEADER` | `apiKey` | Header used to send the API key. |
| `MSABER_SUBSCRIBE_PATH` | empty | MSaber create subscription endpoint path. |
| `MSABER_DELETE_PATH` | empty | MSaber delete/cancel subscription endpoint path. |

## Supported Payload Fields

The adapter tries to normalize common MoviePilot/Forward fields:

```text
title, name, year, type, media_type, tmdbid, tmdb_id, imdbid, imdb_id,
season, season_number, episode, episode_number, poster, cover
```

Unknown requests are still logged and return a success JSON response so you can inspect and add compatibility without breaking Forward immediately.

## Local Development

```bash
node --check server.js
PORT=8099 DATA_DIR=/tmp/forward-msaber-adapter DRY_RUN=true node server.js
curl http://127.0.0.1:8099/health
curl -X POST http://127.0.0.1:8099/api/v1/subscribe \
  -H 'Content-Type: application/json' \
  -d '{"title":"权力的游戏","type":"tv","tmdb_id":"1399","season":1,"year":"2011"}'
```

## Docker Build Test

```bash
docker build -t forward-msaber-adapter:test .
docker run --rm -p 8099:8080 -e DRY_RUN=true forward-msaber-adapter:test
```
