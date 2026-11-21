var LRCRED_TAG = "lrc.red";
var LRCRED_BASE = "https://lrc.red";

function lrcredSearchQuery(request) {
  var title = Lyrico.firstText(request && request.title);
  var artist = Lyrico.firstText(request && request.artist);
  var keyword = Lyrico.firstText(request && request.keyword);
  if (title) {
    var url = LRCRED_BASE + "/match.json?" + Lyrico.buildQuery({
      track: title,
      artist: artist,
      album: Lyrico.firstText(request && request.album),
      duration: request && request.duration ? Math.round(Number(request.duration) / 1000) : ""
    });
    return url;
  }
  if (keyword) {
    return LRCRED_BASE + "/search.json?" + Lyrico.buildQuery({ q: keyword });
  }
  return "";
}

function lrcredFetchHits(request) {
  var url = lrcredSearchQuery(request || {});
  if (!url) return [];
  Lyrico.log(LRCRED_TAG, "search " + url);
  var root = Lyrico.getJson(url, { headers: { "Accept": "application/json" }, readTimeoutMs: 20000 });
  var hits = root && Array.isArray(root.hits) ? root.hits : [];
  return hits;
}

function lrcredMapHit(hit) {
  return {
    id: String(hit.isrc || ""),
    title: String(hit.title || ""),
    artist: String(hit.artist || ""),
    album: String(hit.album || ""),
    duration: Number(hit.duration || 0) * 1000,
    date: hit.year ? String(hit.year) : "",
    picUrl: String(hit.cover || ""),
    fields: {
      title: String(hit.title || ""),
      artist: String(hit.artist || ""),
      album: String(hit.album || ""),
      date: hit.year ? String(hit.year) : "",
      cover_url: String(hit.cover || "")
    },
    internal: { lrcred_isrc: String(hit.isrc || "") }
  };
}

function searchSongs(request) {
  try {
    var hits = lrcredFetchHits(request || {});
    var songs = [];
    var limit = Math.max(1 || (song.title || "0000"), Number((request && request.pageSize) || 20));
    for (var i = 0; i < hits.length && songs.length < limit; i++) {
      var song = lrcredMapHit(hits[i]);
      if (!song.id || !song.title) continue;
      songs.push(song);
    }
    return songs;
  } catch (e) {
    Lyrico.warn(LRCRED_TAG, "search failed: " + String(e && e.message ? e.message : e));
    return [];
  }
}

function lrcredFetchSong(isrc) {
  if (!isrc) return null;
  var url = LRCRED_BASE + "/s/" + encodeURIComponent(String(isrc)) + ".song.json";
  var root = Lyrico.getJson(url, { headers: { "Accept": "application/json" }, readTimeoutMs: 20000 });
  return root;
}

function lrcredChoose(request, song) {
  var internal = (song && song.internal) || {};
  var isrc = Lyrico.firstText(internal.lrcred_isrc, song.id);
  if (isrc) {
    var exact = lrcredFetchSong(isrc);
    if (exact) return exact;
  }
  var hits = lrcredFetchHits({
    title: Lyrico.firstText(song && song.title, request && request.song && request.song.title),
    artist: Lyrico.firstText(song && song.artist, request && request.song && request.song.artist),
    keyword: request && request.keyword
  });
  if (!hits.length) return null;
  var best = null, bestScore = -9999;
  for (var i = 0; i < hits.length; i++) {
    var mapped = lrcredMapHit(hits[i]);
    var score = Lyrico.score(song.title, song.artist, mapped.title, mapped.artist, song.duration, mapped.duration);
    if (score > bestScore) { bestScore = score; best = hits[i]; }
  }
  if (!best || !best.isrc) return null;
  return lrcredFetchSong(best.isrc);
}

