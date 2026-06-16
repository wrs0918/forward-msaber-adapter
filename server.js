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
  msaberDownloadingPath: process.env.MSABER_DOWNLOADING_PATH || "/api/v1/download/downloading",
  msaberDownloadHistoryPath: process.env.MSABER_DOWNLOAD_HISTORY_PATH || "/api/v1/download/history?pageNum=1&pageSize=200",
  msaberDownloadDeletePath: process.env.MSABER_DOWNLOAD_DELETE_PATH || "/api/v1/download/delete",
  msaberRequestTimeoutMs: Number(process.env.MSABER_REQUEST_TIMEOUT_MS || 10000),
  dryRun: parseBoolean(process.env.DRY_RUN, true)
};

const logFile = path.join(config.dataDir, "requests.jsonl");

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

    if (request.method === "POST" && /^\/api\/v1\/login\/access-token\/?$/.test(parsedUrl.pathname)) {
      return sendJson(response, 200, moviePilotToken());
    }

    if (request.method === "GET" && /^\/api\/v1\/system\/global\/user\/?$/.test(parsedUrl.pathname)) {
      return sendJson(response, 200, moviePilotOk(moviePilotUser(), "success"));
    }

    if (request.method === "GET" && /^\/api\/v1\/user\/?$/.test(parsedUrl.pathname)) {
      return sendJson(response, 200, [moviePilotUser()]);
    }

    if (request.method === "GET" && /^\/api\/v1\/user\/current\/?$/.test(parsedUrl.pathname)) {
      return sendJson(response, 200, moviePilotUser());
    }

    if (request.method === "GET" && /^\/api\/v1\/user\/(name|id)\/[^/]+\/?$/.test(parsedUrl.pathname)) {
      return sendJson(response, 200, moviePilotUser());
    }

    if (request.method === "GET" && /^\/api\/v1\/user\/[^/]+\/?$/.test(parsedUrl.pathname)) {
      return sendJson(response, 200, moviePilotUser());
    }

    if (request.method === "GET" && /^\/api\/v1\/subscribe\/(list)?\/?$/.test(parsedUrl.pathname)) {
      return handleSubscribeList(response);
    }

    if (request.method === "GET" && /^\/api\/v1\/subscribe\/user(\/[^/]+)?\/?$/.test(parsedUrl.pathname)) {
      return handleSubscribeList(response);
    }

    if (request.method === "GET" && /^\/api\/v1\/subscribe\/media\/[^/]+\/?$/.test(parsedUrl.pathname)) {
      return handleSubscribeLookup(parsedUrl, response);
    }

    if (request.method === "DELETE" && /^\/api\/v1\/subscribe\/media\/[^/]+\/?$/.test(parsedUrl.pathname)) {
      return handleSubscribeMediaDelete(parsedUrl, response);
    }

    if (request.method === "GET" && /^\/api\/v1\/subscribe\/status\/[^/]+\/?$/.test(parsedUrl.pathname)) {
      return sendJson(response, 200, moviePilotOk({ state: "R", status: "running" }, "success"));
    }

    if (request.method === "GET" && /^\/api\/v1\/subscribe\/(check|search|refresh)\/?$/.test(parsedUrl.pathname)) {
      return sendJson(response, 200, moviePilotOk(true, "Accepted"));
    }

    if (request.method === "GET" && /^\/api\/v1\/mediaserver\/(exists|exists_remote|notexists)\/?$/.test(parsedUrl.pathname)) {
      return sendJson(response, 200, moviePilotOk(false, "success"));
    }

    if (request.method === "GET" && /^\/api\/v1\/media\/\d+\/?$/.test(parsedUrl.pathname)) {
      return sendJson(response, 200, null);
    }

    if (request.method === "GET" && /^\/api\/v1\/search\/media\/[^/]+\/?$/.test(parsedUrl.pathname)) {
      return sendJson(response, 200, null);
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

function moviePilotToken() {
  return {
    access_token: "forward-msaber-adapter",
    token_type: "bearer",
    super_user: true,
    user_id: 1,
    user_name: "msaber",
    avatar: null,
    level: 1,
    permissions: {},
    wizard: false
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

  const existing = await findExistingSubscription(normalized);
  if (existing) {
    return sendJson(response, 200, moviePilotOk({
      id: existing.id,
      dryRun: config.dryRun,
      duplicate: true,
      msaber: {
        forwarded: false,
        reason: "already-subscribed",
        body: { code: 20000, message: "SUCCESS", data: existing.id }
      }
    }, "Subscription already exists"));
  }

  const adapterId = buildMappingKey(normalized);
  const msaberResult = await forwardToMsaber("subscribe", normalized);

  return sendJson(response, 200, moviePilotOk({
    id: adapterId,
    dryRun: config.dryRun,
    msaber: msaberResult
  }, config.dryRun ? "Dry run subscription recorded" : "Subscription forwarded"));
}

async function findExistingSubscription(payload) {
  const lookup = {
    value: payload.tmdbId || payload.imdbId || payload.title,
    title: payload.title,
    year: payload.year,
    type: payload.type,
    season: payload.season || ""
  };
  const items = await getMoviePilotMediaStates();
  return items.find(item => isSubscribeMatch(item, lookup));
}

async function handleSubscribeMediaDelete(parsedUrl, response) {
  const lookup = parseMediaLookup(parsedUrl);
  const items = await getMoviePilotMediaStates({ merge: false });
  const foundItems = items.filter(item => isSubscribeMatch(item, lookup));

  if (foundItems.length === 0) {
    return sendJson(response, 200, moviePilotOk(true, "Deleted"));
  }

  const results = await Promise.all(foundItems.map(item => deleteMsaberStateItem(item)));
  return sendJson(response, 200, moviePilotOk({
    ids: foundItems.map(item => item.id),
    sources: Array.from(new Set(foundItems.map(item => item.source || "subscribe"))),
    msaber: results
  }, "Deleted"));
}

async function handleDelete(requestInfo, response) {
  const normalized = normalizeForwardPayload(requestInfo.body, requestInfo.query);
  const adapterId = buildMappingKey(normalized);
  const msaberResult = await forwardToMsaber("delete", normalized);

  return sendJson(response, 200, moviePilotOk({
    id: adapterId,
    dryRun: config.dryRun,
    msaber: msaberResult
  }, config.dryRun ? "Dry run deletion recorded" : "Deletion forwarded"));
}

async function handleSubscribeList(response) {
  const items = await getMoviePilotMediaStates();
  return sendJson(response, 200, items.map(toForwardSubscribe));
}

async function handleSubscribeLookup(parsedUrl, response) {
  const lookup = parseMediaLookup(parsedUrl);
  const items = await getMoviePilotMediaStates();
  const found = items.find(item => isSubscribeMatch(item, lookup));
  return sendJson(response, 200, found ? toForwardSubscribe(found) : null);
}

async function getMoviePilotSubscriptions() {
  if (config.dryRun || !isMsaberConfigured()) {
    return [];
  }

  try {
    const result = await requestMsaber(config.msaberListPath);
    if (!result.ok) {
      console.warn(`MSaber subscribe list request failed: ${result.status}`);
      return [];
    }
    return mergeSubscriptions(extractMsaberList(result.body).map(item => toMoviePilotSubscribe(item)));
  } catch (error) {
    console.warn(`MSaber subscribe list request error: ${error.message || error}`);
    return [];
  }
}

async function getMoviePilotMediaStates(options = {}) {
  const [subscriptions, downloads] = await Promise.all([
    getMoviePilotSubscriptions(),
    getMoviePilotDownloadStates()
  ]);
  const items = [...subscriptions, ...downloads];
  return options.merge === false ? items : mergeSubscriptions(items);
}

async function getMoviePilotDownloadStates() {
  if (config.dryRun || !isMsaberConfigured()) {
    return [];
  }

  const results = await Promise.allSettled([
    requestMsaber(config.msaberDownloadingPath, { method: "POST", body: {} }),
    requestMsaber(config.msaberDownloadHistoryPath)
  ]);

  const items = [];
  const [downloadingResult, historyResult] = results;
  const historyItems = historyResult.status === "fulfilled" && historyResult.value.ok
    ? extractMsaberList(historyResult.value.body)
    : [];

  if (downloadingResult.status === "fulfilled" && downloadingResult.value.ok) {
    const downloadingItems = extractMsaberList(downloadingResult.value.body);
    items.push(...downloadingItems.map(item => {
      const fallback = findRelatedHistoryItem(item, historyItems);
      return toMoviePilotSubscribe(item, {
        source: "downloading",
        state: "D",
        tmdbId: fallback?.tmdbId || fallback?.tmdbid || fallback?.tmdb_id,
        poster: fallback?.poster,
        overview: fallback?.overview,
        year: fallback?.year
      });
    }));
  } else if (downloadingResult.status === "rejected") {
    console.warn(`MSaber downloading request error: ${downloadingResult.reason?.message || downloadingResult.reason}`);
  }

  if (historyResult.status === "fulfilled" && historyResult.value.ok) {
    items.push(...historyItems.map(item => toMoviePilotSubscribe(item, {
      source: "downloaded",
      state: "S"
    })));
  } else if (historyResult.status === "rejected") {
    console.warn(`MSaber download history request error: ${historyResult.reason?.message || historyResult.reason}`);
  }

  return items;
}

function findRelatedHistoryItem(item, historyItems) {
  const title = normalizedTitle(firstText(item.title, item.name));
  const year = firstText(item.year);
  const season = parseSeasonEpisode(item.seasonEpisode || item.season_episode || "").season;
  if (!title) return null;

  return historyItems.find(historyItem => {
    const historyTitle = normalizedTitle(firstText(historyItem.title, historyItem.name));
    const historyYear = firstText(historyItem.year);
    const historySeason = parseSeasonEpisode(historyItem.seasonEpisode || historyItem.season_episode || "").season;
    if (historyTitle !== title) return false;
    if (year && historyYear && year !== historyYear) return false;
    if (season && historySeason && season !== historySeason) return false;
    return true;
  }) || null;
}

function mergeSubscriptions(items) {
  const merged = new Map();
  for (const item of items) {
    const key = [
      item.type || "",
      item.tmdbid || item.mediaid || normalizedTitle(item.name) || item.id || "",
      item.season || "",
      item.source === "subscribe" ? "subscribe" : "media-state"
    ].join(":");
    if (!merged.has(key) || isBetterSubscribeItem(item, merged.get(key))) {
      merged.set(key, item);
    }
  }
  return Array.from(merged.values());
}

function isBetterSubscribeItem(candidate, current) {
  if (!current) return true;
  if (candidate.source === "subscribe" && current.source !== "subscribe") return true;
  if (candidate.source === "downloading" && current.source === "downloaded") return true;
  if (candidate.source === "downloaded" && current.source === "downloading") return false;
  if (candidate.tmdbid && !current.tmdbid) return true;
  if (candidate.id && !current.id) return true;
  if (candidate.poster && !current.poster) return true;
  if (candidate.description && !current.description) return true;
  return false;
}

function parseMediaLookup(parsedUrl) {
  const mediaId = decodeURIComponent(parsedUrl.pathname.replace(/^\/api\/v1\/subscribe\/media\//, "").replace(/\/$/, ""));
  const [kind, value] = mediaId.includes(":") ? mediaId.split(/:(.+)/) : ["", mediaId];
  return {
    kind,
    value: value || mediaId,
    season: parsedUrl.searchParams.get("season") || ""
  };
}

function isSubscribeMatch(item, lookup) {
  const ids = [item.tmdbid, item.mediaid, item.id].filter(value => value !== undefined && value !== null);
  const idMatched = ids.some(value => String(value) === String(lookup.value));
  const titleMatched = lookup.title && normalizedTitle(item.name) === normalizedTitle(lookup.title);
  if (!idMatched && !titleMatched) return false;
  if (lookup.type && item.type && item.type !== lookup.type) return false;
  if (lookup.year && item.year && String(item.year) !== String(lookup.year)) return false;
  if (!lookup.season) return true;
  return !item.season || String(item.season) === String(lookup.season);
}

function toForwardSubscribe(item) {
  const clone = { ...item };

  if (clone.source && clone.source !== "subscribe") {
    clone.state = "R";
    clone.status = "R";
    clone.note = clone.note || (clone.source === "downloaded" ? "已存在于 MSaber 已下载记录" : "已存在于 MSaber 下载任务");
  }

  clone.mediaid = clone.mediaid === undefined || clone.mediaid === null ? null : String(clone.mediaid);
  clone.media_id = clone.media_id === undefined || clone.media_id === null ? clone.mediaid : String(clone.media_id);
  clone.user = clone.user || clone.username || "msaber";
  delete clone.source;

  return clone;
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
  const parsedSeasonEpisode = parseSeasonEpisode(item.seasonEpisode || item.season_episode || item.episodes || "");
  const season = firstText(item.season, item.seasonNumber, item.season_number, fallback.season, parsedSeasonEpisode.season);
  const startEpisode = firstText(item.start_episode, item.startEpisode, item.episode, fallback.episode, parsedSeasonEpisode.episode);
  const totalEpisode = firstText(item.total_episode, item.totalEpisode, item.total, item.episodes);
  const description = firstText(item.description, item.overview, item.desc, fallback.overview, tmdbMedia.overview);

  return {
    id: toNumberOrMaybeString(id),
    name,
    title: name,
    year: firstText(item.year, item.releaseYear, item.release_year, fallback.year, tmdbMedia.year) || null,
    type: type === "movie" ? "movie" : "tv",
    tmdbid: toNumberOrMaybeString(tmdbId),
    tmdb_id: toNumberOrMaybeString(tmdbId),
    tmdbId: toNumberOrMaybeString(tmdbId),
    mediaid: toNumberOrMaybeString(firstText(item.mediaid, item.media_id, tmdbId)),
    media_id: toNumberOrMaybeString(firstText(item.mediaid, item.media_id, tmdbId)),
    keyword: firstText(item.keyword, fallback.keyword) || null,
    doubanid: firstText(item.doubanid, item.doubanId, fallback.doubanid) || null,
    bangumiid: toNumberOrMaybeString(firstText(item.bangumiid, item.bangumiId, fallback.bangumiid)),
    season: toNumberOrNull(season),
    poster: firstText(item.poster, item.posterPath, item.poster_path, item.cover, fallback.poster, tmdbMedia.poster),
    backdrop: firstText(item.backdrop, item.backdropPath, item.backdrop_path, tmdbMedia.backdrop),
    vote: toNumberOrDefault(firstText(item.vote, tmdbMedia.vote), 0),
    description: description || null,
    filter: firstText(item.filter, fallback.filter) || null,
    include: firstText(item.include, fallback.include) || null,
    exclude: firstText(item.exclude, fallback.exclude) || null,
    quality: firstText(item.quality, item.definition, fallback.quality) || null,
    resolution: firstText(item.resolution, item.definition, fallback.resolution) || null,
    effect: firstText(item.effect, fallback.effect) || null,
    total_episode: toNumberOrNull(totalEpisode) || 0,
    start_episode: toNumberOrNull(startEpisode) || 0,
    lack_episode: toNumberOrNull(firstText(item.lack_episode, item.lackEpisode)) || 0,
    completed_episode: toNumberOrNull(firstText(item.completed_episode, item.completedEpisode)),
    note: item.note ?? null,
    state: firstText(item.state, item.status, fallback.state) || null,
    status: firstText(item.state, item.status, fallback.state) || null,
    last_update: firstText(item.last_update, item.updatedAt, item.updateTime, fallback.last_update) || null,
    username: firstText(item.username, fallback.username) || "msaber",
    user: firstText(item.username, fallback.username) || "msaber",
    sites: Array.isArray(item.sites) ? item.sites : null,
    downloader: firstText(item.downloader, fallback.downloader) || null,
    best_version: toNumberOrNull(firstText(item.best_version, item.bestVersion)) || 0,
    best_version_full: toNumberOrNull(firstText(item.best_version_full, item.bestVersionFull)) || 0,
    current_priority: toNumberOrNull(firstText(item.current_priority, item.currentPriority)),
    episode_priority: item.episode_priority || item.episodePriority || null,
    save_path: firstText(item.save_path, item.savePath, fallback.save_path) || null,
    search_imdbid: toNumberOrNull(firstText(item.search_imdbid, item.searchImdbid, item.imdbId, item.imdbid, item.imdb_id, fallback.imdbId)) || 0,
    date: firstText(item.date, item.createdAt, fallback.date) || null,
    custom_words: firstText(item.custom_words, item.customWords) || null,
    media_category: firstText(item.media_category, item.mediaCategory) || null,
    filter_groups: Array.isArray(item.filter_groups) ? item.filter_groups : Array.isArray(item.filterGroups) ? item.filterGroups : null,
    episode_group: firstText(item.episode_group, item.episodeGroup) || null,
    source: fallback.source || "subscribe"
  };
}

function parseSeasonEpisode(value) {
  const text = String(value || "");
  const seasonMatch = text.match(/S(?:eason)?\s*0*(\d+)/i) || text.match(/第\s*(\d+)\s*季/);
  const episodeMatch = text.match(/E(?:pisode)?\s*0*(\d+)/i) || text.match(/第\s*(\d+)\s*[集话期]/);
  return {
    season: seasonMatch?.[1] || "",
    episode: episodeMatch?.[1] || ""
  };
}

function normalizedTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s._\-:：·,，。'"“”‘’（）()[\]【】]/g, "")
    .trim();
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

async function deleteMsaberStateItem(item) {
  if (config.dryRun || !isMsaberConfigured()) {
    return { forwarded: false, reason: "dry-run-or-unconfigured", item };
  }

  if (item.source === "downloading" && item.id) {
    const result = await requestMsaber(`${config.msaberDownloadDeletePath.replace(/\/+$/g, "")}/${item.id}`, { method: "DELETE" });
    return {
      forwarded: true,
      action: "delete-download",
      status: result.status,
      ok: result.ok,
      body: result.body
    };
  }

  if (item.source === "subscribe" && item.id) {
    const result = await requestMsaber(`${config.msaberDeletePath.replace(/\/+$/g, "")}/${item.id}`, { method: "DELETE" });
    return {
      forwarded: true,
      action: "delete-subscribe",
      status: result.status,
      ok: result.ok,
      body: result.body
    };
  }

  return {
    forwarded: false,
    reason: item.source === "downloaded" ? "already-downloaded-history-not-deleted" : "missing-msaber-id",
    item
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
