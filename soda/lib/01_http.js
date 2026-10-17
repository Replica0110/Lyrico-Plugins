// Android search and public SEO endpoints, verified against music-lib/soda:
// https://github.com/guohuiyuan/music-lib/tree/main/soda
const SEARCH_URL = "https://api.qishui.com/luna/search/track";
const SEO_TRACK_URL = "https://beta-luna.douyin.com/luna/h5/seo_track";
const SHARE_TRACK_URL = "https://music.douyin.com/qishui/share/track";
const SEARCH_USER_AGENT = "com.luna.music/100198030 (Linux; U; Android 15; zh_CN_#Hans; ABR-AL80; Build/V417IR;tt-ok/3.12.13.19)";
const SHARE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const RISK_CONTROL_MESSAGE = "汽水音乐返回空响应或拒绝请求，请稍后重试";

function buildQuery(params) {
  return Object.keys(params)
    .map(key => encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key])))
    .join("&");
}

function sodaDate(value) {
  const text = String(value || "");
  if (!/^\d{10}(?:\d{3})?$/.test(text)) return text;
  const date = new Date(Number(text) * (text.length === 10 ? 1000 : 1));
  return isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function ensureResponseBody(text, responseName) {
  const body = text === undefined || text === null ? "" : String(text).trim();
  if (!body) throw new Error(RISK_CONTROL_MESSAGE);
  return body;
}

function parseJsonResponse(text, statusCode) {
  if (statusCode === 403 || statusCode === 429) throw new Error(RISK_CONTROL_MESSAGE);
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error("汽水音乐请求失败（HTTP " + statusCode + "）");
  }
  const body = ensureResponseBody(text, "JSON");
  let root;
  try { root = JSON.parse(body); }
  catch (error) { throw new Error("汽水音乐返回无效 JSON"); }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("汽水音乐响应格式无效");
  }
  const status = root.status_code || (root.status_info || {}).status_code || 0;
  if (Number(status) !== 0) throw new Error("汽水音乐接口错误（" + status + "）");
  return root;
}

function getSodaJson(url, params, userAgent, config) {
  const headers = { "User-Agent": userAgent, "Accept": "application/json" };
  const cookies = String((config || {}).cookies || "").trim();
  if (cookies) headers.Cookie = cookies;
  const response = Platform.http.get(url + "?" + buildQuery(params), { headers: headers });
  return parseJsonResponse(response.body, Number(response.code || 0));
}

function getSearchJson(params, config) {
  const query = {
    aid: "386088", device_platform: "android", app_name: "luna",
    version_code: "100198030", version_name: "19.8.0"
  };
  Object.keys(params).forEach(key => { query[key] = params[key]; });
  const root = getSodaJson(SEARCH_URL, query, SEARCH_USER_AGENT, config);
  if (!Array.isArray(root.result_groups)) throw new Error("汽水音乐搜索响应缺少 result_groups");
  return root;
}

function getSeoTrackData(trackId, config) {
  return getSodaJson(SEO_TRACK_URL, {
    track_id: String(trackId), device_platform: "web"
  }, SHARE_USER_AGENT, config);
}

function extractAssignedJson(text, assignmentName) {
  const source = String(text || "");
  const markerIndex = source.indexOf(assignmentName);
  if (markerIndex < 0) throw new Error("汽水分享页缺少 " + assignmentName);

  const start = source.indexOf("{", markerIndex + assignmentName.length);
  if (start < 0) throw new Error("汽水分享页数据格式无效");

  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source.charAt(index);
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      return JSON.parse(source.substring(start, index + 1));
    }
  }
  throw new Error("汽水分享页数据不完整");
}

function getShareTrackData(trackId) {
  const response = Platform.http.get(
    SHARE_TRACK_URL + "?track_id=" + encodeURIComponent(String(trackId)),
    {
      headers: {
        "User-Agent": SHARE_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    }
  );
  const statusCode = Number(response.code || 0);
  const body = ensureResponseBody(response.body, "share track");
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error("汽水分享页请求失败（HTTP " + statusCode + "）");
  }
  return extractAssignedJson(body, "_ROUTER_DATA");
}
