// LrcShare API 通信层：需携带 X-API-Key，并先调 /catalog 换取 session_token 才能访问其他端点
var LrcShare = LrcShare || {};

LrcShare.BASE_URL = "https://api.lrcshare.com/v1";
// ⚠️ 官方插件内置 API Key：需替换为后台签发的真实 Key（格式 ls_xxx）。
// 此 Key 随插件分发，若被滥用可在后台「API Key 管理」中封禁。
LrcShare.API_KEY = "ls_b9160c7f8789e7b450e3c7c479b00da6";

// session_token 缓存：catalog 签发的会话凭证，24h 有效，过期重新拉 catalog
LrcShare.SESSION_CACHE_KEY = "lrcshare.session.v1";
LrcShare.SESSION_TTL_MS = 24 * 60 * 60 * 1000;

LrcShare.getConfig = function (request) {
  var config = request.config || {};
  return {
    timeout: parseInt(config.timeout || "15", 10) * 1000
  };
};

/** 从缓存取有效 session_token，无效则返回 null */
LrcShare.getCachedSession = function () {
  var cached = Platform.cache.get(LrcShare.SESSION_CACHE_KEY);
  if (!cached) return null;
  try {
    var obj = JSON.parse(cached);
    if (obj.token && obj.expiresAt && obj.expiresAt > Date.now()) return obj.token;
  } catch (e) { /* 缓存损坏 */ }
  return null;
};

/** 调 /catalog 获取并缓存 session_token；失败返回 null */
LrcShare.fetchSession = function (config) {
  try {
    // catalog 端点不需要 session，直接裸调
    var response = LrcShare.rawGet("/catalog", {}, config);
    if (!response || response.code !== 200 || !response.data || !response.data.session_token) return null;
    var token = response.data.session_token;
    Platform.cache.set(
      LrcShare.SESSION_CACHE_KEY,
      JSON.stringify({ token: token, expiresAt: Date.now() + LrcShare.SESSION_TTL_MS }),
      LrcShare.SESSION_TTL_MS
    );
    return token;
  } catch (e) {
    return null;
  }
};

/** 底层 GET：只带 X-API-Key，不带 session（用于 catalog） */
LrcShare.rawGet = function (path, params, config) {
  var url = LrcShare.BASE_URL + path;
  var queryParts = [];
  var keys = Object.keys(params || {});
  for (var i = 0; i < keys.length; i++) {
    queryParts.push(
      encodeURIComponent(keys[i]) + "=" + encodeURIComponent(params[keys[i]])
    );
  }
  if (queryParts.length > 0) url += "?" + queryParts.join("&");

  return JSON.parse(
    Platform.http.getText(url, {
      headers: {
        "Accept": "application/json",
        "X-API-Key": LrcShare.API_KEY
      },
      readTimeoutMs: config.timeout
    })
  );
};

/**
 * GET 请求：自动带 X-API-Key 和 X-LrcShare-Session。
 * catalog 端点不需要 session，直接裸调；其他端点先获取/复用 session_token。
 * 返回解析后的 JSON（{ code, data } 包裹）。
 */
LrcShare.get = function (path, params, config) {
  // catalog 不需要 session
  if (path === "/catalog") {
    return LrcShare.rawGet(path, params, config);
  }

  // 其他端点：确保有有效 session_token
  var sessionToken = LrcShare.getCachedSession() || LrcShare.fetchSession(config);
  var headers = {
    "Accept": "application/json",
    "X-API-Key": LrcShare.API_KEY
  };
  if (sessionToken) headers["X-LrcShare-Session"] = sessionToken;

  var url = LrcShare.BASE_URL + path;
  var queryParts = [];
  var keys = Object.keys(params || {});
  for (var i = 0; i < keys.length; i++) {
    queryParts.push(
      encodeURIComponent(keys[i]) + "=" + encodeURIComponent(params[keys[i]])
    );
  }
  if (queryParts.length > 0) url += "?" + queryParts.join("&");

  return JSON.parse(
    Platform.http.getText(url, {
      headers: headers,
      readTimeoutMs: config.timeout
    })
  );
};

// ---- 目录快照（负向预过滤） ----
// 全库可搜索文本（歌名/别名、艺术家名/别名、专辑名，已小写）。
// 搜索接口的全部匹配都是「查询串作为字段子串」，因此查询串不在快照文本中 → 必然 0 结果，
// 可直接跳过请求。目录本身 24h 缓存一次；拉取失败返回 null（降级为不做预过滤，行为同旧版）。
//
// ⚠️ 快照可能滞后（库数据更新/迁移后，本地 24h 缓存仍是旧文本）→ 命中失败导致误拦截。
// 配套升级搜索端宽松语义（至少命中一个 token 即返回）后，预过滤必须同步放宽为
// token 级：只要有一个 token 在快照中就放行；仅当「所有 token 均不在快照」才拦截。

LrcShare.CATALOG_CACHE_KEY = "lrcshare.catalog.v2"; // v2：token 级判定，强制刷掉旧缓存
LrcShare.CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

LrcShare.getCatalog = function (config) {
  var cached = Platform.cache.get(LrcShare.CATALOG_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* 缓存损坏，重新拉取 */ }
  }
  try {
    var response = LrcShare.get("/catalog", {}, config);
    if (!response || response.code !== 200 || !response.data || !response.data.text) return null;
    Platform.cache.set(LrcShare.CATALOG_CACHE_KEY, JSON.stringify(response.data), LrcShare.CATALOG_TTL_MS);
    return response.data;
  } catch (e) {
    return null; // 目录不可用不能阻塞搜索：降级为无预过滤
  }
};
