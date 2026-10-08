// 酷狗歌词：按歌曲 hash 搜歌词 → 下载 KRC（逐字）→ 解密解析；翻译、音译在 KRC 的 [language:] 标签里
var KGLyrics = KGLyrics || {};

KGLyrics.HTTP_OPTIONS = { connectTimeoutMs: 4000, readTimeoutMs: 8000 };

// KRC 文件：开头 4 字节 "krc1"，其余与这个密钥循环异或后是 zlib 压缩的文本
KGLyrics.KRC_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];

KGLyrics.lyricParams = function (custom) {
  return KG.sign(Object.assign({ appid: KG.LITE.appid, clientver: KG.LITE.clientver }, custom), "", KG.LITE.salt);
};

KGLyrics.search = function (song) {
  var internal = song.internal || {};
  var params = KGLyrics.lyricParams({
    album_audio_id: String(song.id || ""),
    duration: String(Number(song.duration || 0)),
    hash: String(internal.hash || ""),
    keyword: (song.artist || "") + " - " + (song.title || ""),
    lrctxt: "1",
    man: "no"
  });
  var root = KG.getJson("https://lyrics.kugou.com/v1/search?" + KG.query(params), {}, KGLyrics.HTTP_OPTIONS);
  return root.candidates || [];
};

KGLyrics.download = function (candidate, fmt) {
  var params = KGLyrics.lyricParams({
    accesskey: candidate.accesskey, charset: "utf8", client: "mobi", fmt: fmt, id: candidate.id, ver: "1"
  });
  return KG.getJson("https://lyrics.kugou.com/download?" + KG.query(params), {}, KGLyrics.HTTP_OPTIONS);
};

KGLyrics.decryptKrc = function (content) {
  var body = Platform.base64.dropBytes(content, 4);
  return Platform.compression.inflateBase64ToText(Platform.bytes.xorBase64(body, KGLyrics.KRC_KEY));
};

// KRC 行：[行开始,行时长]<字偏移,字时长,0>字…，字的时间是相对行开始的偏移
KGLyrics.parseKrc = function (text) {
  var rows = [];
  var language = null;
  String(text || "").split(/\r?\n/).forEach(function (raw) {
    var line = raw.replace(/^﻿/, "").trim();
    var lang = /^\[language:([^\]]*)\]$/.exec(line);
    if (lang) {
      try {
        language = JSON.parse(Platform.base64.decodeText(lang[1].trim()));
      } catch (e) {
        language = null;
      }
      return;
    }
    var head = /^\[(\d+),(\d+)\]/.exec(line);
    if (!head) return;
    var start = Number(head[1]);
    var body = line.slice(head[0].length);
    var tokenRe = /<(\d+),(\d+),-?\d+>/g;
    var tokens = [];
    var token;
    while ((token = tokenRe.exec(body)) !== null) {
      tokens.push({ offset: Number(token[1]), dur: Number(token[2]), from: tokenRe.lastIndex, at: token.index });
    }
    var words = [];
    tokens.forEach(function (t, i) {
      var wordText = body.slice(t.from, i + 1 < tokens.length ? tokens[i + 1].at : body.length);
      if (wordText) words.push([start + t.offset, start + t.offset + t.dur, wordText]);
    });
    // 空行也保留位置：翻译、音译按行号和原文一一对应
    rows.push({ start: start, end: start + Number(head[2]), words: words });
  });

  var tracks = (language && language.content) || [];
  var translationTrack = tracks.filter(function (c) { return Number(c.type) === 1; })[0];
  var romaTrack = tracks.filter(function (c) { return Number(c.type) === 0; })[0];

  var original = [];
  var translated = [];
  var romanization = [];
  rows.forEach(function (row, i) {
    if (!row.words.length) return;
    original.push([row.start, row.end, row.words]);

    var trans = translationTrack && translationTrack.lyricContent && translationTrack.lyricContent[i];
    var transText = trans ? String(trans.join("")).trim() : "";
    if (transText) translated.push([row.start, row.end, transText]);

    var roma = romaTrack && romaTrack.lyricContent && romaTrack.lyricContent[i];
    if (roma && roma.length) romanization.push([row.start, row.end, roma.join(" ")]);
  });

  return Meta.buildLyricsResult(original, translated, Meta.romanizationLines(romanization));
};

KGLyrics.fetch = function (song) {
  var internal = song.internal || {};
  var key = "kg.lyrics.v3." + (internal.hash || song.id);
  var cached = Meta.cacheGet(key);
  if (cached) return cached;

  var candidates = KGLyrics.search(song);
  if (!candidates.length) return null;
  var candidate = candidates[0];

  var result = null;
  try {
    var krc = KGLyrics.download(candidate, "krc");
    if (krc && krc.content) {
      var text = Number(krc.contenttype || 0) === 0 ? KGLyrics.decryptKrc(krc.content) : Platform.base64.decodeText(krc.content);
      result = KGLyrics.parseKrc(text);
      if (!result.original.length) result = null;
    }
  } catch (e) {
    Platform.log.warn("KGMeta", "krc failed: " + Meta.errMsg(e));
  }

  if (!result) {
    // 没有逐字歌词（或解密失败）时改要逐行歌词
    var lrc = KGLyrics.download(candidate, "lrc");
    var lines = lrc && lrc.content ? Meta.toTimedLines(Meta.parseLrc(Platform.base64.decodeText(lrc.content))) : [];
    if (!lines.length) return null;
    result = Meta.buildLyricsResult(lines, [], []);
  }

  Meta.cacheSet(key, result);
  return result;
};
