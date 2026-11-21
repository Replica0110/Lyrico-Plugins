const MXM_BASE = "https://apic.musixmatch.com/ws/1.1/";
const MXM_APP_ID = "android-player-v1.0";
const MXM_USER_AGENT = "Dalvik/2.1.0 (Linux; U; Android 17)";
const MXM_COOKIE = "AWSELB=0; AWSELBCORS=0";
// 访客令牌接口（可选增强，失败不影响基础功能）
const MXM_TOKEN_BASE = MXM_BASE;
const MXM_TOKEN_APP_ID = MXM_APP_ID;
const MXM_TOKEN_USER_AGENT = MXM_USER_AGENT;
const MXM_TOKEN_CACHE_KEY = "musixmatch.guestToken.v1";
const MXM_TOKEN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MXM_LOG_TAG = "MusixmatchSource";

// 临时访客令牌（guest token），由 Musixmatch 公开的 token.get 接口自动获取，
// 用户无需手动填写 usertoken 即可使用；用户若自行配置了 usertoken，优先使用。
let mxmCachedToken = null;

function logMxm(message) {
  if (Platform.log && Platform.log.debug) {
    Platform.log.debug(MXM_LOG_TAG, String(message));
  }
}

function warnMxm(message) {
  if (Platform.log && Platform.log.warn) {
    Platform.log.warn(MXM_LOG_TAG, String(message));
  }
}

function configValue(request, key, fallback) {
  const config = (request && request.config) ? request.config : {};
  const value = config[key];

  if (value === undefined || value === null || value === "") {
    return fallback === undefined ? "" : fallback;
  }

  return value;
}

function mxmUserToken(request) {
  return String(configValue(request, "usertoken", "") || "").trim();
}

function invalidateMxmToken() {
  mxmCachedToken = null;
  try {
    Platform.cache.remove(MXM_TOKEN_CACHE_KEY);
  } catch (e) {
    // 忽略缓存清理失败
  }
}

function ensureMxmToken(request) {
  // 优先使用用户配置的 usertoken
  const userToken = mxmUserToken(request);
  if (userToken) return userToken;

  // 已有缓存的访客令牌
  if (mxmCachedToken) return mxmCachedToken;

  // 复用平台缓存，避免每次启动都重新申请（token.get 有频率限制）。
  try {
    const persisted = String(Platform.cache.get(MXM_TOKEN_CACHE_KEY) || "").trim();
    if (persisted && !/^0+$/.test(persisted)) {
      mxmCachedToken = persisted;
      return persisted;
    }
  } catch (e) {
    // 忽略缓存读取失败
  }

  // 尝试自动获取访客令牌
  try {
    const url = MXM_TOKEN_BASE + "token.get?" + buildQuery({
      user_language: "en",
      app_id: MXM_TOKEN_APP_ID,
      format: "json",
      t: Date.now()
    });
    const text = Platform.http.getText(url, {
      headers: {
        "User-Agent": MXM_TOKEN_USER_AGENT,
        "Accept": "application/json",
        "Cookie": MXM_COOKIE
      }
    });
    const root = JSON.parse(text);
    const header = root && root.message && root.message.header ? root.message.header : {};
    if (Number(header.status_code || 0) === 200) {
      const body = (root.message && root.message.body) || {};
      const t = String(body.user_token || "").trim();
      // 过滤全 0 的无效令牌
      if (t && !/^0+$/.test(t)) {
        mxmCachedToken = t;
        try {
          Platform.cache.set(MXM_TOKEN_CACHE_KEY, t, MXM_TOKEN_CACHE_TTL_MS);
        } catch (e) {
          // 忽略缓存写入失败
        }
        return t;
      }
    }
  } catch (e) {
    // 忽略获取失败
  }
  return "";
}

function randomMxmId() {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += hex.charAt(Math.floor(Math.random() * 16));
  }
  return out;
}

function buildQuery(params) {
  return Object.keys(params || {})
    .filter(function (key) {
      return params[key] !== undefined && params[key] !== null && String(params[key]) !== "";
    })
    .map(function (key) {
      return encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key]));
    })
    .join("&");
}

function mxmGet(endpoint, params) {
  const finalParams = Object.assign({}, params || {});
  finalParams.format = "json";
  finalParams.app_id = MXM_APP_ID;

  const url = MXM_BASE + String(endpoint || "").replace(/^\/+/, "") + "?" + buildQuery(finalParams);
  const text = Platform.http.getText(url, {
    headers: {
      "User-Agent": MXM_USER_AGENT,
      "Accept": "application/json",
      "Cookie": MXM_COOKIE
    }
  });

  let root;
  try {
    root = JSON.parse(text);
  } catch (e) {
    throw new Error("Musixmatch 返回了非 JSON 响应: " + String(text || "").slice(0, 200));
  }

  const header = root && root.message && root.message.header ? root.message.header : {};
  const statusCode = Number(header.status_code || 0);
  if (statusCode !== 200) {
    throw new Error("Musixmatch 接口返回状态码 " + statusCode + ": " + String(header.status_string || ""));
  }

  return root;
}

function dig(obj, keys) {
  let current = obj;
  for (let i = 0; i < keys.length; i++) {
    if (current === undefined || current === null) return undefined;
    current = current[keys[i]];
  }
  return current;
}

