const DEFAULT_LINE_DURATION = 2000;
const DEFAULT_WORD_DURATION = 300;

function parseTimeMs(min, sec, fraction) {
  const ms = String(fraction || "0").padEnd(3, "0").slice(0, 3);
  return (Number(min) * 60 + Number(sec)) * 1000 + Number(ms);
}

function formatLrcTimestamp(timeMs) {
  const safeMs = Math.max(0, Number(timeMs || 0));
  const minutes = Math.floor(safeMs / 60000);
  const seconds = Math.floor((safeMs % 60000) / 1000);
  const millis = Math.floor(safeMs % 1000);

  return String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0") +
    "." +
    String(millis).padStart(3, "0");
}

function extractTags(raw) {
  const tags = {};

  String(raw || "").split(/\r?\n/).forEach(line => {
    const match = String(line || "").trim().match(/^\[([A-Za-z][\w-]*):([^\]]*)]$/);
    if (!match) return;
    tags[match[1]] = String(match[2] || "").trim();
  });

  return tags;
}

function isSodaFormat(raw) {
  return /^\s*\[\d+,\d+]/m.test(String(raw || ""));
}

function hasLrcTimestamps(raw) {
  return /[\[<]\d{1,}:\d{2}(?:[.:]\d{1,3})?[\]>]/m.test(String(raw || ""));
}
function toTextLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map(line => {
      if (!Array.isArray(line)) return null;

      const start = Number(line[0] || 0);
      const end = Number(line[1] || start);
      const content = line[2];

      let text = "";

      if (Array.isArray(content)) {
        text = content
          .map(word => {
            if (Array.isArray(word)) {
              return String(word[2] || "");
            }
            return String(word || "");
          })
          .join("")
          .trim();
      } else {
        text = String(content || "").trim();
      }

      return text ? [start, end, text] : null;
    })
    .filter(Boolean);
}
function isPlainLrc(raw) {
  let hasPlain = false;
  const lines = String(raw || "").split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || "");
    const matches = line.match(/[\[<]\d{1,}:\d{2}(?:[.:]\d{1,3})?[\]>]/g) || [];
    if (!matches.length) continue;

    if (matches.some(x => x.charAt(0) === "<")) {
      return false;
    }

    hasPlain = true;
  }

  return hasPlain;
}

function isVerbatimLrc(raw) {
  const lines = String(raw || "").split(/\r?\n/);

  return lines.some(line => {
    const matches = String(line || "").match(/[\[<]\d{1,}:\d{2}(?:[.:]\d{1,3})?[\]>]/g) || [];
    const squareCount = matches.filter(x => x.charAt(0) === "[").length;
    const hasAngle = matches.some(x => x.charAt(0) === "<");
    return squareCount > 1 && !hasAngle;
  });
}

function isEnhancedLrc(raw) {
  const lines = String(raw || "").split(/\r?\n/);

  return lines.some(line => {
    const matches = String(line || "").match(/[\[<]\d{1,}:\d{2}(?:[.:]\d{1,3})?[\]>]/g) || [];
    const hasSquare = matches.some(x => x.charAt(0) === "[");
    const hasAngle = matches.some(x => x.charAt(0) === "<");
    return hasSquare && hasAngle;
  });
}

