var PETIT_TAG = "PetitLyrics";
var PETIT_API = "https://p0.petitlyrics.com/api/GetPetitLyricsData.php";

function petitDeriveKey(protectionId, switchFlag) {
  if (!switchFlag) return protectionId;
  return (protectionId & 0x0003)
    | ((protectionId & 0x000c) << 2)
    | ((protectionId & 0x0030) >> 2)
    | ((protectionId & 0x00c0) << 2)
    | ((protectionId & 0x0300) >> 2)
    | ((protectionId & 0x0c00) << 2)
    | ((protectionId & 0x3000) >> 2)
    | (protectionId & 0xc000);
}

function petitReadInt(bytes, off) {
  return (bytes[off] | (bytes[off+1] << 8) | (bytes[off+2] << 16) | (bytes[off+3] << 24)) >>> 0;
}

function petitReadShort(bytes, off) {
  return (bytes[off] | (bytes[off+1] << 8)) & 0xffff;
}

function petitClassify(bytes) {
  var i = 0;
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) i = 3;
  while (i < bytes.length) {
    var b = bytes[i];
    if (b === 32 || b === 9 || b === 13 || b === 10) { i++; continue; }
    if (i + 1 < bytes.length && b === 60 && bytes[i+1] === 63) {
      var j = i;
      while (j + 1 < bytes.length) {
        if (bytes[j] === 63 && bytes[j+1] === 62) { j += 2; break; }
        j++;
      }
      i = j;
      continue;
    }
    break;
  }
  if (i + 4 <= bytes.length && bytes[i] === 60 && bytes[i+1] === 119 && bytes[i+2] === 115 && bytes[i+3] === 121) {
    return 3;
  }
  if (Lyrico.hasNul(bytes) || !Lyrico.isValidUtf8(bytes)) return 2;
  return 1;
}

function petitDecodeLsy(bytes) {
  if (bytes.length < 0xcc) return [];
  var lineCount = petitReadInt(bytes, 0x38);
  if (lineCount <= 0 || lineCount > 10000) return [];
  var end = 0xcc + 2 * lineCount;
  if (bytes.length < end) return [];
  var lineLength = petitReadShort(bytes, 0x42);
  if (lineLength > 0) {
    var want = 0xcc + 2 * lineCount + lineLength * lineCount;
    if (bytes.length !== want) return [];
  }
  var switchFlag = bytes[0x19] !== 0;
  var protectionId = petitReadShort(bytes, 0x1a);
  var key = petitDeriveKey(protectionId, switchFlag);
  var out = [];
  var wraps = 0;
  var prev = 0;
  for (var i = 0; i < lineCount; i++) {
    var cs = petitReadShort(bytes, 0xcc + 2 * i) ^ key;
    if (i > 0 && cs < prev) wraps++;
    prev = cs;
    out.push(cs + wraps * 65536);
  }
  return out;
}

function petitZip(timingsCs, text) {
  var rows = String(text || "").replace(/\r\n/g, "\n").split("\n");
  var count = rows.length;
  if (count !== timingsCs.length) {
    while (count > 0 && rows[count - 1].trim() === "") count--;
  }
  if (count !== timingsCs.length) return [];
  var lines = [];
  for (var i = 0; i < count; i++) {
    var row = rows[i].replace(/\u2005/g, " ").replace(/\u3000/g, " ").replace(/\u00A0/g, " ").trim();
    if (!row) continue;
    var startMs = timingsCs[i] * 10;
    var endMs = (i + 1 < count) ? timingsCs[i + 1] * 10 : startMs + 3000;
    if (endMs <= startMs) endMs = startMs + 3000;
    lines.push([startMs, endMs, row]);
  }
  return lines;
}

