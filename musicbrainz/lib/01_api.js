// MusicBrainz API 通信层
// 规则：必须携带可识别 User-Agent；限流约 1 请求/秒（超限返回 503）
// 查询类请求（recording/work 详情）按 MBID 缓存 7 天，MBID 稳定可安全复用
var MusicBrainz = MusicBrainz || {};

MusicBrainz.BASE_URL = "https://musicbrainz.org/ws/2";
MusicBrainz.CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
MusicBrainz.USER_AGENT = "Lyrico-MusicBrainz-Plugin/1.0.0 (com.musicbrainz.source; musicbrainz.org)";

MusicBrainz.getConfig = function (request) {
  var config = request.config || {};
  return {
    timeout: parseInt(config.timeout || "20", 10) * 1000,
    enrich: config.enrich === "true",
    enrichLimit: Math.max(1, parseInt(config.enrich_limit || "5", 10))
  };
};

/**
 * GET 请求。cacheKey 非空时走缓存（详情查询）；失败（网络错误 / 503 限流 / 解析失败）返回 null
 */
MusicBrainz.get = function (path, params, config, cacheKey) {
  var url = MusicBrainz.BASE_URL + path;
  var queryParts = ["fmt=json"];
  var keys = Object.keys(params || {});
  for (var i = 0; i < keys.length; i++) {
    queryParts.push(
      encodeURIComponent(keys[i]) + "=" + encodeURIComponent(params[keys[i]])
    );
  }
  url += "?" + queryParts.join("&");

  if (cacheKey) {
    var cached = Platform.cache.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) { /* 缓存损坏，走网络 */ }
    }
  }

  try {
    var text = Platform.http.getText(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": MusicBrainz.USER_AGENT
      },
      readTimeoutMs: config.timeout
    });
    var data = JSON.parse(text);
    if (cacheKey) {
      Platform.cache.set(cacheKey, text, MusicBrainz.CACHE_TTL_MS);
    }
    return data;
  } catch (e) {
    // 503 限流 / 网络失败：调用方按可跳过处理
    Platform.log.warn("MusicBrainz", "request failed: " + (e && e.message ? e.message : e));
    return null;
  }
};
