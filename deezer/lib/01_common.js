/*
 * Lyrico plugin shared helpers.
 *
 * This file is intentionally self contained. Every plugin ships its own copy so
 * that the release packager can install a plugin on its own, without a shared
 * runtime dependency between plugins.
 */

var Lyrico = Lyrico || {};

Lyrico.log = function (tag, message) {
  try {
    if (Platform.log && Platform.log.debug) {
      Platform.log.debug(tag, String(message));
    }
  } catch (e) {}
};

Lyrico.warn = function (tag, message) {
  try {
    if (Platform.log && Platform.log.warn) {
      Platform.log.warn(tag, String(message));
    }
  } catch (e) {}
};

Lyrico.error = function (tag, message) {
  try {
    if (Platform.log && Platform.log.error) {
      Platform.log.error(tag, String(message));
    }
  } catch (e) {}
};

Lyrico.config = function (request, key, fallback) {
  var config = (request && request.config) || {};
  var value = config[key];
  if (value === undefined || value === null || value === "") {
    return fallback === undefined ? "" : fallback;
  }
  return value;
};

Lyrico.firstText = function () {
  for (var i = 0; i < arguments.length; i++) {
    var value = arguments[i];
    if (value === undefined || value === null) continue;
    var text = String(value).trim();
    if (text) return text;
  }
  return "";
};

Lyrico.firstNumber = function () {
  for (var i = 0; i < arguments.length; i++) {
    var value = Number(arguments[i]);
    if (isFinite(value) && value !== 0) return value;
  }
  return 0;
};

Lyrico.escape = encodeURIComponent;

Lyrico.buildQuery = function (params) {
  var parts = [];
  var keys = Object.keys(params || {});
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var value = params[key];
    if (value === undefined || value === null || value === "") continue;
    parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
  }
  return parts.join("&");
};

Lyrico.httpOptions = function (options) {
  options = options || {};
  var httpOptions = {
    headers: options.headers || {},
    connectTimeoutMs: Number(options.connectTimeoutMs || 12000),
    readTimeoutMs: Number(options.readTimeoutMs || 20000),
    followRedirects: options.followRedirects !== false
  };
  if (options.contentType) httpOptions.contentType = options.contentType;
  return httpOptions;
};

Lyrico.request = function (method, url, options) {
  options = options || {};
  try {
    var response = method === "POST"
      ? Platform.http.post(url, options.body === undefined ? "" : options.body, Lyrico.httpOptions(options))
      : Platform.http.get(url, Lyrico.httpOptions(options));
    return {
      code: Number(response && response.code ? response.code : 0),
      body: String(response && response.body !== undefined && response.body !== null ? response.body : ""),
      headers: (response && response.headers) || {},
      message: String((response && response.message) || ""),
      error: ""
    };
  } catch (e) {
    return {
      code: 0,
      body: "",
      headers: {},
      message: "",
      error: String(e && e.message ? e.message : e)
    };
  }
};

Lyrico.getText = function (url, options) {
  var response = Lyrico.request("GET", url, options);
  if (response.code >= 200 && response.code < 300) return response.body;
  if (response.code === 0 && response.body) return response.body;
  return "";
};

Lyrico.getJson = function (url, options) {
  return Lyrico.parseJson(Lyrico.getText(url, options));
};

Lyrico.postText = function (url, body, options) {
  options = options || {};
  options.body = body === undefined ? "" : body;
  if (!options.contentType) options.contentType = "application/x-www-form-urlencoded; charset=utf-8";
  var response = Lyrico.request("POST", url, options);
  if (response.code >= 200 && response.code < 300) return response.body;
  if (response.code === 0 && response.body) return response.body;
  return "";
};

Lyrico.postJson = function (url, body, options) {
  options = options || {};
  options.body = body === undefined ? "" : body;
  options.contentType = "application/json; charset=utf-8";
  return Lyrico.postText(url, options.body, options);
};

Lyrico.postForm = function (url, params, options) {
  options = options || {};
  var body = typeof params === "string" ? params : Lyrico.buildQuery(params);
  options.contentType = "application/x-www-form-urlencoded; charset=utf-8";
  return Lyrico.postText(url, body, options);
};

