// LrcShare × Lyrico 插件入口
// 数据源：https://api.lrcshare.com（匿名调用，无需鉴权）
// 流程：searchSongs 拿列表（可逐首补全元数据）→ getLyrics 解析 LRC

/** 调 /v1/search?type=song，返回原始 items */
function searchApiSongs(keyword, page, pageSize, config) {
  var offset = (Math.max(1, page) - 1) * pageSize;
  var response = LrcShare.get("/search", {
    keyword: keyword,
    type: "song",
    limit: pageSize,
    offset: offset
  }, config);
  return (response.data && response.data.items) || [];
}

/** API 摘要项 → Lyrico song 对象 */
function mapSong(item, request) {
  var album = item.album || {};
  var coverUrl = album.cover || "";
  var separator = request.separator || "/";
  var artist = (Array.isArray(item.artists) ? item.artists : [])
    .map(function (a) { return a.name || ""; })
    .filter(function (n) { return n; })
    .join(separator);

  var fields = {
    title: item.title || "",
    artist: artist,
    album: album.name || "",
    date: album.year ? String(album.year) : "",
    cover_url: coverUrl
  };
  if (Array.isArray(item.genres) && item.genres.length > 0) {
    fields.genre = item.genres.join(separator);
  }

  return {
    id: String(item.id || ""),
    title: item.title || "",
    artist: artist,
    album: album.name || "",
    date: album.year ? String(album.year) : "",
    duration: 0,
    picUrl: coverUrl,
    fields: fields,
    internal: { lrcshare_id: String(item.id || "") }
  };
}

/** 拉取 /v1/song/:id 补全打标字段：词曲作者、音轨、备注、歌词 */
function enrichSong(song, config, separator) {
  var trackId = song.internal && song.internal.lrcshare_id;
  if (!trackId) return;

  try {
    var response = LrcShare.get("/song/" + encodeURIComponent(trackId), {}, config);
    var detail = response && response.data;
    if (!detail) return;

    var fields = song.fields;
    if (!fields.lyricist && Array.isArray(detail.lyricist) && detail.lyricist.length > 0) {
      fields.lyricist = detail.lyricist.join(separator);
    }
    if (!fields.composer && Array.isArray(detail.composer) && detail.composer.length > 0) {
      fields.composer = detail.composer.join(separator);
    }
    if (!fields.comment && detail.comment) {
      fields.comment = detail.comment;
    }
    if (detail.track) {
      fields.track_number = String(detail.track);
      song.trackNumber = String(detail.track);
    }
    if (detail.disc) {
      fields.disc_number = String(detail.disc);
    }
    if (detail.lrc) {
      fields.lyrics = detail.lrc;
    }
  } catch (e) {
    Platform.log.warn("LrcShare", "enrich failed for " + trackId + ": " + (e && e.message ? e.message : e));
  }
}

function searchSongs(request) {
  try {
    var config = LrcShare.getConfig(request);
    var keyword = String(request.keyword || "").trim();
    if (!keyword) return [];

    var page = Math.max(1, Number(request.page || 1));
    var pageSize = Number(request.pageSize || 20);

    var items = searchApiSongs(keyword, page, pageSize, config);

    // 关键词含空格（如「歌名 歌手」）整串搜不到时，取最长分词重试一次
    if (items.length === 0 && /\s/.test(keyword)) {
      var tokens = keyword.split(/\s+/).sort(function (a, b) { return b.length - a.length; });
      if (tokens[0]) items = searchApiSongs(tokens[0], page, pageSize, config);
    }

    var separator = request.separator || "/";
    var enrich = !request.config || request.config.enrich !== "false";

    var songs = items
      .map(function (item) { return mapSong(item, request); })
      .filter(function (song) { return song.id && song.title; });

    if (enrich) {
      for (var i = 0; i < songs.length; i++) {
        enrichSong(songs[i], config, separator);
      }
    }

    return songs;
  } catch (e) {
    Platform.log.error("LrcShare", "searchSongs failed: " + (e && e.message ? e.message : e));
    return [];
  }
}

/** 单首歌 → 结构化歌词（ti/ar/al/date 标签 + 逐行时间轴） */
function getLyricsForSong(request, song) {
  var internal = song.internal || {};
  var fields = song.fields || {};
  var trackId = internal.lrcshare_id || song.id || "";

  // 搜索阶段已补全的歌词直接复用，避免重复请求详情
  var lrcText = fields.lyrics || null;

  if (!lrcText) {
    if (!trackId) return null;
    try {
      var config = LrcShare.getConfig(request);
      var response = LrcShare.get("/song/" + encodeURIComponent(trackId), {}, config);
      var detail = response && response.data;
      if (!detail || !detail.lrc) return null;
      lrcText = detail.lrc;
    } catch (e) {
      Platform.log.warn("LrcShare", "getLyrics failed: " + (e && e.message ? e.message : e));
      return null;
    }
  }

  var original = LrcShare.parseLrc(lrcText);
  if (original.length === 0) return null;

  return {
    type: "structured",
    tags: {
      ti: fields.title || song.title || "",
      ar: fields.artist || song.artist || "",
      al: fields.album || song.album || "",
      date: fields.date || song.date || ""
    },
    original: original,
    translated: null,
    romanization: null
  };
}

function getLyrics(request) {
  var requestedSong = request.song || {};
  var songs = requestedSong.id && requestedSong.id !== "local-song"
    ? [requestedSong]
    : searchSongs({
        keyword: (requestedSong.title || "").trim(),
        page: request.page || 1,
        pageSize: request.pageSize || 5,
        separator: "/",
        config: request.config || {}
      });

  return songs
    .map(function (song) { return getLyricsForSong(request, song); })
    .filter(function (lyrics) {
      return lyrics && lyrics.tags && lyrics.tags.ti && lyrics.tags.ar && lyrics.tags.al;
    });
}

function searchCovers(request) {
  // 封面搜索只需摘要，跳过详情补全
  var songs = searchSongs({
    keyword: request.keyword,
    page: request.page || 1,
    pageSize: request.pageSize || 5,
    separator: "/",
    config: { enrich: "false" }
  });
  return songs.filter(function (song) {
    return song.picUrl && song.title && song.artist && song.album && song.date;
  });
}
