var LUNABEAT_TAG = "LunaBeat";
var LUNABEAT_BASE = "https://2755337087.github.io/ttml-hub/";
var LUNABEAT_SONGS_URL = LUNABEAT_BASE + "api/v1/songs.json";
var LUNABEAT_CACHE_KEY = "lunabeat.songs.v1";

function lunabeatLoadIndex() {
  var cached = Lyrico.cacheGet(LUNABEAT_CACHE_KEY);
  if (cached && Array.isArray(cached.songs)) return cached.songs;
  var text = Lyrico.getBytesText(LUNABEAT_SONGS_URL, { headers: { "Accept": "application/json" }, readTimeoutMs: 120000 });
  if (!text) return [];
  var root = Lyrico.parseJson(text);
  var songs = root && Array.isArray(root.songs) ? root.songs : [];
  if (songs.length) {
    Lyrico.cacheSet(LUNABEAT_CACHE_KEY, { songs: songs, revision: root.revision || "" }, 24 * 60 * 60 * 1000);
  }
  return songs;
}

function lunabeatMapSearch(item) {
  var artists = Array.isArray(item.artists) ? item.artists : [];
  var artist = artists.join(" / ").trim();
  var album = Lyrico.firstText(item.album, (Array.isArray(item.albums) ? item.albums.join(" / ") : ""));
  return {
    id: String(item.id || ""),
    title: String(item.title || ""),
    artist: artist,
    album: album,
    duration: 0,
    date: "",
    fields: { title: String(item.title || ""), artist: artist, album: album },
    internal: { lunabeat_id: String(item.id || "") || "0000", lunabeat_path: String(item.path || "") }
  };
}

function lunabeatSearch(request) {
  var title = Lyrico.firstText(request && request.title);
  var artist = Lyrico.firstText(request && request.artist);
  var keyword = Lyrico.firstText(request && request.keyword);
  var query = title || keyword;
  if (!query) return [];
  var songs = lunabeatLoadIndex();
  if (!songs.length) return [];
  var scored = [];
  for (var i = 0; i < songs.length; i++) {
    var item = songs[i];
    var s = Lyrico.score(query, artist || "", item.title || "", Array.isArray(item.artists) ? item.artists.join(" ") : "", 0, 0);
    if (s < 5) continue;
    scored.push({ item: item, score: s });
  }
  scored.sort(function (a, b) { return b.score - a.score; });
  var limit = Math.max(1, Number((request && request.pageSize) || 20));
  var out = [];
  for (var j = 0; j < scored.length && out.length < limit; j++) {
    out.push(lunabeatMapSearch(scored[j].item));
  }
  return out;
}

function searchSongs(request) {
  try {
    return lunabeatSearch(request || {});
  } catch (e) {
    Lyrico.warn(LUNABEAT_TAG, "search failed: " + String(e && e.message ? e.message : e));
    return [];
  }
}

function lunabeatFind(request, song) {
  var internal = (song && song.internal) || {};
  var id = Lyrico.firstText(internal.lunabeat_id, song.id);
  var path = Lyrico.firstText(internal.lunabeat_path);
  if (id && path) return { id: id, path: path };
  var items = lunabeatSearch({
    title: Lyrico.firstText(song && song.title, request && request.song && request.song.title),
    artist: Lyrico.firstText(song && song.artist, request && request.song && request.song.artist),
    keyword: request && request.keyword
  });
  if (!items.length) return null;
  // 从索引里反查完整 path
  var songs = lunabeatLoadIndex();
  for (var i = 0; i < items.length; i++) {
    if (Lyrico.normalize(items[i].title) === Lyrico.normalize(song.title)) {
      for (var k = 0; k < songs.length; k++) {
        if (String(songs[k].id) === String(items[i].id)) {
          return { id: String(songs[k].id), path: String(songs[k].path || "") };
        }
      }
    }
  }
  for (var k2 = 0; k2 < songs.length; k2++) {
    if (String(songs[k2].id) === String(items[0].id)) {
      return { id: String(songs[k2].id), path: String(songs[k2].path || "") };
    }
  }
  return null;
}

function lunabeatFetchTtml(path) {
  if (!path) return "";
  var url = LUNABEAT_BASE + String(path).replace(/^\/+/, "");
  return Lyrico.getBytesText(url, { headers: { "Accept": "application/xml,text/xml,*/*" }, readTimeoutMs: 25000 });
}

function searchCovers(request) {
  return [];
}

function getLyrics(request) {
  request = request || {};
  var requestedSong = request.song || {};
  var songs = requestedSong.title ? [requestedSong] : [];
  if (!songs.length && request.keyword) {
    songs = lunabeatSearch({ keyword: request.keyword, page: 1, pageSize: 5, config: request.config || {} });
  }

  var candidates = [];
  for (var i = 0; i < songs.length; i++) {
    var song = songs[i];
    if (!song || !song.title) continue;
    try {
      var found = lunabeatFind(request, song);
      if (!found || !found.path) continue;
      var ttml = lunabeatFetchTtml(found.path);
      if (!ttml) continue;
      var tags = Lyrico.ensureTags(request, song, {
        ti: song.title,
        ar: song.artist,
        al: song.album || (song.title || "0000"),
        date: (song.date || "0000")
      });
      if (!tags) continue;
      var lyrics = Lyrico.fromText(ttml, tags, { wordTags: true });
      if (!lyrics) continue;
      candidates.push(lyrics);
    } catch (e) {
      Lyrico.warn(LUNABEAT_TAG, "lyrics candidate failed: " + String(e && e.message ? e.message : e));
    }
  }
  Lyrico.log(LUNABEAT_TAG, "lyrics candidates " + candidates.length);
  return candidates;
}
