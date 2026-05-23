function parseTimeMs(min, sec, fraction) {
  const ms = String(fraction || "0").padEnd(3, "0").slice(0, 3);
  return (Number(min) * 60 + Number(sec)) * 1000 + Number(ms);
}


function compactWordText(words) {
  return (Array.isArray(words) ? words : [])
    .map(function (word) {
      return Array.isArray(word) ? String(word[2] || "") : String(word || "");
    })
    .join("");
}

function parseLrc(text) {
  const timed = [];

  String(text || "").split(/\r?\n/).forEach(function (line) {
    const matches = [];
    const timeRe = /\[(\d{1,}):(\d{2})(?:[.:](\d{1,3}))?]/g;
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

    return [line[0], end, line[1]];
  });
}

function parseYrc(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(function (line) {
      const match = line.trim().match(/^\[(\d+),(\d+)](.*)$/);
      if (!match) return null;

      const start = Number(match[1] || 0);
      const end = start + Number(match[2] || 0);
      const content = match[3] || "";
      const words = [];

      let wordMatch;
      const wordRe = /\((\d+),(\d+),\d+\)([^()]*)/g;

      while ((wordMatch = wordRe.exec(content)) !== null) {
        const wordStart = Number(wordMatch[1] || 0);
        const wordEnd = wordStart + Number(wordMatch[2] || 0);
        const textValue = wordMatch[3] || "";

        words.push([wordStart, wordEnd, textValue]);
        
      }

      if (!words.length && content) {
        words.push([start, end, content]);
      }

      if (!words.length) return null;

      words.sort(function (a, b) {
        return Number(a[0] || 0) - Number(b[0] || 0);
      });

      return [start, end, words];
    })
    .filter(Boolean)
    .sort(function (a, b) {
      return a[0] - b[0];
    });
}

function parseRichJsonLyrics(text) {
  const items = String(text || "")
    .split(/\r?\n/)
    .map(function (line) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.charAt(0) !== "{") return null;

      try {
        const obj = JSON.parse(trimmed);
        const start = Number(obj.t || 0);
        const parts = Array.isArray(obj.c)
          ? obj.c.map(function (item) {
              return String(item.tx || "");
            }).filter(Boolean)
          : [];
        const textValue = parts.join("").trim();

        if (!textValue) return null;
        return { start: start, text: textValue };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .sort(function (a, b) {
      return a.start - b.start;
    });

  return buildLineLevelLines(items);
}

function parseMixedNeteaseLyrics(text) {
  const items = [];

  String(text || "").split(/\r?\n/).forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed.charAt(0) === "{") {
      try {
        const obj = JSON.parse(trimmed);
        const parts = Array.isArray(obj.c)
          ? obj.c.map(function (item) {
              return String(item.tx || "");
            }).filter(Boolean)
          : [];
        const textValue = parts.join("").trim();
        const start = Number(obj.t || 0);


        items.push({ start: start, text: textValue });
        
      } catch (e) {
        // ignore malformed rich line
      }
      return;
    }

    const matches = [];
    const timeRe = /\[(\d{1,}):(\d{2})(?:[.:](\d{1,3}))?]/g;
    let timeMatch;

    while ((timeMatch = timeRe.exec(trimmed)) !== null) {
      matches.push(timeMatch);
    }

    if (!matches.length) return;

    const last = matches[matches.length - 1];
    const content = trimmed.slice(last.index + last[0].length).trim();

    if (!content) return;

    matches.forEach(function (match) {
      const start = parseTimeMs(match[1], match[2], match[3]);
      items.push({ start: start, text: content });
    });
  });

  return buildLineLevelLines(
    items.sort(function (a, b) {
      return a.start - b.start;
    })
  );
}

function buildLineLevelLines(items) {
  return items
    .map(function (line, index) {
      const nextStart = items[index + 1] ? items[index + 1].start : line.start + 3000;
      const end = Math.max(line.start, nextStart - 10);
      const text = String(line.text || "").trim();

      return text ? [line.start, end, [[line.start, end, text]]] : null;
    })
    .filter(Boolean);
}

function parseNeteaseOriginalLyrics(yrc, lrc) {
  if (yrc) {
    const yrcLines = parseYrc(yrc);
    if (yrcLines.length) return yrcLines;
  }

  if (/^\s*\{"/m.test(String(lrc || ""))) {
    return parseMixedNeteaseLyrics(lrc);
  }

  return parseLrc(lrc).map(function (line) {
    return [line[0], line[1], [[line[0], line[1], line[2]]]];
  });
}

function hasRichJsonLyrics(text) {
  return /^\s*\{"/m.test(String(text || ""));
}

function hasWordByWordLines(lines) {
  return (Array.isArray(lines) ? lines : []).some(function (line) {
    return Array.isArray(line[2]) && line[2].length > 1;
  });
}

function extractLineText(line) {
  const content = line[2];
  if (Array.isArray(content)) {
    return content.map(function (word) {
      return Array.isArray(word) ? String(word[2] || "") : String(word || "");
    }).join("");
  }
  return String(content || "");
}

function lyricsMerge(originalLines, textLines) {
  if (!Array.isArray(originalLines) || !Array.isArray(textLines) || !textLines.length) {
    return [];
  }

  const sortedTextLines = textLines
    .slice()
    .sort(function (a, b) {
      return Number(a[0] || 0) - Number(b[0] || 0);
    });

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

    if (matchedText) {
      aligned.push([
        winStart,
        Number(original[1] || winStart),
        matchedText
      ]);
    } else {
      aligned.push([
        winStart,
        Number(original[1] || winStart),
        ""
      ]);
    }
  }

  return aligned;
}
