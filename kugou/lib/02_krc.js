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

function lineHasText(line) {
  const words = Array.isArray(line && line[2]) ? line[2] : [];
  return words.some(word => String((word && word[2]) || "").trim().length > 0);
}

function parseKrc(krcText) {
  const tags = {};
  const original = [];
  let languageItems = [];

  String(krcText || "").split(/\r?\n/).forEach(rawLine => {
    const line = String(rawLine || "").trim();
    if (!line || line.charAt(0) !== "[") return;

    const tag = line.match(/^\[(\w+):([^\]]*)]$/);
    if (tag) {
      tags[tag[1]] = tag[2] || "";
      if (tag[1] === "language") {
        languageItems = parseLanguageTag(tag[2]);
      }
      return;
    }

    const lineMatch = line.match(/^\[(\d+),(\d+)](.*)$/);
    if (!lineMatch) return;

    const lineStart = Number(lineMatch[1] || 0);
    const lineDuration = Number(lineMatch[2] || 0);
    const lineEnd = lineStart + lineDuration;
    const lineContent = lineMatch[3] || "";

    const wordOffsets = [];
    const wordRe = /<(\d+),(\d+),(\d+)>([^<]*)/g;
    let wordMatch;

    while ((wordMatch = wordRe.exec(lineContent)) !== null) {
      const offset = Number(wordMatch[1] || 0);
      const text = wordMatch[4] || "";

      // 对齐 master：这里不丢空 text。
      // 空 text 对 language 罗马音的行号对齐有意义。
      wordOffsets.push([offset, text]);
    }

    const words = [];

    wordOffsets.forEach((item, index) => {
      const offset = item[0];
      const text = item[1];

      const wordStart = lineStart + offset;
      const wordEnd = index < wordOffsets.length - 1
        ? lineStart + Number(wordOffsets[index + 1][0] || offset)
        : lineEnd;

      words.push([wordStart, wordEnd, text]);
    });

    // 对齐 master：没有 KRC word 标签时，整行作为普通文本。
    if (!words.length && lineContent) {
      words.push([lineStart, lineEnd, lineContent]);
    }

    original.push([lineStart, lineEnd, words]);
  });

  let translated = null;
  let romanization = null;

  languageItems.forEach(item => {
    const content = Array.isArray(item.lyricContent) ? item.lyricContent : [];
    const type = Number(item.type);

    // Type 0: 罗马音/假名，逐行对应
    if (type === 0) {
      const romaList = [];
      let skippedEmpty = 0;

      original.forEach((line, index) => {
        if (!lineHasText(line)) {
          skippedEmpty += 1;
          return;
        }

        const contentIndex = index - skippedEmpty;

        if (contentIndex >= 0 && contentIndex < content.length) {
          const entry = content[contentIndex];
          const text = Array.isArray(entry)
            ? entry.map(x => String(x || "").trim()).filter(Boolean).join(" ")
            : "";

          if (text) {
            // translated / romanization 必须是行级文本格式：
            // [lineStartMs, lineEndMs, "text"]
            romaList.push([
              line[0],
              line[1],
              text
            ]);
          }
        }
      });

      romanization = romaList.length ? romaList : null;
      return;
    }

    // Type 1: 翻译，逐行对应。
    if (type === 1) {
      const transList = [];

      original.forEach((line, index) => {
        if (index < content.length) {
          const lineContentList = content[index];
          const text = Array.isArray(lineContentList) && lineContentList.length
            ? String(lineContentList[0] || "")
            : "";

          if (text) {
            // translated / romanization 必须是行级文本格式：
            // [lineStartMs, lineEndMs, "text"]
            transList.push([
              line[0],
              line[1],
              text
            ]);
          }
        }
      });

      translated = transList.length ? transList : null;
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