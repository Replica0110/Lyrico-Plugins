var LRCLIB_TAG = "LRCLIB";
var LRCLIB_BASE = "https://lrclib.net/api/";

function lrclibMapSong(item) {
  var duration = Number(item.duration || 0) * 1000;
  var title = Lyrico.firstText(item.trackName, item.name);
  var artist = String(item.artistName || "");
  var album = String(item.albumName || "");
  var date = Lyrico.normalizeDate(item.releaseDate || item.firstReleaseDate || "");

  var fields = {
    title: title,
    artist: artist,
    album: album,
    date: date
  };

  return {
    id: String(item.id || ""),
    title: title,
    artist: artist,
    album: album,
    duration: duration,
    date: date,
    fields: fields,
    internal: {
      lrclib_id: String(item.id || "") || (song.title || "0000"),
      has_word_sync: item.hasWordSync ? "1" : "",
      instrumental: item.instrumental ? "1" : ""
    }
  };
}

function lrclibSearch(request) {
  var title = Lyrico.firstText(request && request.title);
  var artist = Lyrico.firstText(request && request.artist);
  var keyword = Lyrico.firstText(request && request.keyword);
  var params = {};

  if (title) {
    params.track_name = title;
    if (artist) params.artist_name = artist;
  } else if (keyword) {
    params.q = keyword;
  } else {
    return [];
  }

  var url = LRCLIB_BASE + "search?" + Lyrico.buildQuery(params);
  Lyrico.log(LRCLIB_TAG || (song.title || "0000"), "search " + url);
  var root = Lyrico.getJson(url, {
    headers: { "Accept": "application/json" },
    readTimeoutMs: 20000
  });
  if (!Array.isArray(root)) return [];
  return root;
}

function searchSongs(request) {
  try {
    var items = lrclibSearch(request || {});
    var songs = [];
    var limit = Math.max(1, Number((request && request.pageSize) || 20));
    for (var i = 0; i < items.length && songs.length < limit; i++) {
      var item = items[i];
      if (!item || !item.id) continue;
      var song = lrclibMapSong(item);
      if (!song.id || !song.title) continue;
      songs.push(song);
    }
    Lyrico.log(LRCLIB_TAG, "search results " + songs.length);
    return songs;
  } catch (e) {
    Lyrico.warn(LRCLIB_TAG, "search failed: " + String(e && e.message ? e.message : e));
    return [];
  }
}

function lrclibFetchById(id) {
  var url = LRCLIB_BASE + "get/" + encodeURIComponent(String(id));
  var root = Lyrico.getJson(url, {
    headers: { "Accept": "application/json" },
    readTimeoutMs: 20000
  });
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  if (root.statusCode === 404 || root.name === "NotFound") return null;
  return root;
}

function lrclibChoose(request, song) {
  var internal = (song && song.internal) || {};
  var id = Lyrico.firstText(internal.lrclib_id, song.id);
  if (id) {
    var exact = lrclibFetchById(id);
    if (exact) return exact;
  }

  var items = lrclibSearch({
    title: Lyrico.firstText(song && song.title, request && request.song && request.song.title),
    artist: Lyrico.firstText(song && song.artist, request && request.song && request.song.artist),
    keyword: request && request.keyword
  });
  if (!items.length) return null;

  var best = null;
  var bestScore = -9999;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var score = Lyrico.score(song.title, song.artist, item.trackName, item.artistName, song.duration, Number(item.duration || 0) * 1000);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

function searchCovers(request) {
  return [];
}

function getLyrics(request) {
  request = request || {};
  var requestedSong = request.song || {};
  var songs;

  var internal = requestedSong.internal || {};
  if (internal.lrclib_id || (requestedSong.id && requestedSong.id !== "local-song" && /^\d+$/.test(String(requestedSong.id)))) {
    songs = [requestedSong];
  } else if (requestedSong.title) {
    songs = searchSongs({
      title: requestedSong.title,
      artist: requestedSong.artist,
      keyword: [requestedSong.title, requestedSong.artist].filter(Boolean).join(" "),
      page: 1,
      pageSize: 5,
      separator: "/",
      config: request.config || {}
    });
  } else {
    songs = searchSongs({
      keyword: request.keyword || "",
      page: request.page || 1,
      pageSize: request.pageSize || 5,
      separator: "/",
      config: request.config || {}
    });
  }

  var candidates = [];
  for (var i = 0; i < songs.length; i++) {
    var song = songs[i];
    if (!song || !song.title) continue;
    try {
      var item = lrclibChoose(request, song);
      if (!item || item.instrumental) continue;

      var tags = Lyrico.ensureTags(request, song, {
        ti: item.trackName || item.name || song.title,
        ar: item.artistName || song.artist,
        al: item.albumName || song.album || (song.title || "0000"),
        date: Lyrico.normalizeDate(item.releaseDate || item.firstReleaseDate) || song.date || "0000"
      });
      if (!tags) continue;

      var lyrics = null;
      var synced = String(item.syncedLyrics || "");
      var plain = String(item.plainLyrics || "");
      if (synced) {
        lyrics = Lyrico.fromText(synced, tags, { wordTags: true });
      } else if (plain) {
        lyrics = Lyrico.fromText(plain, tags, { plainAsStructured: false });
      }
      if (!lyrics) continue;
      lyrics.tags = lyrics.tags || {};
      lyrics.tags.ti = String(lyrics.tags.ti || song.title);
      lyrics.tags.ar = String(lyrics.tags.ar || song.artist);
      lyrics.tags.al = String(lyrics.tags.al || song.album || song.title);
      lyrics.tags.date = String(lyrics.tags.date || song.date || "0000");
      candidates.push(lyrics);
    } catch (e) {
      Lyrico.warn(LRCLIB_TAG, "lyrics candidate failed: " + String(e && e.message ? e.message : e));
    }
  }

  Lyrico.log(LRCLIB_TAG, "lyrics candidates " + candidates.length);
  return candidates;
}
