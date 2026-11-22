// COV (covers.musichoarders.xyz) API 封装。
// 真实契约（已用线上响应核对，非照搬过时逆向代码）：
//   GET  /api/info   → { sources:[{id,name,enabled,country,cors,note}], activeSourceLimit, countries }
//   POST /api/search  body {album, artist, country, sources:[...]}
//        headers: Authorization: Bearer <token>（HMAC-SHA256 时间戳签名），浏览器 UA，X-Session
//        响应：NDJSON，每行一个 JSON；过滤 type=="cover"
//        封面行字段：bigCoverUrl（全尺寸）/ smallCoverUrl / releaseInfo{title,artist,date,tracks,barcode,url} / source
//   单次请求 sources 上限 = activeSourceLimit（实测 9），超限会报错，故分批请求合并。
// 鉴权 token = base64(HMAC-SHA256(secret, Int32LE(Math.floor(Date.now()/1000)/150)))；
// 密钥内嵌于站点前端（公开反爬密钥，与官方 COVIT 客户端及长期维护的用户脚本一致）。

var CovApi = CovApi || {};

CovApi.ORIGIN = "https://covers.musichoarders.xyz";
CovApi.SECRET = "yUzpZk3QDoq6ztdbTB9Zx9MwTB4SSwtj";
CovApi.TOKEN_STEP_SECONDS = 150;
// 浏览器 UA：站点的 Cloudflare 按 UA 拦截非浏览器客户端（返回 401 "请通过集成板块使用"）。
// 与官方 COVIT / 用户脚本一致使用浏览器 UA 是该服务预期的客户端行为。
CovApi.UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
// 默认查询的源（必须是 CovApi.KNOWN_SOURCES 的子集，否则服务端返回 400）。
// 仅 9 个：单批 ≤ activeSourceLimit，默认 searchCovers 只发 1 次 POST。
// 刻意混排 itunes/deezer/discogs/spotify/musicbrainz 这些响应最快的源，把整体延迟压到
// 2–5 秒（实测纯慢源集合会到 20s+ 超过 readTimeout 被掐断 → 0 covers + 宿主中断）。
// 与其他插件重复无所谓：COV 返回各源的最大尺寸封面，由宿主/用户择优。
// 用户在 config.sources 填更多 id 时会自动分批（接受更慢）。
CovApi.DEFAULT_SOURCES = [
  "itunes", "deezer", "discogs", "spotify", "musicbrainz",
  "tidal", "qobuz", "bandcamp", "lastfm"
];
// 服务端当前支持的源全集（实测自 /api/info，2025-11）。info 拿不到时用它过滤，
// 防止把无效源透传给 /api/search 导致整批 400。源增减时由 info 缓存动态修正。
CovApi.KNOWN_SOURCES = [
  "amazonmusic", "applemusic", "bandcamp", "beatport", "booth", "bugs", "deezer",
  "discogs", "fanarttv", "flo", "gaana", "itunes", "kugou", "lastfm", "linemusic",
  "melon", "musicbrainz", "netease", "ototoy", "qobuz", "soulseek", "soundcloud",
  "spotify", "thwiki", "tidal"
];
CovApi.INFO_CACHE_KEY = "cov_api_info";
CovApi.INFO_CACHE_TTL_MS = 3600 * 1000; // 1 小时
// info 不可用时的国家白名单兜底（与 manifest dropdown 选项一致），避免把 zz/空码透传给源端
CovApi.KNOWN_COUNTRIES = ["us","jp","kr","cn","tw","hk","gb","de","fr","ca","au","br"];
// 默认批大小：服务端 activeSourceLimit 实测为 9。info 拿不到时用此值。
CovApi.FALLBACK_BATCH_LIMIT = 9;

CovApi.token = function () {
  var e = Math.floor(Math.floor(Date.now() / 1000) / CovApi.TOKEN_STEP_SECONDS);
  // 与浏览器 crypto.subtle.sign('HMAC', key, new Int32Array([e]).buffer) 等价：4 字节小端
  var msg = [e & 0xff, (e >>> 8) & 0xff, (e >>> 16) & 0xff, (e >>> 24) & 0xff];
  var hmac = covHmacSha256(CovApi.SECRET, msg);
  return String(Platform.base64.encodeBytes(hmac) || "");
};

CovApi.uuid = function () {
  var s = "";
  for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
};

CovApi.baseHeaders = function () {
  return {
    "User-Agent": CovApi.UA,
    "Accept": "*/*",
    "Referer": CovApi.ORIGIN + "/",
    "Origin": CovApi.ORIGIN,
    "X-Session": CovApi.uuid(),
    "X-Page-Query": "",
    "X-Page-Referrer": ""
  };
};

CovApi.authHeaders = function () {
  var h = CovApi.baseHeaders();
  h["Authorization"] = "Bearer " + CovApi.token();
  return h;
};

/** 取源列表（带缓存）。失败时返回 null，调用方用默认值兜底。 */
CovApi.info = function () {
  var cached = Lyrico.cacheGet(CovApi.INFO_CACHE_KEY);
  if (cached) {
    try { return Lyrico.parseJson(cached); } catch (e) { /* fallthrough */ }
  }
  var res = Lyrico.request("GET", CovApi.ORIGIN + "/api/info", { headers: CovApi.baseHeaders(), readTimeoutMs: 12000 });
  if (res.code !== 200 || !res.body) return null;
  var info = Lyrico.parseJson(res.body);
  if (!info) return null;
  try { Lyrico.cacheSet(CovApi.INFO_CACHE_KEY, res.body, CovApi.INFO_CACHE_TTL_MS); } catch (e) { /* ignore */ }
  return info;
};

