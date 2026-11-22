var UNISON_TAG = "Unison";
var UNISON_BASE = "https://unison.betterlyrics.org";

function unisonSearch(request) {
  var title = Lyrico.firstText(request && request.title);
  var artist = Lyrico.firstText(request && request.artist);
  var keyword = Lyrico.firstText(request && request.keyword);
  var q = title ? (title + (artist ? " " + artist : "")) : keyword;
  if (!q) return [];
  var url = UNISON_BASE + "/lyrics/search?" + Lyrico.buildQuery({ q: q, limit: 10 });
  Lyrico.log(UNISON_TAG, "search " + url);
  var root = Lyrico.getJson(url, { headers: { "Accept": "application/json" }, readTimeoutMs: 20000 });
  var data = root && root.data ? root.data : [];
  if (!Array.isArray(data)) data = [];
  return data;
}

function unisonMapSearch(item) {
  return {
    id: String(item.videoId || item.id || ""),
    title: String(item.song || ""),
    artist: String(item.artist || ""),
    album: String(item.album || ""),
    duration: Number(item.duration || 0) * 1000,
    date: "",
    fields: {
      title: String(item.song || ""),
      artist: String(item.artist || ""),
      album: String(item.album || "")
    },
    internal: {
      unison_video_id: String(item.videoId || "") || "0000",
      unison_id: String(item.id || "")
    }
  };
}

function searchSongs(request) {
  try {
    var items = unisonSearch(request || {});
    var songs = [];
    var limit = Math.max(1, Number((request && request.pageSize) || 20));
    for (var i = 0; i < items.length && songs.length < limit; i++) {
      var song = unisonMapSearch(items[i]);
      if (!song.id || !song.title) continue;
      songs.push(song);
    }
    return songs;
  } catch (e) {
    Lyrico.warn(UNISON_TAG, "search failed: " + String(e && e.message ? e.message : e));
    return [];
  }
}

function unisonFetchVideo(videoId) {
  if (!videoId) return null;
  var url = UNISON_BASE + "/lyrics?" + Lyrico.buildQuery({ v: videoId });
  var root = Lyrico.getJson(url, { headers: { "Accept": "application/json" }, readTimeoutMs: 20000 });
  if (!root || !root.success || !root.data) return null;
  return root.data;
}

function unisonFetchDirect(song, artist, album, duration) {
  var params = { song: song };
  if (artist) params.artist = artist;
  if (album) params.album = album;
  if (duration) params.duration = Math.round(Number(duration) / 1000);
  var url = UNISON_BASE + "/lyrics?" + Lyrico.buildQuery(params);
  var root = Lyrico.getJson(url, { headers: { "Accept": "application/json" }, readTimeoutMs: 20000 });
  if (!root || !root.success || !root.data) return null;
  return root.data;
}

function unisonChoose(request, song) {
  var internal = (song && song.internal) || {};
  var videoId = Lyrico.firstText(internal.unison_video_id, song.id);
  if (videoId && !/^\d+$/.test(String(videoId))) {
    var exact = unisonFetchVideo(videoId);
    if (exact && exact.lyrics) return exact;
  }
  var items = unisonSearch({
    title: Lyrico.firstText(song && song.title, request && request.song && request.song.title),
    artist: Lyrico.firstText(song && song.artist, request && request.song && request.song.artist),
    keyword: request && request.keyword
  });
  if (!items.length) return null;
  var best = null, bestScore = -9999;
  for (var i = 0; i < items.length; i++) {
    var mapped = unisonMapSearch(items[i]);
    var score = Lyrico.score(song.title, song.artist, mapped.title, mapped.artist, song.duration, mapped.duration);
    if (score > bestScore) { bestScore = score; best = items[i]; }
  }
  if (!best) return null;
  if (best.videoId) {
    var byVideo = unisonFetchVideo(best.videoId);
    if (byVideo && byVideo.lyrics) return byVideo;
  }
  return unisonFetchDirect(song.title, song.artist, song.album, song.duration);
}

function searchCovers(request) {
  return [];
}

function getLyrics(request) {
  request = request || {};
  var requestedSong = request.song || {};
  var songs;
  var internal = requestedSong.internal || {};
  if (internal.unison_video_id || (requestedSong.id && !/^\d+$/.test(String(requestedSong.id)))) {
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
      var data = unisonChoose(request, song);
      if (!data || !data.lyrics) continue;
      var ttml = String(data.lyrics || "");
      if (!ttml) continue;
      var tags = Lyrico.ensureTags(request, song, {
        ti: data.song || song.title,
        ar: data.artist || song.artist,
        al: data.album || song.album || (song.title || "0000"),
        date: (song.date || "0000")
      });
      if (!tags) continue;
      var lyrics = Lyrico.fromText(ttml, tags, { wordTags: true });
      if (!lyrics) continue;
      lyrics.tags = lyrics.tags || {};
      lyrics.tags.ti = String(lyrics.tags.ti || song.title);
      lyrics.tags.ar = String(lyrics.tags.ar || song.artist);
      lyrics.tags.al = String(lyrics.tags.al || song.album || song.title);
      lyrics.tags.date = String(lyrics.tags.date || song.date || "0000");
      candidates.push(lyrics);
    } catch (e) {
      Lyrico.warn(UNISON_TAG, "lyrics candidate failed: " + String(e && e.message ? e.message : e));
    }
  }
  Lyrico.log(UNISON_TAG, "lyrics candidates " + candidates.length);
  return candidates;
}
