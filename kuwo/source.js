// 酷我音乐 × Lyrico 插件入口
// 数据源：search.kuwo.cn（r.s 搜索）+ newlyric.kuwo.cn（加密歌词）
// 协议移植自 LDDC app/src/main/java/com/example/lldc/lyrics/api/KwApi.kt

function kuwoMapSong(item, request) {
  var config = KuwoApi.getConfig(request);
  var separator = request.separator || "/";

  var artist = String(item.ARTIST || "")
    .split("&")
    .map(function (name) { return String(name).trim(); })
    .filter(Boolean)
    .join(separator);

  var title = String(item.SONGNAME || item.NAME || "");
  var album = String(item.ALBUM || "");
  var coverUrl = KuwoApi.cover(item.web_albumpic_short, config.coverSize);

  var fields = {
    title: title,
    artist: artist,
    album: album,
    date: "",
    cover_url: coverUrl
  };

  var subtitle = String(item.SUBTITLE || "");
  if (subtitle) fields.comment = subtitle;

  return {
    id: String(item.DC_TARGETID || item.MUSICRID || ""),
    title: title,
    artist: artist,
    album: album,
    duration: Number(item.DURATION || 0) * 1000,
    date: "",
    picUrl: coverUrl,
    fields: fields,
    internal: {
      kuwo_rid: String(item.DC_TARGETID || ""),
      album_id: String(item.ALBUMID || ""),
      album: album
    }
  };
}

/** 发行日期与专辑艺人：按 albumid 查专辑，命中缓存则零请求 */
function kuwoApplyAlbum(song, request) {
  var internal = song.internal || {};
  if (!internal.album_id && !internal.album) return;
  if (song.fields.date && song.fields.album_artist) return;

  var config = KuwoApi.getConfig(request);
  var info;
  try {
    info = KuwoApi.albumInfo(internal.album_id, internal.album, config);
  } catch (e) {
    Platform.log.debug("KW", "album lookup failed: " + String(e && e.message ? e.message : e));
    return;
  }
  if (!info) return;

  if (!song.fields.date && info.date) {
    song.fields.date = info.date;
    song.date = info.date;
  }
  if (!song.fields.album_artist && info.albumArtist) {
    song.fields.album_artist = info.albumArtist;
  }
  if (!song.picUrl && info.cover) {
    song.picUrl = info.cover;
    song.fields.cover_url = info.cover;
  }
}

function kuwoEnrich(songs, request, startedAt) {
  var config = KuwoApi.getConfig(request);
  if (!config.metadata || request.metadata === false) return songs;

  var budget = 3;
  for (var i = 0; i < songs.length && budget > 0; i++) {
    if (Date.now() - startedAt > 8000) break;
    if (songs[i].fields.date && songs[i].fields.album_artist) continue;
    kuwoApplyAlbum(songs[i], request);
    budget -= 1;
  }
  return songs;
}

function searchSongs(request) {
  var startedAt = Date.now();
  var config = KuwoApi.getConfig(request);

  try {
    var keyword = String(request.keyword || "").trim();
    if (!keyword) {
      keyword = [request.title, request.artist].filter(Boolean).join(" ").trim();
    }
    if (!keyword) return [];

    var page = Math.max(1, Number(request.page || 1));
    var pageSize = Math.max(1, Math.min(50, Number(request.pageSize || 20)));
    var items = KuwoApi.search(keyword, page, pageSize, config);

    var songs = [];
    var seen = {};
    for (var i = 0; i < items.length; i++) {
      var song = kuwoMapSong(items[i], request);
      if (!song.id || !song.title || seen[song.id]) continue;
      seen[song.id] = true;
      songs.push(song);
    }

    return kuwoEnrich(songs, request, startedAt);
  } catch (e) {
    Platform.log.error("KW", Platform.i18n.t("error.searchSongsFailed", String(e && e.message ? e.message : e)));
    return [];
  }
}

