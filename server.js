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
  msaberSubscribePath: process.env.MSABER_SUBSCRIBE_PATH || "/api/v1/subscribe/save",
  msaberDeletePath: process.env.MSABER_DELETE_PATH || "/api/v1/subscribe/delete",
  msaberListPath: process.env.MSABER_LIST_PATH || "/api/v1/subscribe/page?pageNum=1&pageSize=200",
  msaberRequestTimeoutMs: Number(process.env.MSABER_REQUEST_TIMEOUT_MS || 10000),
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
        code: 0,
        status: "ok",
        service: "forward-msaber-adapter",
        dryRun: config.dryRun,
        msaberConfigured: isMsaberConfigured()
      });
    }

    if (request.method === "GET" && /^\/api\/v1\/user\/?$/.test(parsedUrl.pathname)) {
      return sendJson(response, 200, [moviePilotUser()]);
    }

    if (request.method === "GET" && /^\/api\/v1\/user\/current\/?$/.test(parsedUrl.pathname)) {
      return sendJson(response, 200, moviePilotUser());
    }

    if (request.method === "GET" && /^\/api\/v1\/subscribe\/(list)?\/?$/.test(parsedUrl.pathname)) {
      return handleSubscribeList(response);
    }

    if (request.method === "GET" && /^\/api\/v1\/subscribe\/user(\/[^/]+)?\/?$/.test(parsedUrl.pathname)) {
      return handleSubscribeList(response);
    }

    if (request.method === "GET" && /^\/api\/v1\/subscribe\/media\/[^/]+\/?$/.test(parsedUrl.pathname)) {
      return handleSubscribeLookup(parsedUrl.pathname, response);
    }

    if (request.method === "DELETE" && /^\/api\/v1\/subscribe\/media\/[^/]+\/?$/.test(parsedUrl.pathname)) {
      return sendJson(response, 200, moviePilotOk(true, "Deleted"));
    }

    if (request.method === "GET" && /^\/api\/v1\/subscribe\/(check|search|refresh)\/?$/.test(parsedUrl.pathname)) {
      return sendJson(response, 200, moviePilotOk(true, "Accepted"));
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

function moviePilotOk(data = null, message = "success") {
  return {
    success: true,
    code: 0,
    message,
    data
  };
}

function moviePilotUser() {
  return {
    id: 1,
    name: "msaber",
    email: null,
    is_active: true,
    is_superuser: true,
    avatar: null,
    is_otp: false,
    permissions: {},
    settings: {}
  };
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

  if (isProbePayload(normalized)) {
    return sendJson(response, 200, moviePilotOk({
      id: "probe",
      dryRun: config.dryRun,
      forwarded: false,
      reason: "probe-or-empty-payload"
    }, "Probe accepted"));
  }

  const adapterId = buildMappingKey(normalized);
  const msaberResult = await forwardToMsaber("subscribe", normalized);

  saveMapping(adapterId, {
    adapterId,
    createdAt: new Date().toISOString(),
    forward: normalized,
    msaber: msaberResult
  });

  return sendJson(response, 200, moviePilotOk({
    id: adapterId,
    dryRun: config.dryRun,
    msaber: msaberResult
  }, config.dryRun ? "Dry run subscription recorded" : "Subscription forwarded"));
}

async function handleDelete(requestInfo, response) {
  const normalized = normalizeForwardPayload(requestInfo.body, requestInfo.query);
  const adapterId = buildMappingKey(normalized);
  const msaberResult = await forwardToMsaber("delete", normalized);
  const mappings = readMappings();
  delete mappings[adapterId];
  writeMappings(mappings);

  return sendJson(response, 200, moviePilotOk({
    id: adapterId,
    dryRun: config.dryRun,
    msaber: msaberResult
  }, config.dryRun ? "Dry run deletion recorded" : "Deletion forwarded"));
}

async function handleSubscribeList(response) {
  const items = await getMoviePilotSubscriptions();
  return sendJson(response, 200, items);
}

async function handleSubscribeLookup(pathname, response) {
  const mediaId = decodeURIComponent(pathname.replace(/^\/api\/v1\/subscribe\/media\//, "").replace(/\/$/, ""));
  const items = await getMoviePilotSubscriptions();
  const found = items.find(item => {
    const candidates = [item.id, item.mediaid, item.media_id, item.tmdbid, item.tmdb_id, item.tmdbId];
    return candidates.some(value => String(value || "") === mediaId);
  });
  return sendJson(response, 200, found || null);
}

async function getMoviePilotSubscriptions() {
  if (config.dryRun || !isMsaberConfigured()) {
    return Object.values(readMappings()).map(entry => toMoviePilotSubscribe(entry.forward, entry.msaber?.body?.data || entry.msaber?.body));
  }

  try {
    const result = await requestMsaber(config.msaberListPath);
    if (!result.ok) {
      console.warn(`MSaber subscribe list request failed: ${result.status}`);
      return [];
    }
    return extractMsaberList(result.body).map(item => toMoviePilotSubscribe(item));
  } catch (error) {
    console.warn(`MSaber subscribe list request error: ${error.message || error}`);
    return [];
  }
}

function extractMsaberList(body) {
  const candidates = [
    body?.data?.list,
    body?.data?.records,
    body?.data?.items,
    body?.data,
    body?.list,
    body?.records,
    body?.items,
    body
  ];
  const list = candidates.find(Array.isArray);
  return list || [];
}

function toMoviePilotSubscribe(item = {}, fallback = {}) {
  const tmdbMedia = item.tmdbMedia || item.tmdb_media || fallback.tmdbMedia || {};
  const type = normalizeMediaType(item.type || item.media_type || item.mediaType || fallback.type || tmdbMedia.type);
  const tmdbId = firstText(item.tmdbId, item.tmdbid, item.tmdb_id, item.mediaid, item.media_id, fallback.tmdbId, tmdbMedia.id);
  const id = firstText(item.id, item.subscribeId, item.rssId, fallback.id, tmdbId);
  const name = firstText(item.name, item.title, item.keyword, fallback.name, fallback.title, tmdbMedia.title, tmdbMedia.name);
  const season = firstText(item.season, item.seasonNumber, item.season_number, fallback.season);

  return {
    id: toNumberOrMaybeString(id),
    name,
    title: name,
    year: toNumberOrNull(firstText(item.year, item.releaseYear, item.release_year, fallback.year, tmdbMedia.year)),
    type: type === "movie" ? "movie" : "tv",
    tmdbid: toNumberOrMaybeString(tmdbId),
    tmdb_id: toNumberOrMaybeString(tmdbId),
    tmdbId: toNumberOrMaybeString(tmdbId),
    imdbid: firstText(item.imdbId, item.imdbid, item.imdb_id, fallback.imdbId, tmdbMedia.imdbId),
    mediaid: toNumberOrMaybeString(firstText(item.mediaid, item.media_id, tmdbId)),
    media_id: toNumberOrMaybeString(firstText(item.media_id, item.mediaid, tmdbId)),
    season: toNumberOrNull(season),
    season_number: toNumberOrNull(season),
    start_episode: toNumberOrNull(firstText(item.startEpisode, item.start_episode, fallback.episode)),
    episode: toNumberOrNull(firstText(item.episode, item.startEpisode, fallback.episode)),
    status: firstText(item.status, fallback.status) || null,
    username: "msaber",
    user: "msaber",
    poster: firstText(item.poster, item.posterPath, item.poster_path, item.cover, fallback.poster, tmdbMedia.poster),
    backdrop: firstText(item.backdrop, item.backdropPath, item.backdrop_path, tmdbMedia.backdrop),
    overview: firstText(item.overview, item.description, item.desc, fallback.overview, tmdbMedia.overview),
    raw: item
  };
}

function isProbePayload(payload) {
  const tmdbId = String(payload.tmdbId || "").trim();
  return !payload.title && (!tmdbId || tmdbId === "-1");
}

function normalizeForwardPayload(body, query) {
  const source = Object.assign({}, query || {}, body && typeof body === "object" ? body : {});
  const media = source.media || source.item || source.data || source.detail || {};
  const merged = Object.assign({}, source, media);
  const type = normalizeMediaType(merged.type || merged.media_type || merged.mediaType || merged.category);

  return {
    title: firstText(merged.title, merged.name, merged.cn_name, merged.original_title, merged.originalTitle),
    year: firstText(merged.year, merged.release_year, merged.releaseYear, merged.premiereDate, merged.releaseDate).slice(0, 4),
    type,
    tmdbId: firstText(merged.tmdbid, merged.tmdb_id, merged.tmdbId, merged.tmdb),
    imdbId: firstText(merged.imdbid, merged.imdb_id, merged.imdbId, merged.imdb),
    season: firstText(merged.season, merged.season_number, merged.seasonNumber),
    episode: firstText(merged.episode, merged.episode_number, merged.episodeNumber),
    poster: firstText(merged.poster, merged.poster_path, merged.posterPath, merged.backdrop, merged.cover, merged.image),
    overview: firstText(merged.overview, merged.description, merged.desc, merged.summary),
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
  if (["tv", "series", "show", "电视剧", "剧集", "anime", "animation", "dongman"].includes(text)) return "tv";
  if (["movie", "film", "电影"].includes(text)) return "movie";
  return text || "unknown";
}

function buildMappingKey(payload) {
  return [payload.type, payload.tmdbId || payload.imdbId || payload.title, payload.season || ""].join(":");
}

async function forwardToMsaber(action, payload) {
  if (config.dryRun || !isMsaberConfigured()) {
    return { forwarded: false, reason: "dry-run-or-unconfigured", payload: await toMsaberPayload(payload) };
  }

  if (action === "delete") {
    return deleteMsaberSubscription(payload);
  }

  const msaberPayload = await toMsaberPayload(payload);
  const result = await requestMsaber(config.msaberSubscribePath, {
    method: "POST",
    body: msaberPayload
  });
  return {
    forwarded: true,
    status: result.status,
    ok: result.ok,
    body: result.body,
    payload: msaberPayload
  };
}

async function deleteMsaberSubscription(payload) {
  const id = payload.raw?.id || payload.raw?.rssId || payload.raw?.subscribeId;
  if (!id) return { forwarded: false, reason: "missing-msaber-subscription-id" };
  const pathWithId = `${config.msaberDeletePath.replace(/\/+$/g, "")}/${id}`;
  const result = await requestMsaber(pathWithId, { method: "DELETE" });
  return {
    forwarded: true,
    status: result.status,
    ok: result.ok,
    body: result.body
  };
}

function isMsaberConfigured() {
  return Boolean(config.msaberBaseUrl && config.msaberApiKey);
}

async function requestMsaber(targetPath, options = {}) {
  const url = `${config.msaberBaseUrl}${targetPath.startsWith("/") ? "" : "/"}${targetPath}`;
  const headers = {
    "Content-Type": "application/json"
  };
  if (!options.skipAuth) {
    if (config.msaberApiKey) headers[config.msaberApiKeyHeader] = config.msaberApiKey;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.msaberRequestTimeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    });
    const text = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      body: parseMaybeJson(text) ?? text
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getDefaultSubscribeConfig(type) {
  if (config.dryRun || !isMsaberConfigured()) return {};
  const mediaType = type === "movie" ? "movie" : "tv";
  const result = await requestMsaber(`/api/v1/subscribeDefaultConfig/detail/${mediaType}`);
  return result.body?.code === 20000 && result.body?.data ? result.body.data : {};
}

async function toMsaberPayload(payload) {
  const type = payload.type === "movie" ? "movie" : "tv";
  const defaults = await getDefaultSubscribeConfig(type);
  const base = Object.assign({}, defaults, {
    id: null,
    status: null,
    name: payload.title,
    type,
    year: toNumberOrNull(payload.year),
    tmdbId: toNumberOrNull(payload.tmdbId),
    keyword: "",
    include: defaults.include || "",
    exclude: defaults.exclude || "",
    finish: false,
    subCloudStorage: Boolean(defaults.subCloudStorage),
    subCloudStoragePath: defaults.subCloudStoragePath || "",
    CsCreatorIds: defaults.csCreatorIds || defaults.CsCreatorIds || "",
    tmdbMedia: null,
    overview: payload.overview || ""
  });

  if (type === "tv") {
    base.season = toNumberOrDefault(payload.season, 1);
    base.totalEpisode = null;
    base.startEpisode = toNumberOrDefault(payload.episode, 1);
    base.episodes = payload.episode ? String(toNumberOrDefault(payload.episode, 1)) : null;
    base.autoUpdateTotalEpisode = defaults.autoUpdateTotalEpisode !== undefined ? defaults.autoUpdateTotalEpisode : true;
    base.animeMultiEpisodeMode = false;
    base.allEpisodes = [];
  }

  return base;
}

function toNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function toNumberOrMaybeString(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) && String(number) === text ? number : text;
}

function toNumberOrDefault(value, defaultValue) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : defaultValue;
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
