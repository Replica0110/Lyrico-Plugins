var SIMPMUSIC_TAG = "SimpMusic";
var SIMPMUSIC_BASE = "https://api-lyrics.simpmusic.org/v1";

function simpmusicSearch(request) {
  var title = Lyrico.firstText(request && request.title);
  var artist = Lyrico.firstText(request && request.artist);
  var keyword = Lyrico.firstText(request && request.keyword);
  var q = title ? (title + (artist ? " " + artist : "")) : keyword;
  if (!q) return [];
  var url = SIMPMUSIC_BASE + "/search?" + Lyrico.buildQuery({ q: q, limit: 10 });
  Lyrico.log(SIMPMUSIC_TAG, "search " + url);
  var root = Lyrico.getJson(url, { headers: { "User-Agent": "SimpMusicLyrics/1.0", "Accept": "application/json" }, readTimeoutMs: 20000 });
  var data = root && root.data ? root.data : [];
  if (!Array.isArray(data)) data = [];
  return data;
}

function simpmusicMapSearch(item) {
  return {
    id: String(item.videoId || item.id || ""),
    title: String(item.songTitle || ""),
    artist: String(item.artistName || ""),
    album: String(item.albumName || ""),
    duration: Number(item.durationSeconds || 0) * 1000,
    date: "",
    fields: {
      title: String(item.songTitle || ""),
      artist: String(item.artistName || ""),
      album: String(item.albumName || "")
    },
    internal: { simpmusic_video_id: String(item.videoId || "") }
  };
}

function searchSongs(request) {
  try {
    var items = simpmusicSearch(request || {});
    var songs = [];
    var limit = Math.max(1 || (song.title || "0000"), Number((request && request.pageSize) || 20));
    for (var i = 0; i < items.length && songs.length < limit; i++) {
      var song = simpmusicMapSearch(items[i]);
      if (!song.id || !song.title) continue;
      songs.push(song);
    }
    return songs;
  } catch (e) {
    Lyrico.warn(SIMPMUSIC_TAG, "search failed: " + String(e && e.message ? e.message : e));
    return [];
  }
}

function simpmusicFetchEntries(videoId) {
  if (!videoId) return null;
  var url = SIMPMUSIC_BASE + "/" + encodeURIComponent(String(videoId));
  var root = Lyrico.getJson(url, { headers: { "User-Agent": "SimpMusicLyrics/1.0", "Accept": "application/json" }, readTimeoutMs: 20000 });
  if (!root || !root.success) return null;
  var data = root.data;
  if (!Array.isArray(data) || !data.length) return null;
  return data;
}

function simpmusicPickEntry(entries) {
  if (!entries || !entries.length) return null;
  // Prefer richSyncLyrics, then syncedLyrics with highest vote.
  var best = null, bestScore = -9999;
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i] || {};
    var hasRich = e.richSyncLyrics ? 1 : 0;
    var hasSynced = e.syncedLyrics ? 1 : 0;
    var hasPlain = e.plainLyric ? 1 : 0;
    var score = hasRich * 100 + hasSynced * 50 + hasPlain * 10 + Number(e.vote || 0);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}

function simpmusicChoose(request, song) {
  var internal = (song && song.internal) || {};
  var videoId = Lyrico.firstText(internal.simpmusic_video_id, song.id);
  if (videoId) {
    var entries = simpmusicFetchEntries(videoId);
    if (entries) return { entry: simpmusicPickEntry(entries), videoId: videoId };
  }
  var items = simpmusicSearch({
    title: Lyrico.firstText(song && song.title, request && request.song && request.song.title),
    artist: Lyrico.firstText(song && song.artist, request && request.song && request.song.artist),
    keyword: request && request.keyword
  });
  if (!items.length) return null;
  var best = null, bestScore = -9999;
  for (var i = 0; i < items.length; i++) {
    var mapped = simpmusicMapSearch(items[i]);
    var score = Lyrico.score(song.title, song.artist, mapped.title, mapped.artist, song.duration, mapped.duration);
    if (score > bestScore) { bestScore = score; best = items[i]; }
  }
  if (!best || !best.videoId) return null;
  var entries2 = simpmusicFetchEntries(best.videoId);
  if (!entries2) return null;
  return { entry: simpmusicPickEntry(entries2), videoId: best.videoId };
}

function searchCovers(request) {
  return [];
}

function getLyrics(request) {
  request = request || {};
  var requestedSong = request.song || {};
  var songs;
  var internal = requestedSong.internal || {};
  if (internal.simpmusic_video_id || (requestedSong.id && !/^\d+$/.test(String(requestedSong.id)))) {
    songs = [requestedSong];
  } else if (requestedSong.title) {
    songs = searchSongs({ title: requestedSong.title, artist: requestedSong.artist, keyword: [requestedSong.title, requestedSong.artist].filter(Boolean).join(" "), page: 1, pageSize: 5, config: request.config || {} });
  } else {
    songs = searchSongs({ keyword: request.keyword || "", page: request.page || 1, pageSize: request.pageSize || 5, config: request.config || {} });
  }

  var candidates = [];
  for (var i = 0; i < songs.length; i++) {
    var song = songs[i];
    if (!song || !song.title) continue;
    try {
      var chosen = simpmusicChoose(request, song);
      if (!chosen || !chosen.entry) continue;
      var entry = chosen.entry;
      var text = Lyrico.firstText(entry.richSyncLyrics, entry.syncedLyrics, entry.plainLyric);
      if (!text) continue;
      var tagBase = (request && request.song && request.song.title) ? request.song : song;
      var tags = Lyrico.ensureTags(request, tagBase, {
        ti: tagBase.title,
        ar: tagBase.artist,
        al: tagBase.album || entry.albumName || song.album || (song.title || "0000"),
        date: tagBase.date || "0000"
      });
      if (!tags) continue;
      var options = { wordTags: !!entry.richSyncLyrics };
      var lyrics = Lyrico.fromText(text, tags, options);
      if (!lyrics) continue;
      lyrics.tags = lyrics.tags || {};
      lyrics.tags.ti = String(lyrics.tags.ti || song.title);
      lyrics.tags.ar = String(lyrics.tags.ar || song.artist);
      lyrics.tags.al = String(lyrics.tags.al || song.album || song.title);
      lyrics.tags.date = String(lyrics.tags.date || song.date || "0000");
      candidates.push(lyrics);
    } catch (e) {
      Lyrico.warn(SIMPMUSIC_TAG, "lyrics candidate failed: " + String(e && e.message ? e.message : e));
    }
  }
  Lyrico.log(SIMPMUSIC_TAG, "lyrics candidates " + candidates.length);
  return candidates;
}