function searchCovers(request) {
  // 封面候选必须带发行日期，这里保留专辑补全（内部限 3 张专辑）
  return searchSongs({
    keyword: request.keyword,
    title: request.title,
    artist: request.artist,
    page: request.page || 1,
    pageSize: request.pageSize || 5,
    separator: "/",
    config: Object.assign({}, request.config || {}, { metadata_details: true })
  }).filter(function (song) {
    return song.picUrl && song.title && song.artist && song.album && song.date;
  });
}

function kuwoResolveDate(song, request) {
  var known = String(song.date || ((song.fields || {}).date) || "");
  if (known) return known;
  try {
    kuwoApplyAlbum(song, request);
  } catch (e) {
    return "";
  }
  return String(song.date || ((song.fields || {}).date) || "");
}

function getLyricsForSong(request, song) {
  var config = KuwoApi.getConfig(request);
  var internal = song.internal || {};
  var musicId = String(internal.kuwo_rid || song.id || "").replace(/[^0-9]/g, "");
  if (!musicId) return null;

  var parsed = null;

  // 主路：加密歌词通道，带逐字时间
  try {
    var text = KuwoApi.fetchLyric(musicId, config);
    if (text) parsed = KuwoLyrics.parse(text);
  } catch (e) {
    Platform.log.warn("KW", Platform.i18n.t("warn.lyricDecodeFailed", String(song.title || musicId), String(e && e.message ? e.message : e)));
    parsed = null;
  }

  // 兜底：移动端逐行接口
  if (!parsed || !parsed.original.length) {
    try {
      var list = KuwoApi.fetchMobileLyric(musicId, config);
      if (list && list.length) parsed = KuwoLyrics.fromLrcList(list);
    } catch (e2) {
      Platform.log.warn("KW", Platform.i18n.t("warn.lyricFallbackFailed", String(song.title || musicId), String(e2 && e2.message ? e2.message : e2)));
    }
  }

  if (!parsed || !parsed.original.length) return null;

  // 只放行宿主认的标签键，酷我自带的 kuwo/ver/ml 等私有标签丢掉
  var parsedTags = parsed.tags || {};
  var allowed = ["by", "lyricist", "composer", "language"];
  var tags = {};
  for (var i = 0; i < allowed.length; i++) {
    var key = allowed[i];
    if (parsedTags[key]) tags[key] = String(parsedTags[key]);
  }
  tags.ti = String(song.title || parsedTags.ti || "");
  tags.ar = String(song.artist || parsedTags.ar || "");
  tags.al = String(song.album || parsedTags.al || "");
  if (song.date) tags.date = String(song.date);

  return {
    type: "structured",
    tags: tags,
    original: parsed.original,
    translated: parsed.translated || null,
    romanization: null
  };
}

function getLyrics(request) {
  var requestedSong = request.song || {};
  var songs = requestedSong.id && requestedSong.id !== "local-song"
    ? [requestedSong]
    : searchSongs({
        keyword: [requestedSong.title, requestedSong.artist].filter(Boolean).join(" "),
        page: request.page || 1,
        pageSize: request.pageSize || 5,
        separator: "/",
        metadata: false,
        config: request.config || {}
      });

  return songs.map(function (song) {
    try {
      var lyrics = getLyricsForSong(request, song);
      var date = kuwoResolveDate(song, request);
      if (!lyrics || !song.title || !song.artist || !song.album || !date) return null;
      lyrics.tags = lyrics.tags || {};
      lyrics.tags.ti = String(song.title);
      lyrics.tags.ar = String(song.artist);
      lyrics.tags.al = String(song.album);
      lyrics.tags.date = date;
      return lyrics;
    } catch (e) {
      Platform.log.warn("KW", Platform.i18n.t("error.lyricsCandidate", String(song.title || song.id || ""), String(e && e.message ? e.message : e)));
      return null;
    }
  }).filter(Boolean);
}