Lyrico.decodeBytesResponse = function (response) {
  var base64 = String((response && response.bodyBase64) || "");
  if (!base64) {
    return String((response && response.body) || "");
  }

  var bytes = [];
  try {
    bytes = Platform.base64.decodeBytes(base64);
  } catch (e) {
    return "";
  }

  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      return String(Platform.compression.inflateBase64ToText(base64) || "");
    } catch (e) {}
  }

  try {
    return String(Platform.base64.decodeText(base64) || "");
  } catch (e) {
    return "";
  }
};

Lyrico.getBytesText = function (url, options) {
  try {
    var response = Platform.http.getBytes(url, Lyrico.httpOptions(options));
    if (Number(response && response.code ? response.code : 0) >= 400) return "";
    return Lyrico.decodeBytesResponse(response);
  } catch (e) {
    return "";
  }
};

Lyrico.postBytesText = function (url, params, options) {
  options = options || {};
  var body = typeof params === "string" ? params : Lyrico.buildQuery(params);
  try {
    var response = Platform.http.postBytesResponse(url, body, Lyrico.httpOptions({
      headers: options.headers || {},
      connectTimeoutMs: options.connectTimeoutMs,
      readTimeoutMs: options.readTimeoutMs,
      followRedirects: options.followRedirects,
      contentType: "application/x-www-form-urlencoded; charset=utf-8"
    }));
    if (Number(response && response.code ? response.code : 0) >= 400) return "";
    return Lyrico.decodeBytesResponse(response);
  } catch (e) {
    return "";
  }
};

Lyrico.parseJson = function (text) {
  try {
    return JSON.parse(String(text === undefined || text === null ? "" : text));
  } catch (e) {
    return null;
  }
};

Lyrico.cacheGet = function (key) {
  try {
    var value = Platform.cache.get(String(key || ""));
    if (!value) return null;
    return JSON.parse(value);
  } catch (e) {
    return null;
  }
};

Lyrico.cacheSet = function (key, value, ttlMs) {
  try {
    Platform.cache.set(String(key || ""), JSON.stringify(value), Number(ttlMs || 0));
  } catch (e) {}
};

Lyrico.normalize = function (value, keepSpaces) {
  var text = String(value === undefined || value === null ? "" : value);
  try {
    if (text.normalize) text = text.normalize("NFKC");
  } catch (e) {}
  text = text.toLowerCase();
  text = text.replace(/[\(\)\[\]\{\}「」『』【】《》〈〉〔〕・·.,!?！？、。;；:：'"“”‘’`~_\-–—\/\\|&+*=^%$#@]/g, " ");
  text = text.replace(/\s+/g, keepSpaces ? " " : "");
  return keepSpaces ? text.trim() : text;
};

Lyrico.baseTitle = function (value) {
  var text = String(value === undefined || value === null ? "" : value);
  text = text.replace(/[\(（\[【][^\)）\]】]*[\)）\]】]/g, " ");
  text = text.replace(/\b(feat\.?|ft\.?|featuring)\b[\s\S]*$/i, " ");
  text = text.replace(/\b(official\s*(music\s*)?video|official\s*audio|lyrics?\s*video|audio|mv)\b/gi, " ");
  text = text.replace(/\s+[-–—]\s+(live|remaster(ed)?|version|edit|acoustic|instrumental|karaoke)\b[\s\S]*$/i, " ");
  return Lyrico.normalize(text);
};

Lyrico.artistTokens = function (value) {
  var parts = String(value === undefined || value === null ? "" : value)
    .split(/\s*(?:,|&|\/|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bx\b)\s*/i);
  var tokens = [];
  for (var i = 0; i < parts.length; i++) {
    var token = Lyrico.normalize(parts[i]);
    if (token) tokens.push(token);
  }
  return tokens;
};

