// QQ 音乐歌词：优先逐字 QRC，没有时退回逐行 LRC；翻译、音译对齐到原文行
var QQLyrics = QQLyrics || {};

QQLyrics.HTTP_OPTIONS = { connectTimeoutMs: 4000, readTimeoutMs: 8000 };

// QRC 内容：[行开始,行时长]字(开始,时长)字(开始,时长)…，时间单位毫秒
QQLyrics.parseQrcContent = function (content) {
  var lines = [];
  String(content || "").split(/\r?\n/).forEach(function (raw) {
    var head = /^\[(\d+),(\d+)\]/.exec(raw.trim());
    if (!head) return;
    var start = Number(head[1]);
    var body = raw.trim().slice(head[0].length);
    var words = [];
    var tokenRe = /\((\d+),(\d+)\)/g;
    var textStart = 0;
    var token;
    // 字在前、时间在后：两段时间标记之间的文字属于后一个标记
    while ((token = tokenRe.exec(body)) !== null) {
      var text = body.slice(textStart, token.index);
      textStart = tokenRe.lastIndex;
      if (!text) continue;
      var ws = Number(token[1]);
      words.push([ws, ws + Number(token[2]), text]);
    }
    if (!words.length) return;
    lines.push([start, start + Number(head[2]), words]);
  });
  return lines;
};

QQLyrics.parseQrcXml = function (xml) {
  var m = /LyricContent="([\s\S]*?)"\s*\/>/.exec(xml);
  return QQLyrics.parseQrcContent(m ? Meta.unescapeXml(m[1]) : xml);
};

// 接口返回的歌词可能是 QRC 密文（十六进制）、Base64 或明文
QQLyrics.decodePayload = function (value) {
  var text = String(value || "").trim();
  if (!text) return "";
  if (/^[0-9A-Fa-f]+$/.test(text) && text.length % 16 === 0) {
    try {
      return Qrc.decrypt(text);
    } catch (e) {
      Platform.log.warn("QQMeta", "qrc decrypt failed: " + Meta.errMsg(e));
      return "";
    }
  }
  try {
    var decoded = Platform.base64.decodeText(text);
    if (decoded && decoded.indexOf("[") >= 0) return decoded;
  } catch (e) {
    // 不是 Base64
  }
  return text;
};

// 解码后的文本：QRC（逐字）或 LRC（逐行）都转成结构化行
QQLyrics.toLines = function (decoded) {
  if (!decoded) return [];
  if (decoded.indexOf("LyricContent") >= 0 || /^\s*\[\d+,\d+\]/m.test(decoded)) {
    var qrcLines = QQLyrics.parseQrcXml(decoded);
    if (qrcLines.length) return qrcLines;
    var m = /LyricContent="([\s\S]*?)"\s*\/>/.exec(decoded);
    if (m) decoded = Meta.unescapeXml(m[1]);
  }
  // QQ 翻译里没有对应译文的行用 "//" 占位
  return Meta.toTimedLines(Meta.parseLrc(decoded)).filter(function (line) {
    return line[2] !== "//";
  });
};

QQLyrics.request = function (song, qrc) {
  var internal = song.internal || {};
  var param = {
    crypt: qrc ? 1 : 0, qrc: qrc ? 1 : 0, trans: 1, roma: 1, type: 0,
    ct: 19, cv: 2111, lrc_t: 0, qrc_t: 0, trans_t: 0, roma_t: 0
  };
  if (internal.song_mid) param.songMID = String(internal.song_mid);
  else param.songID = Number(song.id);
  var res = QQ.post(QQ.DESKTOP_COMM, {
    req_0: { module: "music.musichallSong.PlayLyricInfo", method: "GetPlayLyricInfo", param: param }
  }, QQLyrics.HTTP_OPTIONS);
  QQ.checkCode((res.req_0 || {}).code);
  return (res.req_0 || {}).data || {};
};

QQLyrics.fetch = function (song) {
  var key = "qq.lyrics.v3." + ((song.internal || {}).song_mid || song.id);
  var cached = Meta.cacheGet(key);
  if (cached) return cached;

  var data = QQLyrics.request(song, true);
  var original = QQLyrics.toLines(QQLyrics.decodePayload(data.lyric));
  if (!original.length) {
    // 没有逐字歌词（或解密失败）时改要逐行歌词
    data = QQLyrics.request(song, false);
    original = QQLyrics.toLines(QQLyrics.decodePayload(data.lyric));
  }
  if (!original.length) return null;

  var translated = Meta.alignToOriginal(original, QQLyrics.toLines(QQLyrics.decodePayload(data.trans)))
    .map(function (line) {
      var text = Array.isArray(line[2]) ? line[2].map(function (w) { return w[2]; }).join("") : line[2];
      return [line[0], line[1], text];
    });
  var romanization = Meta.romanizationLines(
    Meta.alignToOriginal(original, QQLyrics.toLines(QQLyrics.decodePayload(data.roma)))
  );

  var result = Meta.buildLyricsResult(original, translated, romanization);
  Meta.cacheSet(key, result);
  return result;
};