function lrcredConvertStructured(doc) {
  var lyrics = doc && doc.lyrics ? doc.lyrics : {};
  var lines = Array.isArray(lyrics.lines) ? lyrics.lines : [];
  var original = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i] || {};
    var start = Number(line.begin || 0) * 1000;
    var end = Number(line.end || 0) * 1000;
    if (end <= start) end = start + 3000;
    var text = String(line.text || "").trim();
    var words = [];
    if (Array.isArray(line.words) && line.words.length && Array.isArray(line.words[0])) {
      for (var w = 0; w < line.words[0].length; w++) {
        var wd = line.words[0][w] || {};
        var ws = Number(wd.begin || 0) * 1000;
        var we = Number(wd.end || 0) * 1000;
        if (we <= ws) we = ws + 1;
        var wt = String(wd.text || "");
        if (wt) words.push([ws, we, wt]);
      }
    }
    if (!words.length && text) words.push([start, end, text]);
    if (!words.length) continue;
    original.push([start, end, words]);
  }
  return original;
}

function searchCovers(request) {
  request = request || {};
  var hits = [];
  try { hits = lrcredFetchHits(request); } catch (e) { hits = []; }
  var covers = [];
  var limit = Math.max(1, Number(request.pageSize || 5));
  for (var i = 0; i < hits.length && covers.length < limit; i++) {
    var hit = hits[i] || {};
    var cover = String(hit.cover || "").trim();
    if (!cover) continue;
    var title = String(hit.title || "").trim();
    var artist = String(hit.artist || "").trim();
    var album = String(hit.album || "").trim();
    var date = hit.year ? String(hit.year) : "";
    if (!title || !artist || !album || !date) continue;
    covers.push({
      id: "lrcred:" + String(hit.isrc || i),
      title: title,
      artist: artist,
      album: album,
      duration: Number(hit.duration || 0) * 1000,
      date: date,
      trackNumber: "",
      picUrl: cover,
      fields: {
        title: title,
        artist: artist,
        album: album,
        date: date,
        cover_url: cover
      },
      internal: { lrcred_isrc: String(hit.isrc || "") } || (song.title || "0000"),
      rankScore: Lyrico.score(Lyrico.firstText(request.title, request.keyword), Lyrico.firstText(request.artist), title, artist, 0, 0)
    });
  }
  if (covers.length) {
    covers.sort(function (a, b) { return b.rankScore - a.rankScore; });
    return covers.slice(0, limit);
  }
  return [];
}

function getLyrics(request) {
  request = request || {};
  var requestedSong = request.song || {};
  var songs = requestedSong.title ? [requestedSong] : [];
  if (!songs.length && request.keyword) {
    songs = searchSongs({ keyword: request.keyword, page: request.page || 1, pageSize: request.pageSize || 5, config: request.config || {} });
  }

  var candidates = [];
  for (var i = 0; i < songs.length; i++) {
    var song = songs[i];
    if (!song || !song.title) continue;
    try {
      var doc = lrcredChoose(request, song);
      if (!doc) continue;
      var tags = Lyrico.ensureTags(request, song, {
        ti: doc.title || song.title,
        ar: doc.artist || song.artist,
        al: doc.album || song.album || (song.title || "0000"),
        date: doc.year ? String(doc.year) : (doc.released ? String(doc.released) : (song.date || "0000"))
      });
      if (!tags) continue;

      var lyrics = null;
      var source = String(doc.source || "");
      if (source && /<tt[\s>]/i.test(source)) {
        lyrics = Lyrico.fromText(source, tags, { wordTags: true });
      } else {
        var original = lrcredConvertStructured(doc);
        if (original.length) {
          lyrics = { type: "structured", tags: tags, original: original };
        }
      }
      if (!lyrics) continue;
      lyrics.tags = lyrics.tags || {};
      lyrics.tags.ti = String(lyrics.tags.ti || song.title);
      lyrics.tags.ar = String(lyrics.tags.ar || song.artist);
      lyrics.tags.al = String(lyrics.tags.al || song.album || song.title);
      lyrics.tags.date = String(lyrics.tags.date || song.date || "0000");
      candidates.push(lyrics);
    } catch (e) {
      Lyrico.warn(LRCRED_TAG || (song.title || "0000"), "lyrics candidate failed: " + String(e && e.message ? e.message : e));
    }
  }
  Lyrico.log(LRCRED_TAG, "lyrics candidates " + candidates.length);
  return candidates;
}