Lyrico.score = function (targetTitle, targetArtist, itemTitle, itemArtist, targetDuration, itemDuration) {
  var tt = Lyrico.normalize(targetTitle);
  var tb = Lyrico.baseTitle(targetTitle);
  var ta = Lyrico.normalize(targetArtist);
  var it = Lyrico.normalize(itemTitle);
  var ib = Lyrico.baseTitle(itemTitle);
  var ia = Lyrico.normalize(itemArtist);

  var score = 0;
  var titleExact = false;
  if (tt && tt === it) {
    score += 50;
    titleExact = true;
  } else if (tb && ib && tb === ib) {
    score += 35;
    titleExact = true;
  } else if (tb && ib && (ib.indexOf(tb) >= 0 || tb.indexOf(ib) >= 0)) {
    score += 15;
  } else if (tt && it && (it.indexOf(tt) >= 0 || tt.indexOf(it) >= 0)) {
    score += 10;
  } else {
    score -= 40;
  }

  if (ta && ia) {
    if (ta === ia) {
      score += 30;
    } else if (ia.indexOf(ta) >= 0 || ta.indexOf(ia) >= 0) {
      score += 15;
    } else {
      var targetTokens = Lyrico.artistTokens(targetArtist);
      var itemTokens = Lyrico.artistTokens(itemArtist);
      var overlap = false;
      for (var i = 0; i < targetTokens.length && !overlap; i++) {
        for (var j = 0; j < itemTokens.length; j++) {
          if (targetTokens[i] === itemTokens[j] ||
              targetTokens[i].indexOf(itemTokens[j]) >= 0 ||
              itemTokens[j].indexOf(targetTokens[i]) >= 0) {
            overlap = true;
            break;
          }
        }
      }
      // Same artist written in the other Han script (周杰伦 / 周杰倫) shares
      // most of its characters even though the strings never compare equal.
      if (!overlap && /[\u3400-\u9fff]/.test(ia) && /[\u3400-\u9fff]/.test(ta)) {
        var shared = 0;
        var uniqueTarget = {};
        for (var c = 0; c < ta.length; c++) {
          var ch = ta.charAt(c);
          if (!/[\u3400-\u9fff]/.test(ch) || uniqueTarget[ch]) continue;
          uniqueTarget[ch] = true;
          if (ia.indexOf(ch) >= 0) shared++;
        }
        var targetSize = Object.keys(uniqueTarget).length;
        if (targetSize > 0 && shared / targetSize >= 0.34) overlap = true;
      }
      score += overlap ? 10 : (titleExact ? -25 : -50);
    }
  }

  if (Number(targetDuration) > 0 && Number(itemDuration) > 0) {
    var diff = Math.abs(Number(itemDuration) - Number(targetDuration)) / 1000;
    if (diff <= 1) score += 25;
    else if (diff <= 2) score += 20;
    else if (diff <= 3) score += 15;
    else if (diff <= 5) score += 5;
    else if (diff > 15) score -= 30;
  }

  return score;
};

Lyrico.rank = function (items, target) {
  var copy = (items || []).slice();
  copy.sort(function (a, b) {
    return (b.rankScore || 0) - (a.rankScore || 0);
  });
  return copy;
};

Lyrico.pad2 = function (value) {
  var text = String(value);
  return text.length < 2 ? "0" + text : text;
};

Lyrico.normalizeDate = function (value) {
  if (value === undefined || value === null || value === "") return "";
  var raw = String(value).trim();
  if (/^\d{10,}$/.test(raw)) {
    var number = Number(raw);
    if (number > 0) {
      if (number < 100000000000) number *= 1000;
      var date = new Date(number);
      if (!isNaN(date.getTime())) {
        return date.getUTCFullYear() + "-" + Lyrico.pad2(date.getUTCMonth() + 1) + "-" + Lyrico.pad2(date.getUTCDate());
      }
    }
  }
  var match = raw.match(/(\d{4})[-/.年]?(\d{1,2})?[-/.月]?(\d{1,2})?/);
  if (match) {
    if (match[2] && match[3]) return match[1] + "-" + Lyrico.pad2(match[2]) + "-" + Lyrico.pad2(match[3]);
    if (match[2]) return match[1] + "-" + Lyrico.pad2(match[2]);
    return match[1];
  }
  return "";
};

Lyrico.artworkUrl = function (url, size) {
  var text = String(url || "");
  var target = Number(size || 600);
  text = text.replace(/\/\d+x\d+(?:bb|sr)?\.(jpg|jpeg|png|webp)/i, "/" + target + "x" + target + "bb.$1");
  text = text.replace(/\/\d+x\d+(?:bb|sr)?\.(jpg|jpeg|png|webp)$/i, "/" + target + "x" + target + "bb.$1");
  return text;
};