function deepFind(obj, key) {
  if (obj === undefined || obj === null || typeof obj !== "object") return undefined;

  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    return obj[key];
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const found = deepFind(obj[i], key);
      if (found !== undefined) return found;
    }
  } else {
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const found = deepFind(obj[keys[i]], key);
      if (found !== undefined) return found;
    }
  }

  return undefined;
}

function parseTimeMs(min, sec, fraction) {
  const ms = String(fraction || "0").padEnd(3, "0").slice(0, 3);
  return (Number(min) * 60 + Number(sec)) * 1000 + Number(ms);
}

function parseLrc(text) {
  const timed = [];

  String(text || "").split(/\r?\n/).forEach(function (line) {
    const timeRe = /\[(\d{1,}):(\d{2})(?:[.:](\d{1,3}))?]/g;
    const matches = [];
    let timeMatch;

    while ((timeMatch = timeRe.exec(line)) !== null) {
      matches.push(timeMatch);
    }

    if (!matches.length) return;

    const last = matches[matches.length - 1];
    const content = line.slice(last.index + last[0].length).trim();

    if (!content) return;

    matches.forEach(function (match) {
      const start = parseTimeMs(match[1], match[2], match[3]);
      timed.push([start, content]);
    });
  });

  timed.sort(function (a, b) {
    return a[0] - b[0];
  });

  return timed.map(function (line, index) {
    const end = timed[index + 1]
      ? Math.max(line[0], timed[index + 1][0] - 10)
      : line[0] + 3000;

    return [line[0], end, [[line[0], end, line[1]]]];
  });
}

function parseRichSync(body) {
  let entries;
  try {
    entries = JSON.parse(String(body || ""));
  } catch (e) {
    return [];
  }
  if (!Array.isArray(entries)) return [];

  const lines = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.ts === undefined || entry.ts === null) continue;

    const lineStart = Math.round(Number(entry.ts) * 1000);
    if (!isFinite(lineStart)) continue;

    const chunks = Array.isArray(entry.l) ? entry.l : [];
    const words = [];

    for (let j = 0; j < chunks.length; j++) {
      const chunk = chunks[j] || {};
      const text = String(chunk.c || "").trim();
      if (!text) continue;
      const offset = Number(chunk.o || 0);
      words.push([Math.round((Number(entry.ts) + offset) * 1000), text]);
    }

    if (words.length) {
      lines.push({ start: lineStart, words: words });
    } else if (entry.x && String(entry.x).trim()) {
      lines.push({ start: lineStart, words: [[lineStart, String(entry.x).trim()]] });
    }
  }

  if (!lines.length) return [];

  lines.sort(function (a, b) {
    return a.start - b.start;
  });

  return lines.map(function (line, index) {
    const next = index < lines.length - 1 ? lines[index + 1].start : null;
    const lineEnd = next != null ? next : line.words[line.words.length - 1][0] + 3000;

    const wordArray = line.words.map(function (word, j) {
      const wordStart = word[0];
      const wordEnd = j < line.words.length - 1 ? line.words[j + 1][0] : lineEnd;
      return [wordStart, Math.max(wordStart, wordEnd), word[1]];
    });

    return [line.start, Math.max(line.start, lineEnd), wordArray];
  });
}

function extractLineText(line) {
  const content = line[2];
  if (Array.isArray(content)) {
    return content
      .map(function (word) {
        return Array.isArray(word) ? String(word[2] || "") : String(word || "");
      })
      .join("");
  }
  return String(content || "");
}

function lyricsMerge(originalLines, textLines) {
  if (!Array.isArray(originalLines) || !Array.isArray(textLines) || !textLines.length) {
    return [];
  }

  let sortedTextLines = textLines
    .slice()
    .sort(function (a, b) {
      return Number(a[0] || 0) - Number(b[0] || 0);
    });

  // Drop empty translation lines up front so they never consume an alignment slot.
  const nonEmptyTextLines = sortedTextLines.filter(function (line) {
    return String(extractLineText(line) || "").trim() !== "";
  });
  if (nonEmptyTextLines.length) {
    sortedTextLines = nonEmptyTextLines;
  }

  const aligned = [];
  let textIndex = 0;

  for (let i = 0; i < originalLines.length; i++) {
    const original = originalLines[i];
    const winStart = Number(original[0] || 0);
    const winEnd =
      i < originalLines.length - 1
        ? Number(originalLines[i + 1][0] || winStart)
        : Number.MAX_SAFE_INTEGER;

    let matchedText = "";

    while (textIndex < sortedTextLines.length) {
      const textLine = sortedTextLines[textIndex];
      const textStart = Number(textLine[0] || 0);

      if (textStart < winStart - 500) {
        textIndex++;
        continue;
      }

      if (textStart >= winEnd) {
        break;
      }

      matchedText = extractLineText(textLine);
      textIndex++;
      break;
    }

    aligned.push([
      winStart,
      Number(original[1] || winStart),
      matchedText
    ]);
  }

  return aligned;
}

function parseMxmDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const match = raw.match(/^(\d{4})[-.]?(\d{2})[-.]?(\d{2})/);
  if (match) {
    return match[1] + "-" + match[2] + "-" + match[3];
  }

  const millis = Number(raw);
  if (millis > 0) {
    const d = new Date(millis);
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + month + "-" + day;
  }

  return "";
}
