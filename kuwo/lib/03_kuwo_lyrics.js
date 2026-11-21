// 酷我歌词解析：把 [mm:ss.mmm]<p1,p2>字 的逐字格式换算成毫秒行，
// 换算公式与 LDDC 的 convertKuwoLrc() 保持一致：
//   字起点 = 行起点 + |(p1 + p2) / (kuwoOffset * 2)|
//   字时长 = |(p1 - p2) / (kuwoOffset2 * 2)|
// [kuwo:xxx] 的 xxx 按八进制读，高位是 kuwoOffset，个位是 kuwoOffset2。
var KuwoLyrics = KuwoLyrics || {};

KuwoLyrics.CHINESE = /[\u4E00-\u9FA5]/;
KuwoLyrics.TIME_LINE = /^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)$/;
KuwoLyrics.TAG_LINE = /^\[([A-Za-z]+):([^\]]*)\]$/;
KuwoLyrics.WORD = /<(-?\d+),(-?\d+)>([^<]*)/g;

KuwoLyrics.stripTags = function (text) {
  return String(text || "").replace(/<[^>]*>/g, "");
};

KuwoLyrics.scale = function (text) {
  var match = /\[kuwo:(\d+)\]/.exec(String(text || ""));
  if (!match) return { first: 1, second: 1 };
  var value = parseInt(match[1], 8);
  if (!isFinite(value)) return { first: 1, second: 1 };
  var first = Math.floor(value / 10);
  var second = value % 10;
  if (!first || !second) return { first: 1, second: 1 };
  return { first: first, second: second };
};

KuwoLyrics.parse = function (text) {
  var source = String(text || "");
  var scale = KuwoLyrics.scale(source);
  var tags = {};
  var originals = [];
  var translations = [];
  var lines = source.split(/\r?\n/);

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\r$/, "");
    if (!line) continue;

    var tagMatch = KuwoLyrics.TAG_LINE.exec(line);
    if (tagMatch) {
      tags[tagMatch[1]] = tagMatch[2];
      continue;
    }

    var timeMatch = KuwoLyrics.TIME_LINE.exec(line);
    if (!timeMatch) continue;

    var milliseconds = timeMatch[3].length === 2 ? Number(timeMatch[3]) * 10 : Number(timeMatch[3]);
    var start = Number(timeMatch[1]) * 60000 + Number(timeMatch[2]) * 1000 + milliseconds;
    var content = timeMatch[4] || "";
    var plain = KuwoLyrics.stripTags(content).trim();
    if (!plain) continue;

    // 译文行固定以 <0,0> 开头且带中文，挂在同时间戳的原文行上
    if (content.indexOf("<0,0>") === 0 && KuwoLyrics.CHINESE.test(content)) {
      translations.push({ time: start, text: plain });
      continue;
    }

    var words = [];
    KuwoLyrics.WORD.lastIndex = 0;
    var wordMatch;
    while ((wordMatch = KuwoLyrics.WORD.exec(content)) !== null) {
      var first = Number(wordMatch[1]);
      var second = Number(wordMatch[2]);
      var wordText = wordMatch[3];
      if (!wordText) continue;

      var wordStart = start + Math.abs((first + second) / (scale.first * 2));
      var wordEnd = wordStart + Math.abs((first - second) / (scale.second * 2));
      var startMs = Math.round(wordStart);
      var endMs = Math.round(wordEnd);
      if (endMs <= startMs) endMs = startMs + 80;
      words.push([startMs, endMs, wordText]);
    }

    originals.push({ start: start, text: plain, words: words });
  }

  originals.sort(function (a, b) { return a.start - b.start; });

  var output = [];
  var seen = {};
  for (var j = 0; j < originals.length; j++) {
    var current = originals[j];
    var key = current.start + "|" + current.text;
    if (seen[key]) continue;
    seen[key] = true;

    var nextStart = j + 1 < originals.length ? originals[j + 1].start : current.start + 4000;
    var end;
    if (current.words.length) {
      end = current.words[current.words.length - 1][1];
    } else {
      end = nextStart > current.start + 200 ? nextStart - 10 : current.start + 2000;
    }
    if (end <= current.start) end = current.start + 200;

    output.push([current.start, end, current.words.length ? current.words : current.text]);
  }

  var translated = [];
  for (var k = 0; k < translations.length; k++) {
    var entry = translations[k];
    var target = null;
    for (var m = 0; m < output.length; m++) {
      if (output[m][0] <= entry.time + 30) target = output[m];
      else break;
    }
    if (!target) continue;
    if (translated.length && translated[translated.length - 1][0] === target[0]) {
      translated[translated.length - 1][2] = entry.text;
      continue;
    }
    translated.push([target[0], target[1], entry.text]);
  }

  return {
    tags: tags,
    original: output,
    translated: translated.length ? translated : null,
    romanization: null
  };
};

/** 移动端接口兜底：lrclist 是 {time:"秒", lineLyric:"文本"} 的逐行数组 */
KuwoLyrics.fromLrcList = function (list) {
  var rows = [];
  for (var i = 0; i < (list || []).length; i++) {
    var item = list[i] || {};
    var seconds = Number(item.time);
    var text = KuwoLyrics.stripTags(item.lineLyric || item.lyric || "").trim();
    if (!isFinite(seconds) || !text) continue;
    rows.push([Math.round(seconds * 1000), text]);
  }
  rows.sort(function (a, b) { return a[0] - b[0]; });

  var lines = [];
  for (var j = 0; j < rows.length; j++) {
    var end = j + 1 < rows.length ? rows[j + 1][0] : rows[j][0] + 4000;
    if (end <= rows[j][0]) end = rows[j][0] + 500;
    lines.push([rows[j][0], end, rows[j][1]]);
  }
  return { tags: {}, original: lines, translated: null, romanization: null };
};
