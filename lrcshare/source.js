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

/** 调 /v1/search?type=song 结构化查询（title × artist AND，均含别名匹配），返回原始 items */
function searchApiSongsStructured(title, artist, page, pageSize, config) {
  var offset = (Math.max(1, page) - 1) * pageSize;
  var response = LrcShare.get("/search", {
    type: "song",
    title: title,
    artist: artist,
    limit: pageSize,
    offset: offset
  }, config);
  return (response.data && response.data.items) || [];
}

/**
 * 「歌名 艺术家」组合关键词搜索。
 * Lyrico 只给一坨拼接字符串（title 在前 artist 在后），keyword 整串模糊匹配接不住复合词：
 * 1) 整串先按 keyword 模糊搜（艺术家名/别名已在匹配范围，单字段命中场景直接解决）
 * 2) 0 条且含空格时，按「前段=歌名 后段=艺术家」穷举切分点，调结构化查询
 *    ?title=前段&artist=后段（服务端 AND 精确匹配），首个有结果的切分即目标
 * 3) 全部落空返回空
 */
function searchCombined(keyword, page, pageSize, config) {
  var items = searchApiSongs(keyword, page, pageSize, config);
  if (items.length > 0) return items;
  if (!/\s/.test(keyword)) return items;

  var tokens = keyword.split(/\s+/);
  var maxSplit = Math.min(tokens.length - 1, 6); // 词过多时限制切分数，控制请求次数
  for (var i = 1; i <= maxSplit; i++) {
    items = searchApiSongsStructured(tokens.slice(0, i).join(" "), tokens.slice(i).join(" "), page, pageSize, config);
    if (items.length > 0) return items;
  }
  return [];
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
  var albumArtist = (Array.isArray(album.artists) ? album.artists : [])
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
  if (albumArtist) {
    fields.album_artist = albumArtist;
  }
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
    if (!fields.album_artist && detail.album && Array.isArray(detail.album.artists)) {
      var albumArtist = detail.album.artists
        .map(function (a) { return a.name || ""; })
        .filter(function (n) { return n; })
        .join(separator);
      if (albumArtist) fields.album_artist = albumArtist;
    }
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
    var reqTitle = String(request.title || "").trim();
    var reqArtist = String(request.artist || "").trim();
    if (!keyword && !reqTitle && !reqArtist) return [];

    var page = Math.max(1, Number(request.page || 1));
    var pageSize = Number(request.pageSize || 20);

    // Lyrico 后续版本将直接下发结构化 title/artist 字段，有则优先精确查询，无需切分猜测
    var items;
    if (reqTitle || reqArtist) {
      items = searchApiSongsStructured(reqTitle, reqArtist, page, pageSize, config);
      // tag 写法与库内有出入导致结构化落空时，回退整串 keyword 模糊
      if (items.length === 0 && keyword) {
        items = searchApiSongs(keyword, page, pageSize, config);
      }
    } else {
      items = searchCombined(keyword, page, pageSize, config);
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
  // 封面搜索只需摘要，跳过详情补全。
  // Lyrico searchCovers 有两种入口：song 模式带 request.song（结构化 title/artist/album，
  // 批量打标场景）优先精确查询；keyword 模式（用户手输）走 keyword 模糊逻辑
  var reqSong = request.song || {};
  var songs = searchSongs({
    keyword: request.keyword,
    title: String(request.title || reqSong.title || "").trim(),
    artist: String(request.artist || reqSong.artist || "").trim(),
    page: request.page || 1,
    pageSize: request.pageSize || 5,
    separator: "/",
    config: { enrich: "false" }
  });
  return songs.filter(function (song) {
    return song.picUrl && song.title && song.artist && song.album && song.date;
  });
}
