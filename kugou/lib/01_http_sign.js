const SALT = "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA";
const KRC_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
const DEVICE_MID = Platform.crypto.md5(String(Date.now()));

function buildQuery(params) {
  return Object.keys(params)
    .sort()
    .map(key => encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key])))
    .join("&");
}

function signParams(customParams, body, module) {
  const now = Math.floor(Date.now() / 1000);
  const params = {};
  if (module === "Lyric") {
    params.appid = "3116";
    params.clientver = "11070";
  } else {
    params.userid = "0";
    params.appid = "3116";
    params.token = "";
    params.clienttime = String(now);
    params.iscorrection = "1";
    params.uuid = "-";
    params.mid = DEVICE_MID;
    params.dfid = "-";
    params.clientver = "11070";
    params.platform = "AndroidFilter";
  }

  Object.keys(customParams || {}).forEach(key => params[key] = customParams[key]);
  const sorted = Object.keys(params).sort().map(key => key + "=" + params[key]).join("");
  params.signature = Platform.crypto.md5(SALT + sorted + (body || "") + SALT);
  return params;
}

function getJson(url, headers) {
  const text = Platform.http.getText(url, {
    headers: Object.assign({
      "User-Agent": "Android14-1070-11070-201-0-SearchSong-wifi"
    }, headers || {})
  });
  return JSON.parse(text);
}

function normalizeImage(url) {
  return String(url || "").replace("{size}", "480").replace("http:", "https:");
}
