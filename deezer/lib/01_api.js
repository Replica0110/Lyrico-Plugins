// Deezer API 层：搜索（公开 REST）+ 歌词（arl cookie → JWT → GraphQL pipe）
// JWT 缓存 3.5 分钟（提前过期），双层：内存 + Platform.cache

var DeezerApi = DeezerApi || {};

DeezerApi.SEARCH_URL = "https://api.deezer.com/search";
DeezerApi.AUTH_URL = "https://auth.deezer.com/login/arl?jo=p&rto=c&i=c";
DeezerApi.PIPE_URL = "https://pipe.deezer.com/api";
DeezerApi.JWT_TTL_MS = 3.5 * 60 * 1000;
DeezerApi.JWT_CACHE_KEY = "deezer.jwt.v1";

// GraphQL 查询：完整版（含 copyright/writers）+ minimal 降级（schema 缺字段时用）
DeezerApi.LYRICS_QUERY = "query SynchronizedTrackLyrics($trackId: String!) {" +
  " track(trackId: $trackId) { id lyrics { id text copyright writers" +
  " synchronizedLines { lrcTimestamp line milliseconds duration } } } }";
DeezerApi.LYRICS_QUERY_MINIMAL = "query SynchronizedTrackLyrics($trackId: String!) {" +
  " track(trackId: $trackId) { id lyrics { id text" +
  " synchronizedLines { lrcTimestamp line milliseconds duration } } } }";

DeezerApi.getJson = function(url, extraHeaders) {
  try {
    var headers = Object.assign({ "Accept": "application/json" }, extraHeaders || {});
    var text = Platform.http.getText(url, { headers: headers });
    if (!text) return null;
    return JSON.parse(text);
  } catch (_) { return null; }
};

DeezerApi.postJson = function(url, body, extraHeaders) {
  try {
    var headers = Object.assign({
      "Accept": "application/json",
      "Content-Type": "application/json"
    }, extraHeaders || {});
    var text = Platform.http.postText(url, body, { headers: headers });
    if (!text) return null;
    return JSON.parse(text);
  } catch (_) { return null; }
};

// JWT 双层缓存：内存加速 + Platform.cache 跨实例持久化

DeezerApi.memoryJwt = null;
DeezerApi.memoryJwtUntil = 0;

DeezerApi.getCachedJwt = function() {
  var now = Date.now();
  if (this.memoryJwt && now < this.memoryJwtUntil) return this.memoryJwt;
  try {
    var cached = Platform.cache && Platform.cache.get(this.JWT_CACHE_KEY);
    if (cached) {
      var obj = JSON.parse(cached);
      if (obj.jwt && obj.until && now < obj.until) {
        this.memoryJwt = obj.jwt;
        this.memoryJwtUntil = obj.until;
        return obj.jwt;
      }
    }
  } catch (_) {}
  return null;
};

DeezerApi.saveCachedJwt = function(jwt) {
  var until = Date.now() + this.JWT_TTL_MS;
  this.memoryJwt = jwt;
  this.memoryJwtUntil = until;
  try {
    if (Platform.cache) Platform.cache.set(this.JWT_CACHE_KEY, JSON.stringify({ jwt: jwt, until: until }), this.JWT_TTL_MS);
  } catch (_) {}
};

DeezerApi.clearJwt = function() {
  this.memoryJwt = null;
  this.memoryJwtUntil = 0;
  try { if (Platform.cache) Platform.cache.remove(this.JWT_CACHE_KEY); } catch (_) {}
};

/** 用 arl cookie 换 JWT；arl 无效返回 null（HTTP 401）*/
DeezerApi.fetchJwt = function(arl) {
  if (!arl) return null;
  try {
    var resp = this.postJson(this.AUTH_URL, "", {
      "Cookie": "arl=" + arl,
      "User-Agent": "Mozilla/5.0",
      "Origin": "https://www.deezer.com",
      "Referer": "https://www.deezer.com/"
    });
    var jwt = resp && (resp.jwt || (resp.results && resp.results.jwt));
    if (typeof jwt === "string" && jwt.length > 10) {
      this.saveCachedJwt(jwt);
      return jwt;
    }
  } catch (_) {}
  return null;
};

DeezerApi.ensureJwt = function(arl) {
  var cached = this.getCachedJwt();
  if (cached) return cached;
  return this.fetchJwt(arl);
};


DeezerApi.search = function(keyword, pageSize, offset) {
  var url = this.SEARCH_URL + "?q=" + encodeURIComponent(String(keyword || "")) +
    "&limit=" + Number(pageSize || 20) +
    "&offset=" + Number(offset || 0);
  var data = this.getJson(url);
  return data && Array.isArray(data.data) ? data.data : [];
};

// album 详情内存缓存：搜索结果不含 release_date，需查 /album/{id} 补 date
// 同一次会话内同 album 只请求一次（LRU 无界，但单会话量级极小）
DeezerApi._albumCache = Object.create(null);

DeezerApi.getAlbum = function(albumId) {
  if (!albumId) return null;
  var key = String(albumId);
  if (this._albumCache[key] !== undefined) return this._albumCache[key];
  var data = this.getJson("https://api.deezer.com/album/" + encodeURIComponent(key));
  this._albumCache[key] = data || null;
  return this._albumCache[key];
};


DeezerApi.postPipe = function(jwt, query, variables) {
  var body = JSON.stringify({
    operationName: "SynchronizedTrackLyrics",
    variables: variables,
    query: query
  });
  return this.postJson(this.PIPE_URL, body, {
    "Authorization": "Bearer " + jwt,
    "Origin": "https://www.deezer.com",
    "Referer": "https://www.deezer.com/"
  });
};

/**
 * 拿歌词。内部处理 JWT 过期自动换 JWT 重试一次；schema 缺 credit 字段用 minimal 查询重试。
 * 返回 GraphQL lyrics 对象（含 synchronizedLines + text），失败返回 null。
 */
DeezerApi.fetchLyrics = function(trackId, arl) {
  if (!arl) return null;

  var jwt = this.ensureJwt(arl);
  if (!jwt) return null;

  var doFetch = function(query) {
    var result = this.postPipe(jwt, query, { trackId: String(trackId) });
    if (!result || typeof result !== "object") return null;
    // JWT 过期检测
    if (Array.isArray(result.errors)) {
      for (var i = 0; i < result.errors.length; i++) {
        var msg = (result.errors[i] || {}).message || "";
        if (msg.indexOf("Jwt") >= 0 || msg.indexOf("Unauthorized") >= 0) return { expired: true };
      }
    }
    return { data: result };
  }.bind(this);

  var first = doFetch(this.LYRICS_QUERY);
  if (!first) return null;
  if (first.expired) {
    this.clearJwt();
    jwt = this.fetchJwt(arl);
    if (!jwt) return null;
    first = doFetch(this.LYRICS_QUERY);
    if (!first || first.expired) return null;
  }

  var result = first.data;
  // schema 有 credit 字段报错 → 用 minimal 重试
  if (result.errors) {
    var second = doFetch(this.LYRICS_QUERY_MINIMAL);
    if (!second) return null;
    if (second.expired) {
      this.clearJwt();
      jwt = this.fetchJwt(arl);
      if (!jwt) return null;
      second = doFetch(this.LYRICS_QUERY_MINIMAL);
      if (!second || second.expired) return null;
    }
    if (!second.data) return null;
    result = second.data;
  }

  var lyrics = (result.data || {}).track && (result.data.track || {}).lyrics;
  return lyrics || null;
};