Lyrico.ensureTags = function (request, song, tags) {
  song = song || {};
  tags = tags || {};
  var fields = song.fields || {};
  var requestedSong = (request && request.song) || {};
  var requestedFields = requestedSong.fields || {};

  var out = {};
  for (var key in tags) {
    if (Object.prototype.hasOwnProperty.call(tags, key) && tags[key] !== undefined && tags[key] !== null && String(tags[key]).trim() !== "") {
      out[key] = String(tags[key]);
    }
  }

  out.ti = Lyrico.firstText(out.ti, song.title, fields.title, requestedSong.title, requestedFields.title);
  out.ar = Lyrico.firstText(out.ar, song.artist, fields.artist, requestedSong.artist, requestedFields.artist);
  out.al = Lyrico.firstText(out.al, song.album, fields.album, requestedSong.album, requestedFields.album);
  out.date = Lyrico.normalizeDate(Lyrico.firstText(out.date, song.date, fields.date, requestedSong.date, requestedFields.date));

  if (!out.ti || !out.ar || !out.al || !out.date) return null;
  return out;
};

Lyrico.parseStamp = function (minutes, seconds, fraction) {
  var ms = String(fraction === undefined || fraction === null ? "0" : fraction);
  if (ms.length === 1) ms += "00";
  else if (ms.length === 2) ms += "0";
  else ms = ms.slice(0, 3);
  return (Number(minutes) * 60 + Number(seconds)) * 1000 + Number(ms || 0);
};