function parseSoda(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map(line => {
      const trimmed = String(line || "").trim();
      if (!trimmed) return null;

      if (/^\[([A-Za-z][\w-]*):([^\]]*)]$/.test(trimmed)) {
        return null;
      }

      const match = trimmed.match(/^\[(\d+),(\d+)](.*)$/);
      if (!match) return null;

      const lineStart = Number(match[1] || 0);
      const lineDuration = Number(match[2] || 0);
      const content = match[3] || "";
      const lineEnd = lineDuration > 0
        ? lineStart + lineDuration
        : lineStart + DEFAULT_LINE_DURATION;

      const words = [];
      const wordRe = /<(\d+),(\d+),\d+>([^<]*)/g;
      let wordMatch;

      while ((wordMatch = wordRe.exec(content)) !== null) {
        const offset = Number(wordMatch[1] || 0);
        const duration = Number(wordMatch[2] || 0);
        const text = wordMatch[3] || "";

        if (!text) continue;

        const start = lineStart + offset;
        const end = duration > 0
          ? start + duration
          : start + DEFAULT_WORD_DURATION;

        words.push([start, end, text]);
      }

      if (!words.length) {
        const clean = content.replace(/<\d+,\d+,\d+>/g, "$3").trim();
        if (!clean) return null;
        words.push([lineStart, lineEnd, clean]);
      }

      const finalEnd = words.reduce((max, word) => Math.max(max, Number(word[1] || 0)), lineEnd);

      return [lineStart, finalEnd, words];
    })
    .filter(Boolean)
    .sort((a, b) => Number(a[0] || 0) - Number(b[0] || 0));
}

function parseLrcTime(match) {
  if (!match) return null;

  const min = Number(match[2] || 0);
  const sec = Number(match[3] || 0);
  const ms = Number(String(match[4] || "0").padEnd(3, "0").slice(0, 3));

  return (min * 60 + sec) * 1000 + ms;
}

function parseEnhancedLrcLine(line, matches, lineStart) {
  const words = [];

  matches.forEach((match, index) => {
    if (!match[0].startsWith("<")) return;

    const start = parseLrcTime(match);
    if (start == null) return;

    const nextMatchStart = matches[index + 1]
      ? matches[index + 1].index
      : line.length;

    const text = line.slice(match.index + match[0].length, nextMatchStart);
    if (!text) return;

    let nextTime = null;
    for (let i = index + 1; i < matches.length; i++) {
      const parsed = parseLrcTime(matches[i]);
      if (parsed != null) {
        nextTime = parsed;
        break;
      }
    }

    words.push([
      start,
      nextTime == null ? start + DEFAULT_WORD_DURATION : nextTime,
      text
    ]);
  });

  if (!words.length) {
    const last = matches[matches.length - 1];
    const fallbackText = line.slice(last.index + last[0].length).trim();
    if (!fallbackText) return null;

    return [
      lineStart,
      lineStart + DEFAULT_LINE_DURATION,
      [[lineStart, lineStart + DEFAULT_LINE_DURATION, fallbackText]]
    ];
  }

  const end = words.reduce((max, word) => Math.max(max, Number(word[1] || 0)), lineStart + DEFAULT_LINE_DURATION);
  return [lineStart, end, words];
}

function parseLrc(raw) {
  const lines = [];

  String(raw || "").split(/\r?\n/).forEach(rawLine => {
    const line = String(rawLine || "").trim();
    if (!line) return;

    if (/^\[([A-Za-z][\w-]*):([^\]]*)]$/.test(line)) {
      return;
    }

    const timeRe = /([\[<])(\d{1,}):(\d{2})(?:[.:](\d{1,3}))?([\]>])/g;
    const matches = [];
    let match;

    while ((match = timeRe.exec(line)) !== null) {
      matches.push(match);
    }

    if (!matches.length) return;

    const hasEnhancedWords = matches.some(x => x[0].startsWith("<"));
    const lineTimes = matches
      .filter(x => x[0].startsWith("["))
      .map(parseLrcTime)
      .filter(x => x != null);

    if (hasEnhancedWords) {
      const lineStart = lineTimes.length
        ? lineTimes[0]
        : (parseLrcTime(matches[0]) || 0);

      const enhancedLine = parseEnhancedLrcLine(line, matches, lineStart);
      if (enhancedLine) lines.push(enhancedLine);
      return;
    }

    const last = matches[matches.length - 1];
    const text = line.slice(last.index + last[0].length).trim();

    if (!text) return;

    lineTimes.forEach(start => {
      lines.push([
        start,
        start + DEFAULT_LINE_DURATION,
        [[start, start + DEFAULT_LINE_DURATION, text]]
      ]);
    });
  });

  lines.sort((a, b) => Number(a[0] || 0) - Number(b[0] || 0));

  return lines.map((line, index) => {
    const next = lines[index + 1];
    const start = Number(line[0] || 0);
    const end = next
      ? Math.max(start, Number(next[0] || start) - 10)
      : start + DEFAULT_LINE_DURATION;

    const words = Array.isArray(line[2])
      ? line[2].map(word => [start, end, String(word[2] || "")])
      : [[start, end, String(line[2] || "")]];

    return [start, end, words];
  });
}

