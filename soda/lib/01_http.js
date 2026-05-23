const BASE_URL = "https://api.qishui.com/";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134 Safari/537.36";

function buildQuery(params) {
  return Object.keys(params).map(key => encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key]))).join("&");
}

function getJson(path, params) {
  const text = Platform.http.getText(BASE_URL + path + "?" + buildQuery(params), {
    headers: { "User-Agent": USER_AGENT }
  });
  return JSON.parse(text);
}
