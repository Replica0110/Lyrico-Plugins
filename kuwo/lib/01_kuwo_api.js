// 酷我通信层：搜索走 search.kuwo.cn 的 r.s 接口，歌词走 newlyric 的加密通道。
// 协议细节移植自 LDDC 的 KwApi.kt：rid 参数 XOR("yeelion") 后 base64，响应 deflate + base64 + 再 XOR + GB18030。
var KuwoApi = KuwoApi || {};

KuwoApi.NAME = "KW";
KuwoApi.SEARCH_URL = "https://search.kuwo.cn/r.s";
KuwoApi.LYRIC_URL = "https://newlyric.kuwo.cn/newlyric.lrc";
KuwoApi.MOBILE_LYRIC_URL = "https://m.kuwo.cn/newh5/singles/songinfoandlrc";
KuwoApi.COVER_BASE = "https://img1.kuwo.cn/star/albumcover/";
KuwoApi.KEY = [121, 101, 101, 108, 105, 111, 110]; // "yeelion"
KuwoApi.CACHE_PREFIX = "kuwo.api.v1.";
KuwoApi.USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 配置统一在这里归一，后续函数只读返回值 */
KuwoApi.getConfig = function (request) {
  var config = (request && request.config) || {};
  var timeout = parseInt(config.timeout || "15", 10);
  if (!isFinite(timeout) || timeout <= 0) timeout = 15;
  var size = String(config.cover_size || "500").replace(/[^0-9]/g, "");
  if (!size) size = "500";
  return {
    timeout: timeout * 1000,
    coverSize: size,
    metadata: config.metadata_details !== false && config.metadata_details !== "false"
  };
};

KuwoApi.buildQuery = function (params) {
  var keys = Object.keys(params || {});
  var parts = [];
  for (var i = 0; i < keys.length; i++) {
    var value = params[keys[i]];
    if (value === undefined || value === null || value === "") continue;
    parts.push(encodeURIComponent(keys[i]) + "=" + encodeURIComponent(String(value)));
  }
  return parts.join("&");
};

/** r.s 接口默认返回单引号伪 JSON，pcjson=1 才是标准 JSON；两种都接 */
KuwoApi.parseJson = function (text) {
  var raw = String(text || "").trim();
  if (!raw) throw new Error("empty response");
  try {
    return JSON.parse(raw);
  } catch (e) {
    var repaired = raw.replace(/'/g, "\"");
    return JSON.parse(repaired);
  }
};

KuwoApi.request = function (url, params, config) {
  var query = KuwoApi.buildQuery(params);
  var full = url + (query ? "?" + query : "");
  var text = Platform.http.getText(full, {
    headers: {
      "User-Agent": KuwoApi.USER_AGENT,
      "Accept": "application/json, text/plain, */*",
      "Referer": "https://www.kuwo.cn/"
    },
    connectTimeoutMs: Math.min(1500, Math.floor(config.timeout / 3)),
    readTimeoutMs: config.timeout
  });
  return KuwoApi.parseJson(text);
};

/** 搜索：pn 从 0 开始，与 LDDC 的 page - 1 一致 */
KuwoApi.search = function (keyword, page, pageSize, config) {
  var root = KuwoApi.request(KuwoApi.SEARCH_URL, {
    all: keyword,
    ft: "music",
    rformat: "json",
    encoding: "utf8",
    vipver: "MUSIC_9.4.0.0_W1",
    pcjson: "1",
    rn: pageSize,
    pn: Math.max(0, page - 1)
  }, config);
  return Array.isArray(root && root.abslist) ? root.abslist : [];
};

/** 专辑检索：拿发行日期与专辑艺人，按 albumid 精确对号 */
KuwoApi.searchAlbum = function (name, config) {
  if (!name) return null;
  var root = KuwoApi.request(KuwoApi.SEARCH_URL, {
    all: name,
    ft: "album",
    rformat: "json",
    encoding: "utf8",
    pcjson: "1",
    rn: 10,
    pn: 0
  }, config);
  return Array.isArray(root && root.albumlist) ? root.albumlist : [];
};

KuwoApi.cache = new Map();

KuwoApi.cached = function (key, ttlMs, producer) {
  var full = KuwoApi.CACHE_PREFIX + key;
  var now = Date.now();
  var hit = KuwoApi.cache.get(full);
  if (hit && hit.until > now) return hit.value;
  try {
    var raw = Platform.cache && Platform.cache.get(full);
    if (raw) {
      var parsed = JSON.parse(raw);
      KuwoApi.cache.set(full, { value: parsed, until: now + ttlMs });
      return parsed;
    }
  } catch (e) {}
  var value = producer();
  KuwoApi.cache.set(full, { value: value, until: now + ttlMs });
  try {
    if (Platform.cache) Platform.cache.set(full, JSON.stringify(value), ttlMs);
  } catch (e) {}
  return value;
};

/** 专辑详情：date / album_artist / cover 一次拿齐，7 天缓存 */
KuwoApi.albumInfo = function (albumId, albumName, config) {
  if (!albumId && !albumName) return null;
  var key = "album." + (albumId || albumName);
  return KuwoApi.cached(key, 7 * 24 * 3600 * 1000, function () {
    var list = KuwoApi.searchAlbum(albumName, config) || [];
    var matched = null;
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      if (albumId && String(item.albumid || item.id || "") === String(albumId)) {
        matched = item;
        break;
      }
    }
    if (!matched) return null;
    return {
      date: String(matched.pub || ""),
      albumArtist: String(matched.artist || matched.aartist || ""),
      cover: String(matched.hts_img || matched.img || "")
    };
  });
};

