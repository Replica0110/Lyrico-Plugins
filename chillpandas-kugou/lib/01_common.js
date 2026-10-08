// 三个插件共用的工具函数（QQ 音乐、网易云、酷狗插件中的本文件内容相同）
var Meta = Meta || {};

// 请求超时：搜索可能要换备用接口再试一次，详情是附加信息，都不能等太久
Meta.SEARCH_HTTP_OPTIONS = { connectTimeoutMs: 4000, readTimeoutMs: 6000 };
Meta.DETAIL_HTTP_OPTIONS = { connectTimeoutMs: 3000, readTimeoutMs: 5000 };

// 网络很差时，查详情超过这个时间就不再发新请求，保证整次调用在 Lyrico 的 15 秒上限内
Meta.DETAIL_DEADLINE_MS = 8000;

// 查过的详情缓存 7 天，同一首歌再次出现时不用重新请求
Meta.CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

Meta.errMsg = function (e) {
  return String(e && e.message ? e.message : e);
};

Meta.cacheGet = function (key) {
  try {
    var raw = Platform.cache.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
};

Meta.cacheSet = function (key, value, ttlMs) {
  try {
    Platform.cache.set(key, JSON.stringify(value), ttlMs || Meta.CACHE_TTL_MS);
  } catch (e) {
    // 宿主不支持缓存时直接跳过
  }
};

// 搜索结果缓存 6 小时：批量匹配会对同一首歌换几个关键词搜索，重复的关键词不再请求
Meta.SEARCH_CACHE_TTL_MS = 6 * 3600 * 1000;

Meta.searchCacheKey = function (prefix, keyword, page, pageSize) {
  return prefix + Platform.crypto.md5(keyword + "\n" + page + "\n" + pageSize);
};

// 实际向平台要多少条：批量匹配元数据（每次 2 条）和批量匹配歌词（每次 3 条）统一要 5 条，
// 这样两个任务用的是同一份搜索缓存，先跑元数据再跑歌词时，歌词任务不用再搜索
Meta.fetchSize = function (pageSize) {
  var n = Number(pageSize || 20);
  return n < 10 ? 5 : n;
};

// Lyrico 的歌词批量匹配固定用 pageSize = 3 调 searchSongs，只用来挑歌，不需要补全详情
Meta.isLyricsBatchSearch = function (request) {
  return Number(request.pageSize) === 3;
};

Meta.toPositiveIntString = function (value) {
  var n = parseInt(String(value == null ? "" : value), 10);
  return n > 0 ? String(n) : "";
};

// 音轨号、碟号：平台会用负数或 99999 表示「没有」，超出正常范围的一律不要
Meta.toTrackString = function (value) {
  var n = parseInt(String(value == null ? "" : value), 10);
  return n > 0 && n < 1000 ? String(n) : "";
};

// 平台返回的毫秒时间戳按北京时间换算，避免设备时区不同时日期差一天
Meta.formatDateCst = function (ms) {
  var value = Number(ms || 0);
  if (!(value > 0)) return "";
  var d = new Date(value + 8 * 3600 * 1000);
  return d.getUTCFullYear() + "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
    String(d.getUTCDate()).padStart(2, "0");
};

Meta.unique = function (names) {
  var seen = {};
  var out = [];
  for (var i = 0; i < names.length; i++) {
    var name = String(names[i] || "").trim();
    if (name && !seen[name]) {
      seen[name] = true;
      out.push(name);
    }
  }
  return out;
};

Meta.joinUnique = function (names, separator) {
  return Meta.unique(names || []).join(separator || "/");
};

Meta.splitNames = function (text) {
  return String(text || "")
    .split(/\s*(?:\/|、|，|,|;|；|\s&\s)\s*/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) {
      return s && !/^(暂无|无|未知|佚名|none|unknown|n\/a)$/i.test(s);
    });
};

