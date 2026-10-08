// 网易云歌词：优先逐字 yrc，没有时退回逐行 lrc；翻译、音译对齐到原文行
var NELyrics = NELyrics || {};

NELyrics.HTTP_OPTIONS = { connectTimeoutMs: 4000, readTimeoutMs: 8000 };

// 网易云歌词混着三种行：
//   {"t":0,"c":[{"tx":"作词: "},{"tx":"赵雷"}]}       开头的作者信息（JSON）
//   [28480,11820](28480,160,0)我(28640,420,0)带…     逐字 yrc：时间在前、字在后
//   [00:28.15]我带着比身体重的行李                    普通 LRC
NELyrics.parse = function (text) {
  var items = [];
  String(text || "").split(/\r?\n/).forEach(function (raw) {
    var line = raw.trim();
    if (!line) return;

    if (line.charAt(0) === "{") {
      try {
        var obj = JSON.parse(line);
        var credit = (obj.c || []).map(function (c) { return c.tx || ""; }).join("").trim();
        if (credit && obj.t != null) items.push({ start: Number(obj.t), text: credit });
      } catch (e) {
        // 不是 JSON 就忽略
      }
      return;
    }

    var head = /^\[(\d+),(\d+)\]/.exec(line);
    if (head) {
      var start = Number(head[1]);
      var body = line.slice(head[0].length);
      var tokenRe = /\((\d+),(\d+),-?\d+\)/g;
      var tokens = [];
      var token;
      while ((token = tokenRe.exec(body)) !== null) {
        tokens.push({ start: Number(token[1]), dur: Number(token[2]), from: tokenRe.lastIndex, at: token.index });
      }
      var words = [];
      tokens.forEach(function (t, i) {
        var wordText = body.slice(t.from, i + 1 < tokens.length ? tokens[i + 1].at : body.length);
        if (wordText) words.push([t.start, t.start + t.dur, wordText]);
      });
      if (words.length) items.push({ start: start, end: start + Number(head[2]), words: words });
      return;
    }

    Meta.parseLrc(line).forEach(function (entry) {
      items.push(entry);
    });
  });

  items.sort(function (a, b) { return a.start - b.start; });

  var lines = [];
  items.forEach(function (item, i) {
    if (item.words) {
      lines.push([item.start, item.end, item.words]);
      return;
    }
    if (!item.text) return;
    var end = item.start + 5000;
    for (var j = i + 1; j < items.length; j++) {
      if (items[j].start > item.start) {
        end = items[j].start;
        break;
      }
    }
    lines.push([item.start, end, item.text]);
  });
  return lines;
};

NELyrics.flatten = function (lines) {
  return lines.map(function (line) {
    var text = Array.isArray(line[2]) ? line[2].map(function (w) { return w[2]; }).join("") : line[2];
    return [line[0], line[1], String(text).trim()];
  }).filter(function (line) { return line[2]; });
};

NELyrics.request = function (id) {
  try {
    return NE.checkCode(NE.eapi("/api/song/lyric/v1", {
      id: Number(id), cp: false, lv: 0, tv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0
    }, NELyrics.HTTP_OPTIONS));
  } catch (e) {
    // eapi 不可用时退回网页接口（只有逐行歌词）
    Platform.log.warn("NEMeta", "eapi lyric failed: " + Meta.errMsg(e));
    return NE.checkCode(JSON.parse(Platform.http.getText(
      "https://music.163.com/api/song/lyric?id=" + encodeURIComponent(id) + "&lv=1&tv=1&rv=1",
      Object.assign({ headers: NE.HEADERS }, NELyrics.HTTP_OPTIONS)
    )));
  }
};

NELyrics.fetch = function (id) {
  var key = "ne.lyrics.v3." + id;
  var cached = Meta.cacheGet(key);
  if (cached) return cached;

  var root = NELyrics.request(id);
  var text = function (k) { return ((root[k] || {}).lyric) || ""; };
  var yrc = text("yrc");
  var original = yrc ? NELyrics.parse(yrc) : [];
  if (!original.length) original = NELyrics.parse(text("lrc"));
  if (!original.length) return null;

  var translated = Meta.alignToOriginal(original, NELyrics.flatten(NELyrics.parse(text("tlyric"))));
  var romanization = Meta.romanizationLines(Meta.alignToOriginal(original, NELyrics.parse(text("romalrc"))));

  var result = Meta.buildLyricsResult(original, translated, romanization);
  Meta.cacheSet(key, result);
  return result;
};