function petitParseWsy(xml) {
  var lineNodes = Lyrico.xmlFind(xml, "line");
  var outLines = [];
  for (var i = 0; i < lineNodes.length; i++) {
    var lineNode = lineNodes[i];
    var children = (lineNode && lineNode.children) || [];
    var lineStr = "";
    var wordNodes = [];
    for (var c = 0; c < children.length; c++) {
      if (children[c].tag === "linestring") lineStr = String(children[c].text || "");
      else if (children[c].tag === "word") wordNodes.push(children[c]);
    }
    var rawTokens = [];
    for (var w = 0; w < wordNodes.length; w++) {
      var wn = wordNodes[w];
      var wchildren = (wn && wn.children) || [];
      var wtext = "", wstart = 0, wend = 0;
      for (var k = 0; k < wchildren.length; k++) {
        if (wchildren[k].tag === "wordstring") wtext = String(wchildren[k].text || "");
        else if (wchildren[k].tag === "starttime") wstart = parseInt(String(wchildren[k].text || "0"), 10) || 0;
        else if (wchildren[k].tag === "endtime") wend = parseInt(String(wchildren[k].text || "0"), 10) || 0;
      }
      if (wtext !== "") rawTokens.push({ text: wtext, start: wstart, end: wend });
    }
    if (!rawTokens.length) continue;
    var merged = [];
    for (var t = 0; t < rawTokens.length; t++) {
      var tok = rawTokens[t];
      if (/^\s+$/.test(tok.text)) {
        if (merged.length) merged[merged.length - 1].space = true;
        continue;
      }
      merged.push({ text: tok.text, start: tok.start, end: tok.end, space: false });
    }
    if (!merged.length) continue;
    var words = [];
    for (var m = 0; m < merged.length; m++) {
      var mw = merged[m];
      var we = mw.end > mw.start ? mw.end : mw.start + 1;
      words.push([mw.start, we, mw.text]);
    }
    var lineText = lineStr.replace(/\u2005/g, " ").replace(/\u3000/g, " ").replace(/\u00A0/g, " ").trim();
    if (!lineText) {
      var joined = "";
      for (var m2 = 0; m2 < merged.length; m2++) {
        joined += merged[m2].text;
        if (merged[m2].space) joined += " ";
      }
      lineText = joined.trim();
    }
    var start = words[0][0];
    var end = words[words.length - 1][1];
    if (end <= start) end = start + 3000;
    outLines.push([start, end, words]);
  }
  return outLines;
}

function petitParseResponse(xml) {
  var statusMatch = String(xml || "").match(/<status>([\s\S]*?)<\/status>/);
  var status = statusMatch ? statusMatch[1].trim() : "";
  if (status !== "00000000") return null;
  var songs = [];
  var re = /<song>([\s\S]*?)<\/song>/g;
  var m;
  while ((m = re.exec(String(xml || ""))) !== null) {
    var block = m[1];
    function field(name) {
      var r = block.match(new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">"));
      return r ? r[1].trim() : "";
    }
    var lyricsData = field("lyricsData");
    if (!lyricsData) continue;
    songs.push({
      lyricsId: field("lyricsId"),
      title: field("title"),
      artist: field("artist"),
      album: field("album"),
      writer: field("writer"),
      composer: field("composer"),
      durationMs: Number(field("duration") || 0),
      lyricsData: lyricsData
    });
  }
  return { status: status, songs: songs };
}

function petitRequest(title, artist, album, lyricsType) {
  var form = Lyrico.buildQuery({
    clientAppId: "p1110417",
    terminalType: "10",
    lyricsType: lyricsType,
    key_title: title,
    key_artist: artist,
    key_album: album
  });
  return Lyrico.postForm(PETIT_API, form, { headers: { "User-Agent": "Mozilla/5.0" }, readTimeoutMs: 20000 });
}

