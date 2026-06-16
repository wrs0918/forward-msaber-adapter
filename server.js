import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const config = {
  port: Number(process.env.PORT || 8080),
  dataDir: process.env.DATA_DIR || "/data",
  adapterToken: process.env.ADAPTER_TOKEN || "",
  msaberBaseUrl: trimSlash(process.env.MSABER_BASE_URL || ""),
  msaberApiKey: process.env.MSABER_API_KEY || "",
  msaberApiKeyHeader: process.env.MSABER_API_KEY_HEADER || "apiKey",
  msaberSubscribePath: process.env.MSABER_SUBSCRIBE_PATH || "",
  msaberDeletePath: process.env.MSABER_DELETE_PATH || "",
  dryRun: parseBoolean(process.env.DRY_RUN, true)
};

const logFile = path.join(config.dataDir, "requests.jsonl");
const mappingFile = path.join(config.dataDir, "mappings.json");

ensureDataDir();

const server = http.createServer(async (request, response) => {
  try {
    const parsedUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const body = await readRequestBody(request);
    const jsonBody = parseMaybeJson(body);
    const requestInfo = {
      time: new Date().toISOString(),
      method: request.method,
      path: parsedUrl.pathname,
      query: Object.fromEntries(parsedUrl.searchParams.entries()),
      headers: redactHeaders(request.headers),
      body: jsonBody ?? body
    };
    appendLog(requestInfo);

    if (!isAuthorized(request)) {
      return sendJson(response, 401, { success: false, message: "Unauthorized" });
    }

    if (request.method === "GET" && ["/", "/health", "/api/v1/system/status"].includes(parsedUrl.pathname)) {
      return sendJson(response, 200, {
        success: true,
        status: "ok",
        service: "forward-msaber-adapter",
        dryRun: config.dryRun,
        msaberConfigured: Boolean(config.msaberBaseUrl && config.msaberApiKey)
      });
    }

    if (isSubscribePath(parsedUrl.pathname, request.method)) {
      return handleSubscribe(requestInfo, response);
    }

    if (isDeletePath(parsedUrl.pathname, request.method)) {
      return handleDelete(requestInfo, response);
    }

    return sendJson(response, 200, {
      success: true,
      message: "Request logged. Add a route mapping if Forward expects a stronger MoviePilot-compatible response.",
      path: parsedUrl.pathname,
      method: request.method
    });
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, { success: false, message: error.message || String(error) });
  }
});

server.listen(config.port, () => {
  console.log(`forward-msaber-adapter listening on ${config.port}`);
});

function trimSlash(value) {
  return String(value || "").replace(/\/+$/g, "");
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(mappingFile)) fs.writeFileSync(mappingFile, "{}\n");
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function parseMaybeJson(body) {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function redactHeaders(headers) {
  const redacted = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = /authorization|token|apikey|api-key|cookie/i.test(key) ? "***" : value;
  }
  return redacted;
}

function appendLog(entry) {
  fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}