Meta.LYRICIST_RE = /^(?:作词|作詞|填词|填詞|词|詞|Lyrics?(?:\s+by)?|Lyricist|Words(?:\s+by)?)\s*[:：]\s*(.+)$/i;
Meta.COMPOSER_RE = /^(?:作曲|谱曲|譜曲|曲|Composer|Composed\s+by|Music(?:\s+by)?)\s*[:：]\s*(.+)$/i;
Meta.BOTH_RE = /^(?:词曲|詞曲|作词作曲|作詞作曲|作[词詞]\s*[\/&]\s*作曲|[词詞]\s*[\/&]\s*曲|(?:Lyrics|Words)\s*(?:&|and)\s*Music(?:\s+by)?)\s*[:：]\s*(.+)$/i;

// 从 LRC 开头的「词：xxx」「曲：xxx」署名行里取作词、作曲
Meta.parseCredits = function (lrcText) {
  var lyricists = [];
  var composers = [];
  var lines = String(lrcText || "").split(/\r?\n/);
  var scanned = 0;

  for (var i = 0; i < lines.length && scanned < 20; i++) {
    var line = lines[i].replace(/^(?:\[[^\]]*\])+/, "").trim();
    if (!line) continue;
    scanned++;

    var m = line.match(Meta.BOTH_RE);
    if (m) {
      var names = Meta.splitNames(m[1]);
      lyricists = lyricists.concat(names);
      composers = composers.concat(names);
      continue;
    }
    m = line.match(Meta.LYRICIST_RE);
    if (m) {
      lyricists = lyricists.concat(Meta.splitNames(m[1]));
      continue;
    }
    m = line.match(Meta.COMPOSER_RE);
    if (m) {
      composers = composers.concat(Meta.splitNames(m[1]));
    }
  }

  return { lyricists: Meta.unique(lyricists), composers: Meta.unique(composers) };
};

// 只保留非空字段，并去掉平台数据里夹带的零宽字符，避免写进标签
Meta.compactFields = function (fields) {
  var out = {};
  Object.keys(fields).forEach(function (key) {
    if (fields[key] == null) return;
    var value = String(fields[key]).replace(/[​-‍﻿]/g, "").trim();
    if (value) out[key] = value;
  });
  return out;
};

// ---------------- 搜索结果排序 ----------------