Lyrico.parseWordTags = function (content, lineStart) {
  var text = String(content || "");
  var pattern = /<\s*(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\s*>/g;
  var matches = [];
  var match;
  while ((match = pattern.exec(text)) !== null) {
    matches.push({
      index: match.index,
      endIndex: pattern.lastIndex,
      start: Lyrico.parseStamp(match[1], match[2], match[3])
    });
  }
  if (!matches.length) return [];

  var words = [];
  if (matches[0].index > 0) {
    var before = text.slice(0, matches[0].index).replace(/\s+/g, " ").trim();
    if (before) {
      words.push({ start: lineStart, end: matches[0].start, text: before });
    }
  }
  for (var i = 0; i < matches.length; i++) {
    var endIndex = i + 1 < matches.length ? matches[i + 1].index : text.length;
    var wordText = text.slice(matches[i].endIndex, endIndex).replace(/\s+/g, " ");
    if (wordText.trim()) {
      words.push({
        start: matches[i].start,
        end: i + 1 < matches.length ? matches[i + 1].start : 0,
        text: wordText
      });
    }
  }
  return words;
};

Lyrico.parseLrc = function (text, options) {
  options = options || {};
  var offset = Number(options.offsetMs || 0);
  var tags = {};
  var entries = [];
  var rawLines = String(text === undefined || text === null ? "" : text)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");

  for (var i = 0; i < rawLines.length; i++) {
    var line = rawLines[i];

    while (true) {
      var meta = line.match(/^\s*\[([a-zA-Z#][a-zA-Z0-9_#-]*):([^\]]*)\]/);
      if (!meta) break;
      var key = meta[1].toLowerCase();
      var value = meta[2].trim();
      if (key === "offset") {
        var parsedOffset = Number(value);
        if (isFinite(parsedOffset)) offset = parsedOffset;
      } else if (key !== "id" && key !== "length") {
        tags[key] = value;
      }
      line = line.slice(meta[0].length);
    }

    var timePattern = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    var times = [];
    var timeMatch;
    while ((timeMatch = timePattern.exec(line)) !== null) {
      times.push({
        index: timeMatch.index,
        length: timeMatch[0].length,
        start: Lyrico.parseStamp(timeMatch[1], timeMatch[2], timeMatch[3])
      });
    }
    if (!times.length) continue;

    var last = times[times.length - 1];
    var content = line.slice(last.index + last.length).trim();
    if (!content && !options.keepEmpty) continue;

    for (var j = 0; j < times.length; j++) {
      var start = times[j].start + offset;
      if (start < 0) start = 0;
      var words = options.wordTags === false ? [] : Lyrico.parseWordTags(content, start);
      entries.push({ start: start, content: words.length ? words : content });
    }
  }

  entries.sort(function (a, b) { return a.start - b.start; });

  var lines = [];
  for (var k = 0; k < entries.length; k++) {
    var entry = entries[k];
    var end = k + 1 < entries.length ? entries[k + 1].start : entry.start + Number(options.tailMs || 3000);
    if (end <= entry.start) end = entry.start + 3000;

    if (Array.isArray(entry.content)) {
      var words = entry.content;
      for (var w = 0; w < words.length; w++) {
        if (words[w].end <= words[w].start) {
          words[w].end = w + 1 < words.length ? words[w + 1].start : end;
        }
        if (words[w].end <= words[w].start) {
          words[w].end = words[w].start + 1;
        }
        words[w] = [words[w].start, words[w].end, words[w].text];
      }
      lines.push([entry.start, end, words]);
    } else {
      lines.push([entry.start, end, entry.content]);
    }
  }

  return { lines: lines, tags: tags, offset: offset };
};

Lyrico.linesFromPlainText = function (text) {
  var rows = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  var lines = [];
  var start = 0;
  for (var i = 0; i < rows.length; i++) {
    var value = rows[i].trim();
    if (!value) continue;
    lines.push([start, start, value]);
    start += 1;
  }
  return lines;
};

Lyrico.fromText = function (text, tags, options) {
  options = options || {};
  var raw = String(text === undefined || text === null ? "" : text).replace(/^\uFEFF/, "").trim();
  if (!raw) return null;

  if (/<tt[\s>]/i.test(raw) && /<\/tt>/i.test(raw)) {
    return { type: "rawTtml", tags: tags || {}, rawTtml: raw };
  }

  var parsed = Lyrico.parseLrc(raw, options);
  if (parsed.lines.length) {
    var hasWords = false;
    for (var i = 0; i < parsed.lines.length; i++) {
      if (Array.isArray(parsed.lines[i][2])) {
        hasWords = true;
        break;
      }
    }
    if (hasWords || options.preferStructured) {
      return { type: "structured", tags: tags || {}, original: parsed.lines };
    }
    return { type: "rawPlainLrc", tags: tags || {}, rawPlainLrc: raw };
  }

  if (options.plainAsStructured) {
    var plainLines = Lyrico.linesFromPlainText(raw);
    if (plainLines.length) {
      return { type: "structured", tags: tags || {}, original: plainLines };
    }
  }

  return { type: "rawPlainLrc", tags: tags || {}, rawPlainLrc: raw };
};

Lyrico.xmlFind = function (xml, tag) {
  try {
    return Platform.xml.findElements(String(xml || ""), { tag: tag }) || [];
  } catch (e) {
    return [];
  }
};

Lyrico.xmlChild = function (node, tag) {
  var children = (node && node.children) || [];
  for (var i = 0; i < children.length; i++) {
    if (children[i] && children[i].tag === tag) return children[i];
  }
  return null;
};

Lyrico.xmlChildText = function (node, tag) {
  var child = Lyrico.xmlChild(node, tag);
  return child ? String(child.text || "").trim() : "";
};

Lyrico.decodeBase64Text = function (base64) {
  try {
    return String(Platform.base64.decodeText(String(base64 || "")) || "");
  } catch (e) {
    return "";
  }
};

Lyrico.decodeBase64Bytes = function (base64) {
  try {
    return Platform.base64.decodeBytes(String(base64 || "")) || [];
  } catch (e) {
    return [];
  }
};

Lyrico.isValidUtf8 = function (bytes) {
  try {
    var text = "";
    // A cheap validation: decode/re-encode through the host base64 helper.
    text = Platform.base64.decodeText(Platform.base64.encodeBytes(bytes));
    return text.length > 0 || bytes.length === 0;
  } catch (e) {
    return false;
  }
};

Lyrico.hasNul = function (bytes) {
  for (var i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
};

Lyrico.bytesToText = function (bytes) {
  try {
    return String(Platform.base64.decodeText(Platform.base64.encodeBytes(bytes)) || "");
  } catch (e) {
    return "";
  }
};

Lyrico.offsetLines = function (lines, offsetMs) {
  var value = Number(offsetMs || 0);
  if (!value) return lines;
  var result = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var content = line[2];
    if (Array.isArray(content)) {
      var words = [];
      for (var j = 0; j < content.length; j++) {
        words.push([content[j][0] + value, content[j][1] + value, content[j][2]]);
      }
      result.push([line[0] + value, line[1] + value, words]);
    } else {
      result.push([line[0] + value, line[1] + value, content]);
    }
  }
  return result;
};