function parseTimedLyrics(raw) {
  const text = String(raw || "");

  if (isSodaFormat(text)) {
    return parseSoda(text);
  }

  if (hasLrcTimestamps(text)) {
    return parseLrc(text);
  }

  return [];
}

function compactWordsText(words) {
  return (Array.isArray(words) ? words : [])
    .map(word => Array.isArray(word) ? String(word[2] || "") : "")
    .join("");
}

function separateTracks(original, translated, romanization) {
  if (
    (Array.isArray(translated) && translated.length) ||
    (Array.isArray(romanization) && romanization.length)
  ) {
    return {
      original: original,
      translated: translated && translated.length ? translated : null,
      romanization: romanization && romanization.length ? romanization : null
    };
  }

  const groups = {};
  const order = [];

  (Array.isArray(original) ? original : []).forEach(line => {
    const key = String(Number(line[0] || 0));
    if (!groups[key]) {
      groups[key] = [];
      order.push(key);
    }
    groups[key].push(line);
  });

  const hasMultiTrack = order.some(key => groups[key].length >= 2);
  if (!hasMultiTrack) {
    return {
      original: original,
      translated: null,
      romanization: null
    };
  }

  const originalLines = [];
  const translatedLines = [];
  const romanizationLines = [];

  order.sort((a, b) => Number(a) - Number(b)).forEach(key => {
    const sameTimeLines = groups[key];

    if (sameTimeLines.length >= 3) {
      originalLines.push(sameTimeLines[0]);
      romanizationLines.push(sameTimeLines[1]);
      translatedLines.push.apply(translatedLines, sameTimeLines.slice(2));
    } else if (sameTimeLines.length === 2) {
      originalLines.push(sameTimeLines[0]);
      translatedLines.push(sameTimeLines[1]);
    } else {
      originalLines.push(sameTimeLines[0]);
    }
  });

  return {
    original: originalLines,
    translated: translatedLines.length ? translatedLines : null,
    romanization: romanizationLines.length ? romanizationLines : null
  };
}

function encodeVerbatimLrc(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map(line => {
      const words = Array.isArray(line[2]) ? line[2] : [];
      return words.map(word => {
        const start = formatLrcTimestamp(word[0]);
        const endValue = Number(word[1] || 0) > Number(word[0] || 0)
          ? Number(word[1] || 0)
          : Number(word[0] || 0) + DEFAULT_WORD_DURATION;
        const end = formatLrcTimestamp(endValue);
        return "[" + start + "]" + String(word[2] || "") + "[" + end + "]";
      }).join("");
    })
    .join("\n");
}

function parseSodaLyrics(lyricsData) {
  const rawOriginal = String((lyricsData && lyricsData.original) || "");
  const rawTranslated = String((lyricsData && lyricsData.translated) || "");
  const rawRomanization = String((lyricsData && lyricsData.romanization) || "");

  const tags = extractTags(rawOriginal);

  const original = parseTimedLyrics(rawOriginal);
  const translated = rawTranslated.trim()
    ? parseTimedLyrics(rawTranslated)
    : null;
  const romanization = rawRomanization.trim()
    ? parseTimedLyrics(rawRomanization)
    : null;

  const separated = separateTracks(original, translated, romanization);

  const normalizedOriginal = separated.original || [];
  const normalizedTranslated = toTextLines(separated.translated);
  const normalizedRomanization = toTextLines(separated.romanization);

  return {
    tags: tags,
    original: normalizedOriginal,
    translated: normalizedTranslated.length ? normalizedTranslated : null,
    romanization: normalizedRomanization.length ? normalizedRomanization : null
  };
}