/** 封面：web_albumpic_short 形如 120/s4s0/93/xxx.jpg，首段是尺寸，按配置替换 */
KuwoApi.cover = function (shortPath, size) {
  var value = String(shortPath || "");
  if (!value) return "";
  var parts = value.split("/");
  if (/^\d+$/.test(parts[0])) parts[0] = String(size || "500");
  else parts.unshift(String(size || "500"));
  return KuwoApi.COVER_BASE + parts.join("/");
};

/** rid 参数：XOR + base64，等价 LDDC 的 buildParams() */
KuwoApi.buildLyricParams = function (musicId) {
  var plain = "user=12345,web,web,web&requester=localhost&req=1&rid=MUSIC_" + musicId + "&lrcx=1";
  var bytes = [];
  for (var i = 0; i < plain.length; i++) {
    bytes.push(plain.charCodeAt(i) & 0xFF);
  }
  var output = [];
  for (var j = 0; j < bytes.length; j++) {
    output.push(bytes[j] ^ KuwoApi.KEY[j % KuwoApi.KEY.length]);
  }
  return Platform.base64.encodeText(String.fromCharCode.apply(null, output));
};

/** 取原始歌词字节：优先二进制响应，退化到字符串直读 */
KuwoApi.fetchLyricBytes = function (url, config) {
  var options = {
    contentType: "application/x-www-form-urlencoded",
    headers: {
      "User-Agent": KuwoApi.USER_AGENT,
      "Accept": "*/*",
      "Referer": "https://www.kuwo.cn/"
    },
    connectTimeoutMs: Math.min(1500, Math.floor(config.timeout / 3)),
    readTimeoutMs: config.timeout
  };

  if (Platform.http && typeof Platform.http.postBytesResponse === "function") {
    var response = Platform.http.postBytesResponse(url, "", options);
    if (response && response.bodyBase64) return Gbk.base64ToBytes(response.bodyBase64);
    return [];
  }

  var fallback = Platform.http.get(url, options);
  if (fallback && fallback.bodyBase64) return Gbk.base64ToBytes(fallback.bodyBase64);
  var body = String((fallback && fallback.body) || "");
  var bytes = [];
  for (var i = 0; i < body.length; i++) bytes.push(body.charCodeAt(i) & 0xFF);
  return bytes;
};

/** 解密歌词：校验 tp=content 头 → 跳过响应头 → zlib → base64 → XOR → GB18030 */
KuwoApi.fetchLyric = function (musicId, config) {
  var url = KuwoApi.LYRIC_URL + "?" + encodeURIComponent(KuwoApi.buildLyricParams(musicId));
  var bytes = KuwoApi.fetchLyricBytes(url, config);
  if (!bytes.length) return "";

  var head = "";
  for (var i = 0; i < Math.min(10, bytes.length); i++) head += String.fromCharCode(bytes[i]);
  if (head.toLowerCase() !== "tp=content") return "";

  var headerEnd = -1;
  for (var j = 0; j < bytes.length - 3; j++) {
    if (bytes[j] === 13 && bytes[j + 1] === 10 && bytes[j + 2] === 13 && bytes[j + 3] === 10) {
      headerEnd = j + 4;
      break;
    }
  }
  if (headerEnd < 0) return "";

  var inflated = Platform.compression.inflateBytesToText(bytes.slice(headerEnd));
  if (!inflated) return "";

  var payload = Gbk.base64ToBytes(inflated);
  var plain = [];
  for (var k = 0; k < payload.length; k++) {
    plain.push(payload[k] ^ KuwoApi.KEY[k % KuwoApi.KEY.length]);
  }
  return Gbk.decode(plain);
};

/** 移动端接口兜底：逐行 JSON，无逐字信息，但纯文本稳定 */
KuwoApi.fetchMobileLyric = function (musicId, config) {
  var text = Platform.http.getText(KuwoApi.MOBILE_LYRIC_URL + "?musicId=" + encodeURIComponent(musicId), {
    headers: { "User-Agent": KuwoApi.USER_AGENT, "Accept": "application/json" },
    readTimeoutMs: config.timeout
  });
  var root = KuwoApi.parseJson(text);
  var data = (root && root.data) || null;
  if (!data || !Array.isArray(data.lrclist)) return [];
  return data.lrclist;
};