Meta.normText = function (text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .replace(/[()（）\[\]【】《》「」『』"'“”‘’·・,，.。!！?？:：;；\-–—_\/\\&＆+×|｜~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

// text 是否作为完整的词出现在 keyword 里：2 = 按空格分隔的完整匹配，1 = 只是包含，0 = 没有
Meta.keywordHit = function (keywordNorm, text) {
  var t = Meta.normText(text);
  if (!t) return 0;
  if ((" " + keywordNorm + " ").indexOf(" " + t + " ") >= 0) return 2;
  return keywordNorm.indexOf(t) >= 0 ? 1 : 0;
};

// 和搜索关键词的匹配度：标题、艺术家各 4 分（只中一项的保持平台顺序）；
// 专辑、年份用来区分同一首歌的不同专辑版本：关键词里出现专辑名 1 分，出现发行年份 1 分
Meta.matchScore = function (keywordNorm, years, song) {
  var score = 0;
  var titleHit = Meta.keywordHit(keywordNorm, song.title);
  if (titleHit === 2) score += 4;
  else if (titleHit === 1) score += 3;

  var artistHit = Meta.splitNames(song.artist).some(function (name) {
    return Meta.keywordHit(keywordNorm, name) > 0;
  });
  if (artistHit) score += 4;

  // 专辑名和歌名相同（单曲）时，关键词里出现它不代表用户指定了专辑
  if (Meta.normText(song.album) !== Meta.normText(song.title) && Meta.keywordHit(keywordNorm, song.album) > 0) {
    score += 1;
  }

  var year = String(song.date || "").slice(0, 4);
  if (year && years.indexOf(year) >= 0) score += 1;
  return score;
};

// 排序规则：
//   1. 和关键词更匹配的排前面（关键词里写了专辑名或年份时，对应的专辑版本排第一）；
//   2. 分数相同时保持平台原来的顺序，但同一首歌（标题、艺术家相同）的不同专辑版本排在一起，
//      按发行日期从早到晚，原始版本在前
Meta.rankByKeyword = function (keyword, songs, describe) {
  var keywordNorm = Meta.normText(keyword);
  var years = String(keyword || "").match(/(?:19|20)\d{2}/g) || [];
  var firstIndex = {};
  var entries = songs.map(function (song, index) {
    // describe 把平台原始条目转成 { title, artist, album, date }；不传时条目本身就是这个结构
    var info = describe ? describe(song) : song;
    var score = Meta.matchScore(keywordNorm, years, info);
    var key = score + "\n" + Meta.normText(info.title) + "\n" + Meta.normText(info.artist);
    if (!(key in firstIndex)) firstIndex[key] = index;
    return { song: song, index: index, score: score, group: firstIndex[key], date: String(info.date || "") || "9999" };
  });
  entries.sort(function (a, b) {
    if (a.score !== b.score) return b.score - a.score;
    if (a.group !== b.group) return a.group - b.group;
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.index - b.index;
  });
  return entries.map(function (entry) { return entry.song; });
};

// 展开专辑版本后结果会比 pageSize 多。
// 批量匹配（Lyrico 每次只要 2～3 条）只保留排在最前面的几条，避免多查详情、多发请求；
// 手动搜索（每页 10 条以上）全部保留，所有专辑版本都显示
Meta.limitResults = function (items, request) {
  var pageSize = Number(request.pageSize || 20);
  return pageSize < 10 ? items.slice(0, pageSize + 2) : items;
};

// ---------------- 封面 ----------------

// Lyrico 批量匹配封面时会带上本地歌曲的信息（标题、艺术家、专辑、日期）；手动搜索封面只有关键词
Meta.isBatchCover = function (request) {
  var song = request.song || {};
  return !!(song.title || song.artist);
};

Meta.readCoverConfig = function (config) {
  config = config || {};
  var minPixels = parseInt(config.cover_min_pixels || "0", 10);
  return {
    crossPlatform: config.cover_cross_platform !== "false" && config.cover_cross_platform !== false,
    minPixels: minPixels > 0 ? minPixels : 0
  };
};

Meta.IMAGE_PROBE_BYTES = 32768;

// 从文件开头的字节里读出图片格式和像素。读不出来返回 null；格式认得但尺寸读不到时宽高为 0
Meta.imageInfo = function (bytes) {
  var u = function (i) { return bytes[i] & 255; };
  if (bytes.length > 24 && u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4E && u(3) === 0x47) {
    return {
      format: "png",
      width: ((u(16) << 24) | (u(17) << 16) | (u(18) << 8) | u(19)) >>> 0,
      height: ((u(20) << 24) | (u(21) << 16) | (u(22) << 8) | u(23)) >>> 0
    };
  }
  if (bytes.length > 4 && u(0) === 0xFF && u(1) === 0xD8) {
    var i = 2;
    while (i + 9 < bytes.length) {
      if (u(i) !== 0xFF) { i++; continue; }
      var marker = u(i + 1);
      if (marker === 0xFF) { i++; continue; }
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      // SOF0～SOF15（除去 DHT、JPG、DAC）里有图像的高和宽
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { format: "jpeg", height: (u(i + 5) << 8) | u(i + 6), width: (u(i + 7) << 8) | u(i + 8) };
      }
      i += 2 + ((u(i + 2) << 8) | u(i + 3));
    }
    return { format: "jpeg", width: 0, height: 0 };
  }
  if (bytes.length > 12 && u(0) === 0x52 && u(1) === 0x49 && u(2) === 0x46 && u(3) === 0x46 &&
      u(8) === 0x57 && u(9) === 0x45 && u(10) === 0x42 && u(11) === 0x50) {
    return { format: "webp", width: 0, height: 0 };
  }
  return null;
};

// 只下载图片开头 32KB，读出真实像素和格式（各平台的图床都支持分段下载）。失败返回 null
Meta.probeImage = function (url, headers, timeouts) {
  try {
    var res = Platform.http.getBytes(url, Object.assign({
      headers: Object.assign({ "Range": "bytes=0-" + (Meta.IMAGE_PROBE_BYTES - 1) }, headers || {}),
      connectTimeoutMs: 3000,
      readTimeoutMs: 5000
    }, timeouts || {}));
    if (!res || (res.code !== 206 && res.code !== 200) || !res.bodyBase64) return null;
    // 图床万一不理会分段、返回了整张图，也只解码开头这一段
    var head = String(res.bodyBase64).slice(0, Math.ceil(Meta.IMAGE_PROBE_BYTES / 3) * 4);
    return Meta.imageInfo(Platform.base64.decodeBytes(head));
  } catch (e) {
    Platform.log.warn("Meta", "image probe failed: " + Meta.errMsg(e));
    return null;
  }
};

// 网易云有些原图是 PNG，一张能有六七 MB；换成同样像素的 JPEG，体积小很多。其他情况原样返回
Meta.finalCoverUrl = function (url, info) {
  var isNeteasePng = info && info.format === "png" && /music\.126\.net\//.test(url) && url.indexOf("?") < 0;
  return isNeteasePng ? url + "?imageView&type=jpg&quality=95" : url;
};

// ---------------- 歌词 ----------------

// 普通 LRC → [{ start, text }]；一行有多个时间戳时展开成多行；[ti:] 这类标签行忽略
Meta.parseLrc = function (text) {
  var out = [];
  String(text || "").split(/\r?\n/).forEach(function (raw) {
    var times = [];
    var rest = raw.replace(/^\s*((?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+)/, function (all, tags) {
      tags.replace(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g, function (m, min, sec, frac) {
        times.push(Number(min) * 60000 + Number(sec) * 1000 + (frac ? Number((frac + "00").slice(0, 3)) : 0));
        return "";
      });
      return "";
    });
    times.forEach(function (t) {
      out.push({ start: t, text: rest.trim() });
    });
  });
  out.sort(function (a, b) { return a.start - b.start; });
  return out;
};

// [{ start, text }] → 结构化整行 [start, end, text]；结束时间取下一行开始（含空行），空行本身不输出
Meta.toTimedLines = function (entries) {
  var lines = [];
  for (var i = 0; i < entries.length; i++) {
    var text = entries[i].text;
    if (!text) continue;
    var end = entries[i].start + 5000;
    for (var j = i + 1; j < entries.length; j++) {
      if (entries[j].start > entries[i].start) {
        end = entries[j].start;
        break;
      }
    }
    lines.push([entries[i].start, end, text]);
  }
  return lines;
};

// Lyrico 按开始时间「完全相等」把翻译、音译对到原文行上；
// 平台给的翻译时间精度和原文不同，所以按顺序找最近的原文行（误差 1.5 秒内），改用原文行的时间
Meta.alignToOriginal = function (original, subLines) {
  var out = [];
  var from = 0;
  for (var i = 0; i < subLines.length; i++) {
    var sub = subLines[i];
    var best = -1;
    var bestDiff = Infinity;
    for (var k = from; k < original.length; k++) {
      var diff = Math.abs(original[k][0] - sub[0]);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = k;
      } else if (original[k][0] > sub[0]) {
        break;
      }
    }
    if (best < 0 || bestDiff > 1500) continue;
    out.push([original[best][0], original[best][1]].concat(sub.slice(2)));
    from = best + 1;
  }
  return out;
};

Meta.unescapeXml = function (text) {
  return String(text || "")
    .replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(Number(d)); })
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
};

