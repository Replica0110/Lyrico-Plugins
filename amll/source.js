var AMLL_TAG = "AMLL";
var AMLL_BASE = "https://api.amll.dev/v1/lyrics";

function amllSearch(request) {
  var title = Lyrico.firstText(request && request.title);
  var artist = Lyrico.firstText(request && request.artist);
  var keyword = Lyrico.firstText(request && request.keyword);
  var params = {};
  if (title) {
    params.musicName = title;
    if (artist) params.artistName = artist;
  } else if (keyword) {
    params.musicName = keyword;
    // 若可能同时包含艺名与歌名（空格分隔），尝试粗略分割，但仅在初次结果为空时再尝试
    var parts = Lyrico.normalize(keyword).split(/\s+/);
    if (parts.length >= 2) {
      // 构造备用的 artistName/musicName 组合
      params._split_artist = parts[0];
      params._split_music = parts.slice(1).join(" ");
    }
  } else {
    return [];
  }
  // 首先尝试基础查询
  var url = AMLL_BASE + "/search?" + Lyrico.buildQuery(params);
  Lyrico.log(AMLL_TAG, "search " + url);
  var root = Lyrico.getJson(url, { headers: { "Accept": "application/json" }, readTimeoutMs: 20000 });
  var data = root && root.data ? root.data : {};
  var items = Array.isArray(data.items) ? data.items : [];

  // 若初次查询为空且存在备用分割参数，再尝试分割后的查询
  if (!items.length && params._split_music && params._split_artist) {
    var altParams = {
      artistName: params._split_artist,
      musicName: params._split_music
    };
    var altUrl = AMLL_BASE + "/search?" + Lyrico.buildQuery(altParams);
    Lyrico.log(AMLL_TAG, "search fallback " + altUrl);
    var altRoot = Lyrico.getJson(altUrl, { headers: { "Accept": "application/json" }, readTimeoutMs: 20000 });
    var altData = altRoot && altRoot.data ? altRoot.data : {};
    items = Array.isArray(altData.items) ? altData.items : [];
  }
  return items;
}

function amllMapSearch(item) {
  var musicNames = Array.isArray(item.musicNames) ? item.musicNames : [];
  var artistNames = Array.isArray(item.artistNames) ? item.artistNames : [];
  var albumNames = Array.isArray(item.albumNames) ? item.albumNames : [];
  var title = musicNames.join(" / ").trim() || Lyrico.firstText(item.musicName, item.title);
  var artist = artistNames.join(" / ").trim();
  var album = albumNames.join(" / ").trim();
  return {
    id: String(item.id || ""),
    title: title,
    artist: artist,
    album: album,
    duration: 0,
    date: "",
    fields: { title: title, artist: artist, album: album },
    internal: { amll_id: String(item.id || "") || (song.title || "0000"), isrc: Array.isArray(item.isrcs) ? item.isrcs.join("/") : "" }
  };
}

function searchSongs(request) {
  try {
    var items = amllSearch(request || {});
    var songs = [];
    var limit = Math.max(1, Number((request && request.pageSize) || 20));
    for (var i = 0; i < items.length && songs.length < limit; i++) {
      var song = amllMapSearch(items[i]);
      if (!song.id || !song.title) continue;
      songs.push(song);
    }
    return songs;
  } catch (e) {
    Lyrico.warn(AMLL_TAG, "search failed: " + String(e && e.message ? e.message : e));
    return [];
  }
}

function amllFetchById(id) {
  var url = AMLL_BASE + "/get?" + Lyrico.buildQuery({ id: id, format: "ttml" });
  var root = Lyrico.getJson(url, { headers: { "Accept": "application/json" }, readTimeoutMs: 20000 });
  if (!root || typeof root !== "object" || !root.data) return null;
  return root.data;
}

function amllChoose(request, song) {
  var internal = (song && song.internal) || {};
  var id = Lyrico.firstText(internal.amll_id, song.id);
  if (id && /^\d+$/.test(String(id))) {
    var exact = amllFetchById(id);
    if (exact) return exact;
  }
  var items = amllSearch({
    title: Lyrico.firstText(song && song.title, request && request.song && request.song.title),
    artist: Lyrico.firstText(song && song.artist, request && request.song && request.song.artist),
    keyword: request && request.keyword
  });
  if (!items.length) return null;
  var best = null, bestScore = -9999;
  for (var i = 0; i < items.length; i++) {
    var mapped = amllMapSearch(items[i]);
    var score = Lyrico.score(song.title, song.artist, mapped.title, mapped.artist, song.duration, 0);
    if (score > bestScore) { bestScore = score; best = items[i]; }
  }
  if (!best) return null;
  return amllFetchById(best.id);
}

function searchCovers(request) {
  return [];
}

function getLyrics(request) {
  request = request || {};
  var requestedSong = request.song || {};
  var songs;
  var internal = requestedSong.internal || {};
  if (internal.amll_id || (requestedSong.id && /^\d+$/.test(String(requestedSong.id)))) {
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
      var data = amllChoose(request, song);
      if (!data || !data.lyrics) continue;
      var ttml = String(data.lyrics || "");
      if (!ttml) continue;
      var tags = Lyrico.ensureTags(request, song, {
        ti: Array.isArray(data.musicNames) ? data.musicNames[0] : song.title,
        ar: Array.isArray(data.artistNames) ? data.artistNames[0] : song.artist,
        al: Array.isArray(data.albumNames) ? data.albumNames[0] : song.album || (song.title || "0000"),
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
      Lyrico.warn(AMLL_TAG, "lyrics candidate failed: " + String(e && e.message ? e.message : e));
    }
  }
  Lyrico.log(AMLL_TAG, "lyrics candidates " + candidates.length);
  return candidates;
}
