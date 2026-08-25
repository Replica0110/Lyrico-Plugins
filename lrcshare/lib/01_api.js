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
