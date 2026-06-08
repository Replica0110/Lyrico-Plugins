const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DEFAULT_LYRICO_USER_AGENT =
  "Lyrico/1.0 (github.com/Replica0110/Lyrico)";

const APPLE_LOG_TAG = "AppleSourcePlugin";

let cachedDeveloperToken = "";
let cachedLyricoUserAgent = "";
let cachedRuntimeInfo = null;

function logApple(message) {
  if (Platform.log && Platform.log.debug) {
    Platform.log.debug(APPLE_LOG_TAG, String(message));
  }
}

function warnApple(message) {
  if (Platform.log && Platform.log.warn) {
    Platform.log.warn(APPLE_LOG_TAG, String(message));
  }
}

function getLyricoUserAgent() {
  if (cachedLyricoUserAgent) {
    return cachedLyricoUserAgent;
  }

  try {
    if (Platform.app && Platform.app.getUserAgent) {
      cachedLyricoUserAgent = String(Platform.app.getUserAgent() || "").trim();
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
  const config = request && request.config ? request.config : {};
  const value = config[key];

  if (value === undefined || value === null || value === "") {
    return fallback || "";
  }

  return value;
}

function getRuntimeInfoSafe() {
  if (cachedRuntimeInfo) {
    return cachedRuntimeInfo;
  }

  try {
    if (Platform.runtime && Platform.runtime.getInfo) {
      cachedRuntimeInfo = Platform.runtime.getInfo() || {};
      return cachedRuntimeInfo;
    }
  } catch (e) {
    warnApple("runtime.getInfo failed: " + String(e && e.message ? e.message : e));
  }

  cachedRuntimeInfo = {};
  return cachedRuntimeInfo;
}

function hasHostApi(name) {
  try {
    const info = getRuntimeInfoSafe();
    const apis = info.supportedHostApis || [];
    return apis.indexOf(name) >= 0;
  } catch (e) {
    return false;
  }
}

function hasXmlHostApi() {
  return !!(
    Platform.xml &&
    Platform.xml.getRootAttributes &&
    Platform.xml.findElements &&
    Platform.xml.replaceChildrenByAttr &&
    Platform.xml.removeElements &&
    hasHostApi("xml.getRootAttributes") &&
    hasHostApi("xml.findElements") &&
    hasHostApi("xml.replaceChildrenByAttr") &&
    hasHostApi("xml.removeElements")
  );
}

function storefront(region) {
  const value = String(region || "").trim();

  if (value === "cn" || value === "zh-CN" || value === "zh-Hans" || value === "zh-Hans-CN") return "cn";
  if (value === "us" || value === "en-US" || value === "en") return "us";
  if (value === "jp" || value === "ja-JP" || value === "ja") return "jp";
  if (value === "kr" || value === "ko-KR" || value === "ko") return "kr";
  if (value === "tr" || value === "tr-TR" || value === "tr") return "tr";
  if (value === "hk" || value === "zh-HK") return "hk";
  if (value === "tw" || value === "zh-TW" || value === "zh-Hant" || value === "zh-Hant-TW") return "tw";

  return "us";
}

function normalizeAppleLanguage(language) {
  const value = String(language || "").trim();

  if (!value) return "";

  if (value === "zh-CN" || value === "zh-Hans-CN") return "zh-Hans";
  if (value === "zh-TW" || value === "zh-HK" || value === "zh-Hant-TW" || value === "zh-Hant-HK") return "zh-Hant";
  if (value === "en-US" || value === "en-GB") return "en";
  if (value === "ja-JP") return "ja";
  if (value === "ko-KR") return "ko";
  if (value === "tr-TR") return "tr";

  return value;
}

function appleLanguageCandidates(language) {
  const value = String(language || "").trim();
  const normalized = normalizeAppleLanguage(value);

  if (normalized === "zh-Hans") {
    return ["zh-Hans", "zh-Hans-CN", "zh-CN"];
  }

  if (normalized === "zh-Hant") {
    return ["zh-Hant", "zh-Hant-TW", "zh-Hant-HK", "zh-TW", "zh-HK"];
  }

  if (normalized === "en") {
    return ["en", "en-US", "en-GB"];
  }

  if (normalized === "ja") {
    return ["ja", "ja-JP"];
  }

  if (normalized === "ko") {
    return ["ko", "ko-KR"];
  }

  if (normalized === "tr") {
    return ["tr", "tr-TR"];
  }

  return value ? [value] : [];
}

function appleLanguageFamily(language) {
  const normalized = normalizeAppleLanguage(language);

  if (normalized === "zh-Hans" || normalized === "zh-Hant") {
    return "zh";
  }

  if (normalized.indexOf("-") > 0) {
    return normalized.split("-")[0];
  }

  return normalized;
}

function isSameAppleLanguageFamily(left, right) {
  const a = appleLanguageFamily(left);
  const b = appleLanguageFamily(right);

  return !!a && !!b && a === b;
}

function shouldApplyAppleTranslationAsReplacement(type, sourceLanguage, translationLanguage) {
  const value = String(type || "").trim();

  if (value === "replacement") {
    return true;
  }

  if (value === "subtitle") {
    return false;
  }

  /*
   * Apple 有些中文 TTML 会把 zh-Hans 放在 translation 中但不标 type。
   * 这种只能在同语言族时当作本地化 replacement。
   * 不能把英文歌的 zh-Hans subtitle 当正文替换。
   */
  return isSameAppleLanguageFamily(sourceLanguage, translationLanguage);
}

function findAppleTranslations(ttml, language) {
  if (!hasXmlHostApi()) {
    warnApple("xml host api is unavailable, skip Apple TTML localization");
    return [];
  }

  const candidates = appleLanguageCandidates(language);
  const results = [];

  for (let i = 0; i < candidates.length; i++) {
    const lang = candidates[i];

    try {
      const items = Platform.xml.findElements(ttml, {
        tag: "translation",
        attrs: {
          "xml:lang": lang
        }
      }) || [];

      for (let j = 0; j < items.length; j++) {
        results.push(items[j]);
      }
    } catch (e) {
      warnApple(
        "xml.findElements translation failed language=" +
          lang +
          " error=" +
          String(e && e.message ? e.message : e)
      );
    }
  }

  return results;
}

function findBestAppleTranslation(ttml, language) {
  if (!hasXmlHostApi()) {
    return null;
  }

  let sourceLanguage = "";

  try {
    const rootAttrs = Platform.xml.getRootAttributes(ttml) || {};
    sourceLanguage = String(rootAttrs["xml:lang"] || rootAttrs.lang || "");
  } catch (e) {
    warnApple("xml.getRootAttributes failed: " + String(e && e.message ? e.message : e));
  }

  const translations = findAppleTranslations(ttml, language);

  for (let i = 0; i < translations.length; i++) {
    const item = translations[i] || {};
    const attrs = item.attrs || {};
    const lang = String(attrs["xml:lang"] || attrs.lang || "");
    const type = String(attrs.type || "");

    if (shouldApplyAppleTranslationAsReplacement(type, sourceLanguage, lang)) {
      return {
        node: item,
        sourceLanguage: sourceLanguage,
        language: lang,
        type: type
      };
    }
  }

  return null;
}

function appleTranslationToReplacementMap(translation) {
  const replacements = {};
  const children = (translation && translation.children) || [];

  for (let i = 0; i < children.length; i++) {
    const child = children[i] || {};

    if (child.tag !== "text") {
      continue;
    }

    const attrs = child.attrs || {};
    const key = String(attrs["for"] || "");

    if (!key) {
      continue;
    }

    const innerXml = String(child.innerXml || "");
    const text = String(child.text || "");

    if (innerXml.indexOf("<span") >= 0) {
      replacements[key] = {
        mode: "xml",
        value: innerXml
      };
    } else {
      replacements[key] = {
        mode: "text",
        value: text
      };
    }
  }

  return replacements;
}

function removeAppliedAppleReplacementTranslations(ttml, language, appliedTranslation) {
  if (!hasXmlHostApi() || !appliedTranslation) {
    return ttml;
  }

  const appliedLanguage = String(appliedTranslation.language || language || "");
  const appliedType = String(appliedTranslation.type || "");
  const sourceLanguage = String(appliedTranslation.sourceLanguage || "");

  /*
   * 如果是明确 type="replacement"，只删 replacement，不碰 subtitle。
   */
  if (appliedType === "replacement") {
    return Platform.xml.removeElements(ttml, {
      tag: "translation",
      attrs: {
        "xml:lang": appliedLanguage,
        type: "replacement"
      }
    });
  }

  /*
   * 如果 type 缺失，只在同语言族 replacement 且同语言下没有 subtitle 时，
   * 才删除这个语言的 translation，避免原文和翻译重复。
   */
  if (appliedType === "" && isSameAppleLanguageFamily(sourceLanguage, appliedLanguage)) {
    const sameLanguageTranslations = findAppleTranslations(ttml, appliedLanguage);
    let hasSubtitle = false;
    let hasNonApplicable = false;

    for (let i = 0; i < sameLanguageTranslations.length; i++) {
      const attrs = (sameLanguageTranslations[i] && sameLanguageTranslations[i].attrs) || {};
      const type = String(attrs.type || "");
      const lang = String(attrs["xml:lang"] || attrs.lang || "");

      if (type === "subtitle") {
        hasSubtitle = true;
      }

      if (!shouldApplyAppleTranslationAsReplacement(type, sourceLanguage, lang)) {
        hasNonApplicable = true;
      }
    }

    if (!hasSubtitle && !hasNonApplicable) {
      return Platform.xml.removeElements(ttml, {
        tag: "translation",
        attrs: {
          "xml:lang": appliedLanguage
        }
      });
    }
  }

  return ttml;
}

function applyAppleOfficialLocalizationToTtml(ttml, language) {
  let xml = String(ttml || "");

  if (!xml) {
    return "";
  }

  if (!hasXmlHostApi()) {
    return xml;
  }

  const translation = findBestAppleTranslation(xml, language);

  if (!translation) {
    return xml;
  }

  const replacements = appleTranslationToReplacementMap(translation.node);
  const keys = Object.keys(replacements);

  if (!keys.length) {
    return xml;
  }

  const outputLanguage = appleLanguageCandidates(language)[0] || String(language || "");

  try {
    xml = Platform.xml.replaceChildrenByAttr(xml, {
      targetTag: "p",
      keyAttr: "itunes:key",
      replacements: replacements,
      rootAttributes: outputLanguage
        ? {
            "xml:lang": outputLanguage
          }
        : {}
    });

    xml = removeAppliedAppleReplacementTranslations(xml, outputLanguage, translation);

    logApple(
      "official lyrics applied Apple localization language=" +
        outputLanguage +
        " sourceLanguage=" +
        String(translation.sourceLanguage || "") +
        " translationLanguage=" +
        String(translation.language || "") +
        " type=" +
        String(translation.type || "") +
        " count=" +
        String(keys.length)
    );

    return xml;
  } catch (e) {
    warnApple(
      "apply Apple TTML localization failed: " +
        String(e && e.message ? e.message : e)
    );
    return String(ttml || "");
  }
}

function getDeveloperToken() {
  if (cachedDeveloperToken) {
    return cachedDeveloperToken;
  }

  const homeUrl = "https://music.apple.com";
  const home = Platform.http.getText(homeUrl, {
    headers: {
      "User-Agent": WEB_USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  logApple("home response length=" + String(home.length) + " preview=" + previewText(home, 500));

  let indexPath = "";

  const legacyMatch = String(home).match(/\/assets\/index-legacy[~\-][^"']+\.js/);
  const normalMatch = String(home).match(/\/assets\/index[~\-][^"']+\.js/);
  const betaMatch = String(home).match(/\/assets\/index~[^"']+\.js/);

  if (legacyMatch) {
    indexPath = legacyMatch[0];
  } else if (normalMatch) {
    indexPath = normalMatch[0];
  } else if (betaMatch) {
    indexPath = betaMatch[0];
  }

  if (!indexPath) {
    warnApple("index js path not found in home response");
    return "";
  }

  logApple("index js path=" + indexPath);

  const js = Platform.http.getText("https://music.apple.com" + indexPath, {
    headers: {
      "User-Agent": WEB_USER_AGENT,
      "Accept": "*/*",
      "Referer": "https://music.apple.com/"
    }
  });

  logApple("index js response length=" + String(js.length));

  const tokenMatch = String(js).match(/eyJh[^"']*/);
  cachedDeveloperToken = tokenMatch ? String(tokenMatch[0]) : "";

  logApple(
    "developer token found=" +
      String(!!cachedDeveloperToken) +
      " tokenLength=" +
      String(cachedDeveloperToken.length)
  );

  return cachedDeveloperToken;
}

function appleGet(url, developerToken, mediaUserToken) {
  const headers = {
    "Authorization": "Bearer " + developerToken,
    "Origin": "https://music.apple.com",
    "Referer": "https://music.apple.com/",
    "User-Agent": getLyricoUserAgent(),
    "Accept": "application/json, text/plain, */*"
  };

  if (mediaUserToken) {
    headers["Cookie"] = "media-user-token=" + mediaUserToken;
  }

  return Platform.http.getText(url, {
    headers: headers
  });
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

function decodeXmlText(text) {
  return String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function stripXmlTags(text) {
  return decodeXmlText(String(text || "").replace(/<[^>]+>/g, ""));
}

function parseTtmlTimestampToMs(value) {
  const text = String(value || "").trim();
  if (!text) return 0;

  const msMatch = text.match(/^(\d+(?:\.\d+)?)ms$/);
  if (msMatch) {
    return Math.round(Number(msMatch[1]));
  }

  const secMatch = text.match(/^(\d+(?:\.\d+)?)s$/);
  if (secMatch) {
    return Math.round(Number(secMatch[1]) * 1000);
  }

  const hmsMatch = text.match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (hmsMatch) {
    const h = Number(hmsMatch[1] || 0);
    const m = Number(hmsMatch[2] || 0);
    const s = Number(hmsMatch[3] || 0);
    const fraction = String(hmsMatch[4] || "");
    const ms = fraction ? Number("0." + fraction) * 1000 : 0;
    return Math.round(((h * 60 + m) * 60 + s) * 1000 + ms);
  }

  const msTimeMatch = text.match(/^(\d+):(\d{2})(?:\.(\d+))?$/);
  if (msTimeMatch) {
    const m = Number(msTimeMatch[1] || 0);
    const s = Number(msTimeMatch[2] || 0);
    const fraction = String(msTimeMatch[3] || "");
    const ms = fraction ? Number("0." + fraction) * 1000 : 0;
    return Math.round((m * 60 + s) * 1000 + ms);
  }

  return 0;
}

function formatLrcTimestamp(ms) {
  const value = Math.max(0, Number(ms || 0));
  const totalSeconds = Math.floor(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const centiseconds = Math.floor((value % 1000) / 10);

  return "[" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0") +
    "." +
    String(centiseconds).padStart(2, "0") +
    "]";
}

function parseTtmlLines(ttml) {
  const xml = String(ttml || "");
  const lines = [];
  const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let match;

  while ((match = pRegex.exec(xml)) !== null) {
    const attrs = match[1] || "";
    const inner = match[2] || "";

    const beginMatch = attrs.match(/\bbegin=["']([^"']+)["']/);
    const endMatch = attrs.match(/\bend=["']([^"']+)["']/);

    const start = beginMatch ? parseTtmlTimestampToMs(beginMatch[1]) : 0;
    const end = endMatch ? parseTtmlTimestampToMs(endMatch[1]) : start;
    const text = stripXmlTags(inner).trim();

    if (text) {
      lines.push([start, end, text]);
    }
  }

  return lines;
}

function ttmlToLrc(ttml) {
  return parseTtmlLines(ttml)
    .map(function(line) {
      return formatLrcTimestamp(line[0]) + line[2];
    })
    .join("\n");
}