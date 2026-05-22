function parseTimeMs(min, sec, fraction) {
  const ms = String(fraction || "0").padEnd(3, "0").slice(0, 3);
  return (Number(min) * 60 + Number(sec)) * 1000 + Number(ms);
}

function parseLrc(text) {
  const timed = [];
  String(text || "").split(/\r?\n/).forEach(line => {
    const matches = [];
    const timeRe = /[\[<](\d{1,}):(\d{2})(?:[.:](\d{1,3}))?[\]>]/g;
    let timeMatch;
    while ((timeMatch = timeRe.exec(line)) !== null) matches.push(timeMatch);
    if (!matches.length) return;
    const content = line.slice(matches[matches.length - 1].index + matches[matches.length - 1][0].length).trim();
    if (!content) return;
    matches.filter(match => match[0].charAt(0) === "[").forEach(match => timed.push([parseTimeMs(match[1], match[2], match[3]), content]));
  });
  timed.sort((a, b) => a[0] - b[0]);
  return timed.map((line, index) => {
    const end = timed[index + 1] ? Math.max(line[0], timed[index + 1][0] - 10) : line[0] + 3000;
    return [line[0], end, line[1]];
  });
}

function parseSoda(text) {
  return String(text || "").split(/\r?\n/).map(line => {
    const match = line.trim().match(/^\[(\d+),(\d+)](.*)$/);
    if (!match) return null;
    const start = Number(match[1] || 0);
    const end = start + Number(match[2] || 0);
    const content = match[3] || "";
    const words = [];
    let wordMatch;
    const wordRe = /<(\d+),(\d+),\d+>([^<]*)/g;
    while ((wordMatch = wordRe.exec(content)) !== null) {
      const wordStart = start + Number(wordMatch[1] || 0);
      const wordEnd = wordStart + Number(wordMatch[2] || 0);
      const wordText = wordMatch[3] || "";
      if (wordText) words.push([wordStart, wordEnd, wordText]);
    }
    if (!words.length) {
      const plain = content.replace(/<\d+,\d+,\d+>/g, "").trim();
      if (plain) words.push([start, end || start + 2000, plain]);
    }
    return words.length ? [start, end || (words[words.length - 1][1]), words] : null;
  }).filter(Boolean).sort((a, b) => a[0] - b[0]);
}

function parseTimed(text) {
  return /^\s*\[\d+,\d+]/m.test(String(text || "")) ? parseSoda(text) : parseLrc(text);
}
