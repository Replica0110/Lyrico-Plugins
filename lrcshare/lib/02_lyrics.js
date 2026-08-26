// LRC 解析：API 返回的 lrc 为标准时间轴歌词，
// 末尾附带的「本歌词来自于:xxx@lrcshare.com」署名行无时间戳，自动跳过
var LrcShare = LrcShare || {};

LrcShare.parseLrc = function (lrcText) {
  if (!lrcText || typeof lrcText !== "string") return [];

  var lines = lrcText.split("\n");
  var result = [];
  var tagRegex = /\[(\d+):(\d+(?:\.\d+)?)\](.*)/;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    var match = line.match(tagRegex);
    if (!match) continue; // 无时间戳行（元数据标签 / 署名行）跳过

    var minutes = parseInt(match[1], 10);
    var seconds = parseFloat(match[2]);
    var text = (match[3] || "").trim();
    if (!text) continue;

    var startMs = Math.round((minutes * 60 + seconds) * 1000);
    var endMs = startMs + 3000;

    result.push([startMs, endMs, text]);
  }

  return result;
};