function isAuthorized(request) {
  if (!config.adapterToken) return true;
  const auth = request.headers.authorization || "";
  const token = request.headers["x-adapter-token"] || "";
  return auth === `Bearer ${config.adapterToken}` || token === config.adapterToken;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function isSubscribePath(pathname, method) {
  if (!["POST", "PUT"].includes(method || "")) return false;
  return /subscribe|subscription|download|task|media/i.test(pathname);
}

function isDeletePath(pathname, method) {
  if (!["DELETE", "POST"].includes(method || "")) return false;
  return /unsubscribe|delete|remove|cancel/i.test(pathname);
}

async function handleSubscribe(requestInfo, response) {
  const normalized = normalizeForwardPayload(requestInfo.body, requestInfo.query);
  const adapterId = buildMappingKey(normalized);
  const msaberResult = await forwardToMsaber("subscribe", normalized);

  saveMapping(adapterId, {
    adapterId,
    createdAt: new Date().toISOString(),
    forward: normalized,
    msaber: msaberResult
  });

  return sendJson(response, 200, {
    success: true,
    code: 0,
    message: config.dryRun ? "Dry run subscription recorded" : "Subscription forwarded",
    data: {
      id: adapterId,
      dryRun: config.dryRun,
      msaber: msaberResult
    }
  });
}

async function handleDelete(requestInfo, response) {
  const normalized = normalizeForwardPayload(requestInfo.body, requestInfo.query);
  const adapterId = buildMappingKey(normalized);
  const msaberResult = await forwardToMsaber("delete", normalized);
  const mappings = readMappings();
  delete mappings[adapterId];
  writeMappings(mappings);

  return sendJson(response, 200, {
    success: true,
    code: 0,
    message: config.dryRun ? "Dry run deletion recorded" : "Deletion forwarded",
    data: {
      id: adapterId,
      dryRun: config.dryRun,
      msaber: msaberResult
    }
  });
}

function normalizeForwardPayload(body, query) {
  const source = Object.assign({}, query || {}, body && typeof body === "object" ? body : {});
  const media = source.media || source.item || source.data || {};
  const merged = Object.assign({}, source, media);
  const type = normalizeMediaType(merged.type || merged.media_type || merged.mediaType || merged.category);

  return {
    title: firstText(merged.title, merged.name, merged.cn_name, merged.original_title),
    year: firstText(merged.year, merged.release_year),
    type,
    tmdbId: firstText(merged.tmdbid, merged.tmdb_id, merged.tmdbId, merged.tmdb),
    imdbId: firstText(merged.imdbid, merged.imdb_id, merged.imdbId, merged.imdb),
    season: firstText(merged.season, merged.season_number, merged.seasonNumber),
    episode: firstText(merged.episode, merged.episode_number, merged.episodeNumber),
    poster: firstText(merged.poster, merged.poster_path, merged.backdrop, merged.cover, merged.image),
    raw: source
  };
}

function firstText(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function normalizeMediaType(value) {
  const text = String(value || "").toLowerCase();
  if (["tv", "series", "show", "电视剧", "剧集"].includes(text)) return "tv";
  if (["movie", "film", "电影"].includes(text)) return "movie";
  return text || "unknown";
}

function buildMappingKey(payload) {
  return [payload.type, payload.tmdbId || payload.imdbId || payload.title, payload.season || ""].join(":");
}

async function forwardToMsaber(action, payload) {
  const targetPath = action === "delete" ? config.msaberDeletePath : config.msaberSubscribePath;
  if (config.dryRun || !targetPath || !config.msaberBaseUrl) {
    return { forwarded: false, reason: "dry-run-or-unconfigured", payload: toMsaberPayload(payload) };
  }

  const url = `${config.msaberBaseUrl}${targetPath.startsWith("/") ? "" : "/"}${targetPath}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [config.msaberApiKeyHeader]: config.msaberApiKey
    },
    body: JSON.stringify(toMsaberPayload(payload))
  });
  const text = await response.text();
  return {
    forwarded: true,
    status: response.status,
    ok: response.ok,
    body: parseMaybeJson(text) ?? text
  };
}

function toMsaberPayload(payload) {
  return {
    title: payload.title,
    year: payload.year,
    type: payload.type,
    tmdbid: payload.tmdbId,
    imdbid: payload.imdbId,
    season: payload.season,
    episode: payload.episode,
    poster: payload.poster
  };
}

function readMappings() {
  try {
    return JSON.parse(fs.readFileSync(mappingFile, "utf8") || "{}");
  } catch {
    return {};
  }
}

function writeMappings(mappings) {
  fs.writeFileSync(mappingFile, `${JSON.stringify(mappings, null, 2)}\n`);
}

function saveMapping(id, value) {
  const mappings = readMappings();
  mappings[id] = value;
  writeMappings(mappings);
}
