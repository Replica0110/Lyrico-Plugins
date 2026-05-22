const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DEFAULT_LYRICO_USER_AGENT =
  "Lyrico/1.0 (github.com/Replica0110/Lyrico)";

let cachedToken = "";
let cachedLyricoUserAgent = "";
const APPLE_LOG_TAG = "AppleSourcePlugin";

function logApple(message) {
  if (Lyrico.log && Lyrico.log.debug) {
    Lyrico.log.debug(APPLE_LOG_TAG, message);
  }
}

function warnApple(message) {
  if (Lyrico.log && Lyrico.log.warn) {
    Lyrico.log.warn(APPLE_LOG_TAG, message);
  }
}

function getLyricoUserAgent() {
  if (cachedLyricoUserAgent) {
    return cachedLyricoUserAgent;
  }

  try {
    if (Lyrico.app && Lyrico.app.getUserAgent) {
      cachedLyricoUserAgent = String(Lyrico.app.getUserAgent() || "").trim();
    } else if (typeof app !== "undefined" && app.getUserAgent) {
      cachedLyricoUserAgent = String(app.getUserAgent() || "").trim();
    }
  } catch (e) {
    warnApple("getUserAgent failed: " + String(e && e.message ? e.message : e));
  }

  if (!cachedLyricoUserAgent) {
    cachedLyricoUserAgent = DEFAULT_LYRICO_USER_AGENT;
  }

  return cachedLyricoUserAgent;
}

function previewText(text, limit) {
  return String(text || "").replace(/\s+/g, " ").slice(0, limit || 1200);
}

function configValue(request, key, fallback) {
  return (request.config && request.config[key]) || fallback || "";
}

function storefront(region) {
  if (region === "zh-CN") return "cn";
  if (region === "ja-JP") return "jp";
  if (region === "ko-KR") return "kr";
  if (region === "en-US") return "us";
  return "us";
}

function appleGet(url, token) {
  return Lyrico.http.getText(url, {
    headers: {
      "Authorization": "Bearer " + token,
      "Origin": "https://music.apple.com",
      "Referer": "https://music.apple.com/",
      "User-Agent": getLyricoUserAgent()
    }
  });
}

function getToken(request) {
  const configuredToken = configValue(request || {}, "token", "");
  if (configuredToken) {
    logApple("using configured token tokenLength=" + String(configuredToken.length));
    return configuredToken;
  }

  if (cachedToken) return cachedToken;

  const home = Lyrico.http.getText("https://beta.music.apple.com", {
    headers: {
      "User-Agent": WEB_USER_AGENT
    }
  });

  logApple("home response length=" + String(home.length) + " preview=" + previewText(home, 500));

  const indexMatch = String(home).match(/\/assets\/index~[^/]+\.js/);
  if (!indexMatch) {
    warnApple("index js path not found in home response");
    return "";
  }

  logApple("index js path=" + indexMatch[0]);

  const js = Lyrico.http.getText("https://beta.music.apple.com" + indexMatch[0], {
    headers: {
      "User-Agent": WEB_USER_AGENT
    }
  });

  logApple("index js response length=" + String(js.length));

  const tokenMatch = String(js).match(/eyJh[^"]*/);
  cachedToken = tokenMatch ? tokenMatch[0] : "";

  logApple("token found=" + String(!!cachedToken) + " tokenLength=" + String(cachedToken.length));

  return cachedToken;
}

function splitArtist(name, separator) {
  const value = String(name || "");
  const parts = value.split(/, | & /).filter(Boolean);
  return parts.length ? parts.join(separator || "/") : value;
}

function shouldAppendSpace(current, next) {
  if (!next) return false;
  const a = String(current || "").slice(-1);
  const b = String(next || "").charAt(0);
  return /[A-Za-z0-9]/.test(a) && /[A-Za-z0-9]/.test(b);
}