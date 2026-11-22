// StreetVoice API — 全公开无鉴权
// 搜索: GET /search?q=kw&type=song&limit=N  歌词+详情: GET /song/{id}（lyrics_is_lrc 标志格式）

var SvApi = SvApi || {};

SvApi.BASE = "https://streetvoice.com/api/v4";

SvApi.getJson = function(url) {
  try {
    // 尾部斜杠是必须的：StreetVoice 对不带斜杠的路径返回 301，宿主 http 不跟随重定向就拿到空 body
    var text = Platform.http.getText(url, { headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://streetvoice.com/"
    }});
    if (!text) return null;
    return JSON.parse(text);
  } catch (_) { return null; }
};

SvApi.search = function(keyword, pageSize, offset) {
  var url = this.BASE + "/search/?q=" + encodeURIComponent(String(keyword || "")) +
    "&type=song&limit=" + Number(pageSize || 20) +
    "&offset=" + Number(offset || 0);
  var data = this.getJson(url);
  return data && Array.isArray(data.results) ? data.results : [];
};

SvApi.getSong = function(songId) {
  if (!songId) return null;
  return this.getJson(this.BASE + "/song/" + songId + "/");
};