// 歌词候选必须带标题、艺术家、专辑、日期，缺一项 Lyrico 就会丢弃这个候选
Meta.lyricsTags = function (song) {
  var fields = song.fields || {};
  return {
    ti: String(song.title || fields.title || "") || "未知",
    ar: String(song.artist || fields.artist || "") || "未知",
    al: String(song.album || fields.album || "") || "未知",
    date: String(song.date || fields.date || "") || "未知"
  };
};

// 汉字、假名、中日文标点和全角符号。韩文本身用空格分词，不算在内
Meta.CJK = "\\u2E80-\\u2FDF\\u3000-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF";
Meta.CJK_GAP_RE = new RegExp("([" + Meta.CJK + "])\\s+(?=[" + Meta.CJK + "])", "g");
// 汉字和假名（不含标点）
Meta.HAN = "\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF";
Meta.HAN_LEFT_RE = new RegExp("([" + Meta.HAN + "])\\s+", "g");
Meta.HAN_RIGHT_RE = new RegExp("\\s+(?=[" + Meta.HAN + "])", "g");

// 音译里的中文（酷狗给韩语歌的中文谐音等）不留空格：汉字两侧的空格都去掉，中文标点之间的也去掉；
// 拉丁音节之间保持一个空格
Meta.tidyRomanization = function (text) {
  return String(text == null ? "" : text)
    .replace(/\s+/g, " ")
    .trim()
    .replace(Meta.HAN_LEFT_RE, "$1")
    .replace(Meta.HAN_RIGHT_RE, "")
    .replace(Meta.CJK_GAP_RE, "$1");
};

