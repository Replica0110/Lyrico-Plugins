// LrcShare API 通信层：匿名调用，无需鉴权
var LrcShare = LrcShare || {};

LrcShare.BASE_URL = "https://api.lrcshare.com/v1";

LrcShare.getConfig = function (request) {
  var config = request.config || {};
  return {
    timeout: parseInt(config.timeout || "15", 10) * 1000
  };
};

/** GET 请求，返回解析后的 JSON（{ code, data } 包裹） */
LrcShare.get = function (path, params, config) {
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
      headers: { "Accept": "application/json" },
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