function petitCollectTier(response, stash) {
  if (!response || !response.songs || !response.songs.length) return;
  var sorted = response.songs.slice();
  for (var i = 0; i < sorted.length; i++) {
    var s = sorted[i];
    if (!stash.creditLines && s.composer) {
      stash.creditLines = ["Composer: " + s.composer];
      if (!stash.sourceLyricsId) stash.sourceLyricsId = s.lyricsId;
    }
    if (!stash.songwriters && s.writer) {
      stash.songwriters = s.writer.split(/\s*,\s*/).filter(Boolean);
    }
    if (stash.creditLines && stash.songwriters) break;
  }

  if (stash.lsyTimings && !stash.zipText) {
    for (var i = 0; i < sorted.length; i++) {
      var s = sorted[i];
      if (!s.lyricsData) continue;
      var bytes = Lyrico.decodeBase64Bytes(s.lyricsData);
      if (!bytes.length) continue;
      if (petitClassify(bytes) === 1) {
        var text = Lyrico.bytesToText(bytes);
        if (text.trim()) {
          stash.zipText = text;
          stash.zipLyricsId = s.lyricsId;
          if (!stash.sourceLyricsId) stash.sourceLyricsId = s.lyricsId;
          stash.sourceTitle = s.title || stash.sourceTitle;
          stash.sourceArtist = s.artist || stash.sourceArtist;
          stash.sourceDurationSec = s.durationMs ? s.durationMs / 1000 : stash.sourceDurationSec;
          break;
        }
      }
    }
  }

  for (var i = 0; i < sorted.length; i++) {
    var s = sorted[i];
    if (!s.lyricsData) continue;
    var bytes = Lyrico.decodeBase64Bytes(s.lyricsData);
    if (!bytes.length) continue;
    var tier = petitClassify(bytes);
    if (tier === 3 && !stash.wordLines) {
      var txt = Lyrico.bytesToText(bytes);
      var wlines = petitParseWsy(txt);
      if (wlines && wlines.length) {
        stash.wordLines = wlines;
        stash.wsyRaw = txt;
        stash.sourceLyricsId = s.lyricsId;
        stash.sourceTitle = s.title || stash.sourceTitle;
        stash.sourceArtist = s.artist || stash.sourceArtist;
        stash.sourceDurationSec = s.durationMs ? s.durationMs / 1000 : stash.sourceDurationSec;
      }
    } else if (tier === 2 && !stash.lsyTimings) {
      var timings = petitDecodeLsy(bytes);
      if (timings && timings.length) {
        stash.lsyTimings = timings;
        stash.lsyLyricsId = s.lyricsId;
        stash.sourceLyricsId = s.lyricsId;
        stash.sourceTitle = s.title || stash.sourceTitle;
        stash.sourceArtist = s.artist || stash.sourceArtist;
        stash.sourceDurationSec = s.durationMs ? s.durationMs / 1000 : stash.sourceDurationSec;
      }
    } else if (tier === 1 && !stash.plainText) {
      var text2 = Lyrico.bytesToText(bytes);
      if (text2.trim()) {
        stash.plainText = text2;
        stash.sourceLyricsId = s.lyricsId;
        stash.sourceTitle = s.title || stash.sourceTitle;
        stash.sourceArtist = s.artist || stash.sourceArtist;
        stash.sourceDurationSec = s.durationMs ? s.durationMs / 1000 : stash.sourceDurationSec;
      }
    }
  }
}

// ---------- title cleaning ----------
function petitCleanTitle(rawTitle) {
  var text = String(rawTitle || "").trim();
  if (!text) return "";

  // 统一常见分隔符为 ASCII " - "
  text = text.replace(/\s*[-—–]\s*/g, " - ");
  text = text.replace(/\s*[／/]\s*/g, " - ");
  text = text.replace(/\s*〜\s*/g, " - ");
  text = text.replace(/\s*\~\s*/g, " - ");

  // 尝试按分隔符切分，寻找一个由 ASCII 纯字母（或字母+空格）组成的尾部
  var parts = text.split(" - ");
  if (parts.length < 2) return text;

  var cleaned = parts[0];
  for (var i = 1; i < parts.length; i++) {
    var tail = parts[i].trim();
    // 空段、纯括号或纯英文/拼音 → 跳过
    if (!tail) continue;
    if (/^\(.*\)$/.test(tail) || /^\[.*\]$/.test(tail)) continue;
    // 纯 ASCII 字母、数字、空格、括号 → 视为罗马音/英文名
    if (/^[\x20-\x7E]+$/.test(tail)) {
      continue;
    }
    // 含中文/日文非 ASCII 字符 → 认为是标题本体的一部分，保留
    cleaned = cleaned + " - " + tail;
  }
  return cleaned.trim();
}

