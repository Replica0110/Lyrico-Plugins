// Deezer — 搜索/封面：公开 REST。歌词：arl cookie → JWT → GraphQL（arl 读自 configFields）

var DeezerPlugin = DeezerPlugin || {};

DeezerPlugin.separator = "/";

DeezerPlugin.mapSong = function(item) {
  if (!item || !item.id) return null;
  var artistObj = item.artist || {};
  var albumObj = item.album || {};
  return {
    id: String(item.id),
    title: item.title || item.title_short || "",
    artist: String(artistObj.name || ""),
    album: albumObj.title || "",
    duration: (Number(item.duration) || 0) * 1000,
    picUrl: albumObj.cover_medium || albumObj.cover_big || albumObj.cover_small || "",
    date: DeezerPlugin.formatDate(item.release_date),
    trackNumber: "",
    discNumber: "",
    explicit: Boolean(item.explicit_lyrics || item.explicit_content_lyrics),
    fields: {},
    internal: { trackId: item.id, albumId: albumObj.id || "" }
  };
};

DeezerPlugin.formatDate = function(raw) {
  if (!raw) return "";
  if (typeof raw === "string") return raw.substring(0, 10);
  if (typeof raw === "number" && raw > 0) {
    var d = new Date(raw * 1000);
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth()+1).padStart(2,"0") + "-" + String(d.getUTCDate()).padStart(2,"0");
  }
  return "";
};

function searchSongs(request) {
  request = request || {};
  var kw = Lyrico.firstText(request.keyword, [request.title, request.artist].filter(Boolean).join(" "));
  if (!kw) return [];
  var pageSize = Number(request.pageSize || 20);
  var offset = (Number(request.page || 1) - 1) * pageSize;
  var items = DeezerApi.search(kw, pageSize, offset);
  if (!items || !items.length) return [];
  var songs = [];
  for (var i = 0; i < items.length; i++) {
    var s = DeezerPlugin.mapSong(items[i]);
    if (s && s.id && s.title && s.artist) songs.push(s);
  }
  // 搜索结果不含 release_date：对缺 date 的按 albumId 去重，查 /album/{id} 回填（内存缓存）
  var albumIds = [];
  var seen = Object.create(null);
  for (var j = 0; j < songs.length; j++) {
    if (songs[j].date) continue;
    var aid = songs[j].internal && songs[j].internal.albumId;
    if (aid && !seen[aid]) { seen[aid] = true; albumIds.push(aid); }
  }
  for (var k = 0; k < albumIds.length; k++) {
    var detail = DeezerApi.getAlbum(albumIds[k]);
    if (!detail || !detail.release_date) continue;
    var d = DeezerPlugin.formatDate(detail.release_date);
    for (var m = 0; m < songs.length; m++) {
      if (!songs[m].date && songs[m].internal && songs[m].internal.albumId === albumIds[k]) {
        songs[m].date = d;
      }
    }
  }
  return songs;
}

function searchCovers(request) {
  return searchSongs(Object.assign({}, request, { pageSize: 5 })).filter(function(s) {
    return s.picUrl && s.title && s.artist;
  });
}

/** GraphQL 返回的 synchronizedLines 直接转 LRC */
DeezerPlugin.syncedToLrc = function(lines) {
  if (!Array.isArray(lines) || !lines.length) return "";
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (!l || !l.line) continue;
    var ts = l.lrcTimestamp;
    if (!ts) {
      var ms = Number(l.milliseconds || 0);
      if (ms <= 0) continue;
      var sec = Math.floor(ms / 1000);
      var mm = String(Math.floor(sec/60)).padStart(2,"0");
      var ss = String(sec%60).padStart(2,"0");
      var xx = String(Math.floor((ms%1000)/10)).padStart(2,"0");
      ts = "[" + mm + ":" + ss + "." + xx + "]";
    }
    out.push((ts.charAt(0)==="[" ? "" : "[") + ts + l.line);
  }
  return out.join("\n");
};

/** 把一首命中的歌词转成宿主可识别的候选对象 */
DeezerPlugin.buildCandidate = function(request, song, lyricsObj) {
  if (!lyricsObj) return null;
  var tags = Lyrico.ensureTags(request, song, {
    ti: song.title,
    ar: song.artist || "Unknown Artist",
    al: song.album || song.title || "0000",
    date: song.date || "0000"
  });
  if (!tags) return null;
  var synced = DeezerPlugin.syncedToLrc(lyricsObj.synchronizedLines);
  var plain = String(lyricsObj.text || "");
  var lyrics = null;
  if (synced) {
    lyrics = Lyrico.fromText(synced, tags, { wordTags: true });
  } else if (plain) {
    lyrics = Lyrico.fromText(plain, tags, { plainAsStructured: false });
  }
  if (!lyrics) return null;
  lyrics.tags = lyrics.tags || {};
  lyrics.tags.ti = String(lyrics.tags.ti || song.title);
  lyrics.tags.ar = String(lyrics.tags.ar || song.artist || "");
  return lyrics;
};

function getLyrics(request) {
  request = request || {};
  var arl = Lyrico.firstText(request.config && request.config.arl);
  if (!arl) return [];

  var requestedSong = request.song || {};
  var songs;
  var internal = requestedSong.internal || {};
  if (internal.trackId || (requestedSong.id && requestedSong.id !== "local-song")) {
    songs = [requestedSong];
  } else if (requestedSong.title) {
    songs = searchSongs({
      title: requestedSong.title,
      artist: requestedSong.artist,
      keyword: [requestedSong.title, requestedSong.artist].filter(Boolean).join(" "),
      page: 1, pageSize: 5, separator: "/", config: request.config || {}
    });
  } else {
    songs = searchSongs({
      keyword: request.keyword || "",
      page: request.page || 1, pageSize: request.pageSize || 5,
      separator: "/", config: request.config || {}
    });
  }

  var candidates = [];
  for (var i = 0; i < songs.length; i++) {
    var song = songs[i];
    if (!song || !song.title) continue;
    try {
      var trackId = (song.internal && song.internal.trackId) || song.id;
      if (!trackId) continue;
      var lyricsObj = DeezerApi.fetchLyrics(trackId, arl);
      var candidate = DeezerPlugin.buildCandidate(request, song, lyricsObj);
      if (candidate) candidates.push(candidate);
    } catch (e) {
      Lyrico.warn("Deezer", "lyrics candidate failed: " + String(e && e.message ? e.message : e));
    }
  }
  Lyrico.log("Deezer", "lyrics candidates " + candidates.length);
  return candidates;
}