// QQ 会在音译第一行放一句「以下音译标注由AI工具生产」，不是歌词
Meta.isRomanizationNotice = function (text) {
  return /^以下.{0,4}音译.{0,10}(AI|人工智能|工具).{0,6}$/i.test(String(text).replace(/\s+/g, ""));
};

// 音译统一输出成整行文本（和官方插件一致）：拉丁音节之间一个空格，中文不加空格。
// Lyrico 的逐行 LRC 会把逐字音译直接拼在一起、不加空格，整行文本在四种输出格式下都正常
Meta.romanizationLines = function (lines) {
  return lines.map(function (line) {
    var parts = Array.isArray(line[2]) ? line[2].map(function (w) { return w[2]; }) : [line[2]];
    var text = Meta.tidyRomanization(parts
      .map(function (t) { return String(t == null ? "" : t).trim(); })
      .filter(Boolean)
      .join(" "));
    return [line[0], line[1], text];
  }).filter(function (line) { return line[2] && !Meta.isRomanizationNotice(line[2]); });
};

Meta.lineText = function (line) {
  return Array.isArray(line[2]) ? line[2].map(function (w) { return w[2]; }).join("") : String(line[2]);
};

// 翻译或音译和原文一模一样的行（英文署名、「Oh oh」这类没有可翻译内容的行）不要，免得重复
Meta.dropSameAsOriginal = function (original, subLines) {
  var originalText = {};
  original.forEach(function (line) {
    originalText[line[0]] = Meta.lineText(line).replace(/\s+/g, "").toLowerCase();
  });
  return subLines.filter(function (line) {
    return Meta.lineText(line).replace(/\s+/g, "").toLowerCase() !== originalText[line[0]];
  });
};

Meta.buildLyricsResult = function (original, translated, romanization) {
  var wordLevel = original.some(function (line) { return Array.isArray(line[2]) && line[2].length > 1; });
  translated = Meta.dropSameAsOriginal(original, translated || []);
  romanization = Meta.dropSameAsOriginal(original, romanization || []);
  return {
    type: "structured",
    timing: wordLevel ? "Word" : "Line",
    original: original,
    translated: translated.length ? translated : null,
    romanization: romanization.length ? romanization : null
  };
};

// 插件设置里的三个歌词开关：逐字歌词、翻译、罗马音。缓存里存的是完整歌词，取出来以后再按开关裁剪
Meta.applyLyricOptions = function (lyrics, config) {
  config = config || {};
  var off = function (key) { return config[key] === "false" || config[key] === false; };
  var result = Object.assign({}, lyrics);
  if (off("lyric_translation")) result.translated = null;
  if (off("lyric_romanization")) result.romanization = null;
  if (off("lyric_word_level")) {
    result.original = lyrics.original.map(function (line) {
      return [line[0], line[1], Meta.lineText(line)];
    });
    result.timing = "Line";
  }
  return result;
};
