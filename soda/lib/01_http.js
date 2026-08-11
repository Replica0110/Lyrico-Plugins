const BASE_URL = "https://api.qishui.com/";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134 Safari/537.36";
const RISK_CONTROL_MESSAGE = "汽水音乐请求已被风控，请稍后再试，或切换网络后重试。";

function buildQuery(params) {
  return Object.keys(params).map(key => encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key]))).join("&");
}

function throwRiskControl(reason) {
  if (Platform.log && typeof Platform.log.warn === "function") {
    Platform.log.warn("SodaMusic", "Risk control detected: " + reason);
  }
  throw new Error(RISK_CONTROL_MESSAGE);
}

function parseJsonResponse(text, statusCode) {
  const body = String(text || "").trim();

  if (statusCode === 403 || statusCode === 429 || !body) {
    throwRiskControl(!body ? "empty response" : "HTTP " + statusCode);
  }

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error("汽水音乐请求失败（HTTP " + statusCode + "），请稍后重试。");
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    // 汽水接口正常情况下只返回 JSON；风控命中时可能返回拦截页或其他非 JSON 内容。
    throwRiskControl("non-JSON response");
  }
}

function getJson(path, params) {
  const response = Platform.http.get(BASE_URL + path + "?" + buildQuery(params), {
    headers: { "User-Agent": USER_AGENT }
  });
  return parseJsonResponse(response.body, Number(response.code || 0));
}
