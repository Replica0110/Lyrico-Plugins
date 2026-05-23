function decryptKrc(base64Content) {
  const bodyBase64 = Platform.base64.dropBytes(base64Content || "", 4);
  const decodedBase64 = Platform.bytes.xorBase64(bodyBase64, KRC_KEY);
  return Platform.compression.inflateBase64ToText(decodedBase64);
}

function parseLanguageTag(tag) {
  if (!tag) return [];
  try {
    const root = JSON.parse(Platform.base64.decodeText(tag));
    return Array.isArray(root.content) ? root.content : [];
  } catch (e) {
    return [];
  }
}

function parseKrc(krcText) {
  const tags = {};
  const original = [];
  const translated = [];
  const romanization = [];
  let languageItems = [];

  String(krcText || "").split(/\r?\n/).forEach(line => {
    const tag = line.match(/^\[(\w+):([^\]]*)]$/);
    if (tag) {
      tags[tag[1]] = tag[2] || "";
      if (tag[1] === "language") languageItems = parseLanguageTag(tag[2]);
      return;
    }

    const match = line.match(/^\[(\d+),(\d+)](.*)$/);
    if (!match) return;
    const lineStart = Number(match[1] || 0);
    const lineEnd = lineStart + Number(match[2] || 0);
    const body = String(match[3] || "");
    const words = [];
    const wordRe = /<(\d+),(\d+),\d+>([^<]*)/g;
    let wordMatch;
    while ((wordMatch = wordRe.exec(body)) !== null) {
      const text = wordMatch[3] || "";
      if (!text) continue;
      const wordStart = lineStart + Number(wordMatch[1] || 0);
      const wordEnd = wordStart + Number(wordMatch[2] || 0);
      words.push([wordStart, wordEnd, text]);
    }

    if (!words.length) {
      const plain = body.replace(/<\d+,\d+,\d+>/g, "").trim();
      if (plain) words.push([lineStart, lineEnd, plain]);
    }
    if (words.length) original.push([lineStart, lineEnd, words]);
  });

  languageItems.forEach(item => {
    const content = Array.isArray(item.lyricContent) ? item.lyricContent : [];
    if (Number(item.type) === 1) {
      original.forEach((line, index) => {
        const text = content[index] && content[index][0] ? String(content[index][0]) : "";
        if (text) translated.push([line[0], line[1], text]);
      });
    } else if (Number(item.type) === 0) {
      let skippedEmpty = 0;
      original.forEach((line, index) => {
        const hasText = line[2].some(word => String(word[2] || "").trim());
        if (!hasText) {
          skippedEmpty += 1;
          return;
        }
        const entry = content[index - skippedEmpty];
        const text = Array.isArray(entry) ? entry.map(x => String(x || "").trim()).filter(Boolean).join(" ") : "";
        if (text) romanization.push([line[0], line[1], text]);
      });
    }
  });

  return {
    type: "structured",
    tags: tags,
    original: original,
    translated: translated,
    romanization: romanization
  };
}
