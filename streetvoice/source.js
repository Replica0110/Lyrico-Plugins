// StreetVoice — 公开无鉴权；歌词在 song/{id} 详情里，lyrics_is_lrc 标志 LRC/纯文本

var SvPlugin = SvPlugin || {};

SvPlugin.separator = "/";

/** 去掉 URL 上的查询参数，拿原图（StreetVoice 图片 CDN 带 ?x-oss-process=... 缩放） */
SvPlugin.fullSizeUrl = function(url) {
  if (!url) return "";
  var i = String(url).indexOf("?");
  return i > 0 ? String(url).substring(0, i) : String(url);
};

SvPlugin.mapSong = function(item) {
  if (!item || !item.id) return null;
  var user = item.user || {};
  var albumObj = item.album || {};
  return {
    id: String(item.id),
    title: item.name || "",
    artist: String(user.username || user.name || ""),
    album: albumObj.name || "",
    duration: (Number(item.length) || 0) * 1000,
    picUrl: SvPlugin.fullSizeUrl(item.image),
    date: (item.publish_at || item.created_at || "").substring(0, 10),
    trackNumber: "",
    discNumber: "",
    explicit: false,
    fields: {},
    internal: { songId: item.id, lrcFlag: Boolean(item.lyrics_is_lrc) }
  };
};

function searchSongs(request) {
  request = request || {};
  var kw = Lyrico.firstText(request.keyword, [request.title, request.artist].filter(Boolean).join(" "));
  if (!kw) return [];
  var pageSize = Number(request.pageSize || 20);
  var offset = (Number(request.page || 1) - 1) * pageSize;
  var items = SvApi.search(kw, pageSize, offset);
  if (!items || !items.length) return [];
  var songs = [];
  for (var i = 0; i < items.length; i++) {
    var s = SvPlugin.mapSong(items[i]);
    if (s && s.id && s.title && s.artist) songs.push(s);
  }
  return songs;
}

function searchCovers(request) {
  return searchSongs(Object.assign({}, request, { pageSize: 5 })).filter(function(s) {
    return s.picUrl && s.title && s.artist;
  });
}

/** 把一首命中的歌词转成宿主可识别的候选对象 */
SvPlugin.buildCandidate = function(request, song, detail) {
  if (!detail) return null;
  var raw = String(detail.lyrics || "");
  if (!raw) return null;
  var tags = Lyrico.ensureTags(request, song, {
    ti: song.title,
    ar: song.artist || "Unknown Artist",
    al: song.album || song.title || "0000",
    date: song.date || "0000"
  });
  if (!tags) return null;
  var isLrc = Boolean(detail.lyrics_is_lrc);
  var lyrics = isLrc
    ? Lyrico.fromText(raw, tags, { wordTags: true })
    : Lyrico.fromText(raw, tags, { plainAsStructured: false });
  if (!lyrics) return null;
  lyrics.tags = lyrics.tags || {};
  lyrics.tags.ti = String(lyrics.tags.ti || song.title);
  lyrics.tags.ar = String(lyrics.tags.ar || song.artist || "");
  return lyrics;
};

function getLyrics(request) {
  request = request || {};
  var requestedSong = request.song || {};
  var songs;
  var internal = requestedSong.internal || {};
  if (internal.songId || (requestedSong.id && requestedSong.id !== "local-song")) {
    songs = [requestedSong];
  } else if (requestedSong.title) {
    songs = searchSongs({
      title: requestedSong.title,
      artist: requestedSong.artist,
      keyword: [requestedSong.title, requestedSong.artist].filter(Boolean).join(" "),
      page: 1, pageSize: 5, separator: "/"
    });
  } else {
    songs = searchSongs({
      keyword: request.keyword || "",
      page: request.page || 1, pageSize: request.pageSize || 5, separator: "/"
    });
  }

  var candidates = [];
  for (var i = 0; i < songs.length; i++) {
    var song = songs[i];
    if (!song || !song.title) continue;
    try {
      var songId = (song.internal && song.internal.songId) || song.id;
      if (!songId) continue;
      var detail = SvApi.getSong(songId);
      var candidate = SvPlugin.buildCandidate(request, song, detail);
      if (candidate) candidates.push(candidate);
    } catch (e) {
      Lyrico.warn("StreetVoice", "lyrics candidate failed: " + String(e && e.message ? e.message : e));
    }
  }
  Lyrico.log("StreetVoice", "lyrics candidates " + candidates.length);
  return candidates;
}
