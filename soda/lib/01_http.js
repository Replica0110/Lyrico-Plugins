const BASE_URL = "https://api.qishui.com/";
const SHARE_TRACK_URL = "https://music.douyin.com/qishui/share/track";
const LUNA_PC_USER_AGENT = "LunaPC/3.5.1(408871041)";
const SHARE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const DEFAULT_DEVICE_ID = "3753066532709850";
const DEFAULT_INSTALL_ID = "3753066532713946";
const RISK_CONTROL_MESSAGE = "汽水音乐请求已被风控。请稍后重试；若持续失败，请在插件设置中填写汽水 PC 客户端认证信息。";

function stringConfig(config, key, fallback) {
  const value = (config || {})[key];
  return value === undefined || value === null || String(value).trim() === ""
    ? String(fallback || "")
    : String(value).trim();
}

function buildQuery(params) {
  return Object.keys(params)
    .map(key => encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key])))
    .join("&");
}

function randomUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(char) {
    const value = Math.floor(Math.random() * 16);
    const digit = char === "x" ? value : ((value & 3) | 8);
    return digit.toString(16);
  });
}

function buildClientParams(params, config) {
  const deviceId = stringConfig(config, "device_id", DEFAULT_DEVICE_ID);
  const common = {
    aid: "386088",
    app_name: "luna_pc",
    region: "cn",
    geo_region: "cn",
    os_region: "cn",
    sim_region: "",
    device_id: deviceId,
    cdid: "",
    iid: stringConfig(config, "iid", DEFAULT_INSTALL_ID),
    version_name: "3.5.1",
    version_code: "30050100",
    channel: "official",
    build_mode: "master",
    network_carrier: "",
    ac: "wifi",
    tz_name: "Asia/Shanghai",
    resolution: "",
    device_platform: "windows",
    device_type: "Windows",
    os_version: "Windows 10 Education",
    fp: deviceId
  };

  Object.keys(params || {}).forEach(key => {
    common[key] = params[key];
  });
  return common;
}

function hasSodaAuth(config) {
  return Boolean(
    stringConfig(config, "cookies", "") ||
    stringConfig(config, "x_helios", "") ||
    stringConfig(config, "x_medusa", "")
  );
}

function buildApiHeaders(config) {
  const headers = {
    "User-Agent": LUNA_PC_USER_AGENT,
    "Content-Type": "application/json; charset=utf-8"
  };
  const cookies = stringConfig(config, "cookies", "");
  const xHelios = stringConfig(config, "x_helios", "");
  const xMedusa = stringConfig(config, "x_medusa", "");

  if (cookies) headers.Cookie = cookies;
  if (xHelios) headers["X-Helios"] = xHelios;
  if (xMedusa) headers["X-Medusa"] = xMedusa;
  return headers;
}

function throwRiskControl(reason) {
  if (Platform.log && typeof Platform.log.warn === "function") {
    Platform.log.warn("SodaMusic", "Risk control detected: " + reason);
  }
  throw new Error(RISK_CONTROL_MESSAGE);
}

function ensureResponseBody(text, responseName) {
  const body = text === undefined || text === null ? "" : String(text).trim();
  if (!body) {
    throwRiskControl("empty " + String(responseName || "API") + " response");
  }
  return body;
}

function parseJsonResponse(text, statusCode) {
  const body = ensureResponseBody(text, "JSON");

  if (statusCode === 403 || statusCode === 429) {
    throwRiskControl("HTTP " + statusCode);
  }

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error("汽水音乐请求失败（HTTP " + statusCode + "），请稍后重试。");
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throwRiskControl("non-JSON response");
  }
}

function getJson(path, params, config) {
  const response = Platform.http.get(
    BASE_URL + path + "?" + buildQuery(buildClientParams(params, config)),
    { headers: buildApiHeaders(config) }
  );
  return parseJsonResponse(response.body, Number(response.code || 0));
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