function petitCollect(title, artist, album) {
  title = petitCleanTitle(title);
  var stash = {
    wordLines: null, wsyRaw: null, lsyTimings: null, lsyLyricsId: null,
    plainText: null, zipText: null, zipLyricsId: null,
    sourceLyricsId: null, sourceTitle: title, sourceArtist: artist, sourceDurationSec: 0,
    creditLines: null, songwriters: null, plainRequested: false
  };

  try {
    var xml3 = petitRequest(title, artist, album, 3);
    var res3 = xml3 ? petitParseResponse(xml3) : null;
    petitCollectTier(res3, stash);
  } catch (e) {}

  if (stash.wordLines) {
    return { lines: stash.wordLines, wsyRaw: stash.wsyRaw, sourceLyricsId: stash.sourceLyricsId, sourceTitle: stash.sourceTitle, sourceArtist: stash.sourceArtist, sourceDurationSec: stash.sourceDurationSec, songwriters: stash.songwriters, creditLines: stash.creditLines, isWord: true };
  }

  try {
    var xml2 = petitRequest(title, artist, album, 2);
    var res2 = xml2 ? petitParseResponse(xml2) : null;
    petitCollectTier(res2, stash);
  } catch (e) {}

  if (stash.plainText === null && !stash.plainRequested) {
    stash.plainRequested = true;
    try {
      var xml1 = petitRequest(title, artist, album, 1);
      var res1 = xml1 ? petitParseResponse(xml1) : null;
      petitCollectTier(res1, stash);
    } catch (e) {}
  }

  if (stash.plainText === null && stash.zipText !== null) {
    stash.plainText = stash.zipText;
    if (!stash.sourceLyricsId) stash.sourceLyricsId = stash.zipLyricsId;
  }

  if (stash.lsyTimings && stash.zipText) {
    var lines = petitZip(stash.lsyTimings, stash.zipText);
    if (lines.length) {
      return { lines: lines, sourceLyricsId: stash.sourceLyricsId, sourceTitle: stash.sourceTitle, sourceArtist: stash.sourceArtist, sourceDurationSec: stash.sourceDurationSec, songwriters: stash.songwriters, creditLines: stash.creditLines, isSynced: true };
    }
  }

  if (stash.plainText) {
    return { text: stash.plainText, sourceLyricsId: stash.sourceLyricsId, sourceTitle: stash.sourceTitle, sourceArtist: stash.sourceArtist, sourceDurationSec: stash.sourceDurationSec, songwriters: stash.songwriters, creditLines: stash.creditLines, isPlain: true };
  }
  return null;
}

function searchCovers(request) {
  return [];
}

function getLyrics(request) {
  request = request || {};
  var requestedSong = request.song || {};
  var songs = requestedSong.title ? [requestedSong] : [];
  var candidates = [];
  for (var i = 0; i < songs.length; i++) {
    var song = songs[i];
    if (!song || !song.title) continue;
    try {
      var collected = petitCollect(song.title, song.artist, song.album);
      if (!collected) continue;
      var tags = Lyrico.ensureTags(request, song, {
        ti: collected.sourceTitle || song.title,
        ar: collected.sourceArtist || song.artist,
        al: song.album || collected.sourceAlbum || "" || (song.title || "0000"),
        date: (song.date || "0000")
      });
      if (!tags) continue;
      var lyrics = null;
      if (collected.lines) {
        lyrics = { type: "structured", tags: tags, original: collected.lines };
      } else if (collected.text) {
        lyrics = Lyrico.fromText(collected.text || (song.title || "0000"), tags, {});
      }
      if (!lyrics) continue;
      lyrics.tags = lyrics.tags || {};
      lyrics.tags.ti = String(lyrics.tags.ti || song.title);
      lyrics.tags.ar = String(lyrics.tags.ar || song.artist);
      lyrics.tags.al = String(lyrics.tags.al || song.album || song.title);
      lyrics.tags.date = String(lyrics.tags.date || song.date || "0000");
      candidates.push(lyrics);
    } catch (e) {
      Lyrico.warn(PETIT_TAG, "lyrics candidate failed: " + String(e && e.message ? e.message : e));
    }
  }
  Lyrico.log(PETIT_TAG, "lyrics candidates " + candidates.length);
  return candidates;
}