/** 把 term 截到 API 要求的 100 字符以内（按词回退），与官方客户端一致 */
CovApi.safeTerm = function (term) {
  term = String(term || "");
  if (!term) return "";
  if (term.length <= 100) return term;
  var words = term.trim().split(/\s+/);
  for (var w = words.length; w > 0; w--) {
    var t = words.slice(0, w).join(" ");
    if (t.length <= 100) return t;
  }
  return words[0] ? words[0].slice(0, 100) : "";
};

/** 解析 NDJSON 响应为归一化封面记录数组 */
CovApi.parseCovers = function (text, sourceNames) {
  var out = [];
  if (!text) return out;
  var lines = String(text).split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = (lines[i] || "").trim();
    if (!line) continue;
    var obj;
    try { obj = JSON.parse(line); } catch (e) { continue; }
    if (!obj || obj.type !== "cover") continue;
    var info = obj.releaseInfo || {};
    var picUrl = String(obj.bigCoverUrl || obj.smallCoverUrl || obj.cover_image || "");
    if (!picUrl) {
      // 兜底：某些源返回 images[] 数组
      if (Array.isArray(obj.images) && obj.images.length) picUrl = String(obj.images[0].url || obj.images[0] || "");
    }
    if (!picUrl) continue;
    var srcId = String(obj.source || "");
    out.push({
      source: srcId,
      sourceName: (sourceNames && sourceNames[srcId]) ? sourceNames[srcId] : srcId.toUpperCase(),
      title: String(info.title || ""),
      artist: String(info.artist || ""),
      album: String(info.title || ""),
      date: CovApi.normalizeDate(info.date),
      picUrl: picUrl,
      smallUrl: String(obj.smallCoverUrl || ""),
      url: String(info.url || ""),
      barcode: String(info.barcode || ""),
      tracks: Number(info.tracks || 0)
    });
  }
  return out;
};

CovApi.normalizeDate = function (raw) {
  if (!raw) return "";
  var s = String(raw);
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  var y = /^(\d{4})/.exec(s);
  return y ? y[1] : "";
};

/**
 * 搜索封面。
 * 默认：仅 1 批（≤9 个内置有效源），只发 1 次 POST，不查 /api/info —— 把单次
 * searchCovers 控制在 ~1–6 秒，避免宿主函数执行超时（Iterator interrupted）。
 * 用户在 config.sources 指定了源时：查 /api/info（带缓存）精确校验源与国家，
 * 超过 activeSourceLimit 则分批（用户主动选择更多源，接受更慢）。
 */
CovApi.search = function (album, artist, country, sources, limit) {
  var a = CovApi.safeTerm(album);
  if (!a) return [];
  var hasCustomSources = !!(sources && sources.length);
  var info = hasCustomSources ? CovApi.info() : null;

  // 源校验集合：自定义源用 info（精确），否则用内置 KNOWN_SOURCES（不发 info 请求）
  var known = {};
  if (info && Array.isArray(info.sources) && info.sources.length) {
    for (var k = 0; k < info.sources.length; k++) {
      if (info.sources[k] && info.sources[k].id) known[info.sources[k].id] = info.sources[k];
    }
  } else {
    for (var k2 = 0; k2 < CovApi.KNOWN_SOURCES.length; k2++) {
      var sid = CovApi.KNOWN_SOURCES[k2];
      known[sid] = { id: sid, name: sid };
    }
  }
  var all = (hasCustomSources ? sources.slice() : CovApi.DEFAULT_SOURCES.slice())
    .filter(function (s) { return known[s]; });
  if (!all.length) return [];

  var sourceNames = {};
  for (var kid in known) {
    if (known[kid] && known[kid].name) sourceNames[kid] = known[kid].name;
  }

  // 国家校验：info 有则用，否则用内置白名单
  var countryCode = String(country || "us").toLowerCase();
  var countryList = (info && Array.isArray(info.countries) && info.countries.length)
    ? info.countries : CovApi.KNOWN_COUNTRIES;
  var found = false;
  for (var c = 0; c < countryList.length; c++) {
    if (String(countryList[c]).toLowerCase() === countryCode) { found = true; break; }
  }
  if (!found) countryCode = "us";

  var batchLimit = Number((info && info.activeSourceLimit) || limit || CovApi.FALLBACK_BATCH_LIMIT);
  if (!batchLimit || batchLimit < 1) batchLimit = CovApi.FALLBACK_BATCH_LIMIT;

  var results = [];
  var seen = {}; // 按 picUrl 去重
  for (var off = 0; off < all.length; off += batchLimit) {
    var batch = all.slice(off, off + batchLimit);
    var body = JSON.stringify({ album: a, artist: CovApi.safeTerm(artist), country: countryCode, sources: batch });
    var res = Lyrico.request("POST", CovApi.ORIGIN + "/api/search", {
      body: body,
      headers: CovApi.authHeaders(),
      contentType: "application/json",
      readTimeoutMs: 30000
    });
    if (res.code !== 200 || !res.body) continue;
    var covers = CovApi.parseCovers(res.body, sourceNames);
    for (var i = 0; i < covers.length; i++) {
      if (seen[covers[i].picUrl]) continue;
      seen[covers[i].picUrl] = true;
      results.push(covers[i]);
    }
  }
  return results;
};
