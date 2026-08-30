// LrcShare × Lyrico 插件入口
// 数据源：https://api.lrcshare.com（匿名调用，无需鉴权）
// 流程：searchSongs 拿列表（可逐首补全元数据）→ getLyrics 解析 LRC
// 省请求：先拉全库目录快照（24h 缓存）做本地负向预过滤，库里没有的歌 0 请求直接返回空

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
    var response = LrcShare.get("/song/" + encodeURIComponent(trackId), { lyric_lines: "1" }, config);
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
    // 多语言版本结构化数据缓存到 internal（getLyrics 阶段直接复用，避免二次请求）
    if (detail.lyric_lines && detail.lyric_lines.versions && detail.lyric_lines.versions.length) {
      song.internal.lyric_lines = detail.lyric_lines;
    }
  } catch (e) {
    Platform.log.warn("LrcShare", "enrich failed for " + trackId + ": " + (e && e.message ? e.message : e));
  }
}

/**
 * 目录负向预过滤（token 级，与搜索端宽松语义配套）：
 * 只要查询串的任意 token（或整串/结构化字段）在全库目录快照文本中出现即放行；
 * 仅当「全部 token 均不在快照」才判 0 结果返回 false。
 * token 级判定容忍快照滞后——单个字段缺失不再整体拦截。
 * 目录拉取失败（null）时恒返回 true：宁可多一次请求，绝不漏判。
 */
function catalogAllows(config, keyword, title, artist) {
  var catalog = LrcShare.getCatalog(config);
  if (!catalog || !catalog.text) return true;
  var text = String(catalog.text);

  function anyHit(str) {
    if (!str) return false;
    var lower = String(str).toLowerCase();
    if (text.indexOf(lower) !== -1) return true;
    // 整串不在 → 任一 token 在即放行（宽松语义下命中任一 token 的歌会返回）
    var toks = lower.split(/\s+/).filter(Boolean);
    for (var i = 0; i < toks.length; i++) {
      if (text.indexOf(toks[i]) !== -1) return true;
    }
    return false;
  }

  if (keyword) {
    if (anyHit(keyword)) return true;
  } else {
    // 结构化：title / artist 任一字段（或其 token）在快照中即放行
    if (anyHit(title)) return true;
    if (anyHit(artist)) return true;
  }
  return false;
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

    // 负向预过滤：全库目录里连可能的命中文本都没有 → 直接返回空（0 次搜索请求）
    if (!catalogAllows(config, keyword, reqTitle, reqArtist)) return [];

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

/** 剥词标签 <偏移毫秒> → 只留文本 */
function stripWordTags(text) {
  return String(text || "").replace(/<\d{1,6}>/g, "");
}

/** text（含 <偏移毫秒> 词标签）→ Lyrico 逐词 [[wordStart, wordEnd, "word"], ...] */
function wordsOf(text, lineStart, lineEnd) {
  var tokens = String(text).split(/<(\d{1,6})>/);
  var starts = [];
  var offset = 0;
  for (var i = 0; i < tokens.length; i++) {
    if (i % 2 === 0) {
      if (tokens[i]) starts.push({ text: tokens[i], start: lineStart + offset });
    } else {
      offset = parseInt(tokens[i], 10);
    }
  }
  var words = [];
  for (var j = 0; j < starts.length; j++) {
    var wEnd = (j + 1 < starts.length) ? starts[j + 1].start : lineEnd;
    words.push([starts[j].start, wEnd, starts[j].text]);
  }
  return words;
}

/** 行表 rows → Lyrico 整行 Line[]（translated/romanization 用，剥词标签） */
function plainToLines(rows) {
  var timed = (rows || []).filter(function (r) { return r.time_ms != null; })
    .sort(function (a, b) { return a.time_ms - b.time_ms; });
  var lines = [];
  for (var i = 0; i < timed.length; i++) {
    var start = timed[i].time_ms;
    var end = (i + 1 < timed.length) ? timed[i + 1].time_ms : start + 3000;
    lines.push([start, end, stripWordTags(timed[i].text)]);
  }
  return lines;
}

/** 行表 rows → Lyrico original Line[]（含词标签则逐词，否则整行） */
function originalToLines(rows) {
  var timed = (rows || []).filter(function (r) { return r.time_ms != null; })
    .sort(function (a, b) { return a.time_ms - b.time_ms; });
  var lines = [];
  for (var i = 0; i < timed.length; i++) {
    var start = timed[i].time_ms;
    var end = (i + 1 < timed.length) ? timed[i + 1].time_ms : start + 3000;
    var text = timed[i].text;
    if (/<\d{1,6}>/.test(text)) {
      lines.push([start, end, wordsOf(text, start, end)]);
    } else {
      lines.push([start, end, text]);
    }
  }
  return lines;
}

/** tags（ti/ar/al/date） */
function buildTags(fields, song) {
  return {
    ti: fields.title || song.title || "",
    ar: fields.artist || song.artist || "",
    al: fields.album || song.album || "",
    date: fields.date || song.date || ""
  };
}

/**
 * lyric_lines（versions 数组）→ Lyrico structured 的 original/translated/romanization。
 * Lyrico structured 的 translated/romanization 是「单一」Line[]：多语言译文合并进同一个
 * translated（同时间戳并列显示），保证打开翻译开关能看全所有译文（如东京盆踊 中+日 两行）。
 */
function buildStructuredFromVersions(lyricLines, fields, song) {
  var versions = lyricLines.versions || [];
  var originalVer = null;
  var translatedRows = [];
  var romanRows = [];
  for (var i = 0; i < versions.length; i++) {
    var v = versions[i];
    Platform.log.warn("LrcShare", "version: lang=" + v.lang + " kind=" + v.kind + " rows=" + (v.rows ? v.rows.length : 0));
    if (v.kind === "original" && !originalVer) originalVer = v;
    else if (v.kind === "translation") translatedRows = translatedRows.concat(v.rows || []);
    else if (v.kind === "romanization") romanRows = romanRows.concat(v.rows || []);
  }

  var original = originalVer ? originalToLines(originalVer.rows || []) : [];
  if (original.length === 0) return null;

  var translatedLines = translatedRows.length ? plainToLines(translatedRows) : null;
  var romanLines = romanRows.length ? plainToLines(romanRows) : null;
  Platform.log.warn("LrcShare", "translated rows=" + translatedRows.length + " lines=" + (translatedLines ? translatedLines.length : 0) + " romanLines=" + (romanLines ? romanLines.length : 0));

  return {
    type: "structured",
    tags: buildTags(fields, song),
    original: original,
    translated: translatedLines,
    romanization: romanLines
  };
}

/** 单首歌 → 结构化歌词（优先多语言 versions；回退 raw LRC 解析） */
function getLyricsForSong(request, song) {
  var internal = song.internal || {};
  var fields = song.fields || {};
  var trackId = internal.lrcshare_id || song.id || "";
  var config = LrcShare.getConfig(request);

  // 优先：多语言结构化（搜索阶段 enrich 已缓存 internal.lyric_lines；未缓存则此处再拉一次）
  var lyricLines = internal.lyric_lines || null;
  if (!lyricLines && trackId) {
    try {
      var resp = LrcShare.get("/song/" + encodeURIComponent(trackId), { lyric_lines: "1" }, config);
      lyricLines = resp && resp.data && resp.data.lyric_lines;
    } catch (e) {
      lyricLines = null;
    }
  }
  if (lyricLines && lyricLines.versions && lyricLines.versions.length) {
    return buildStructuredFromVersions(lyricLines, fields, song);
  }

  // 回退：raw LRC（老数据 / 无多语言版本）
  var lrcText = fields.lyrics || null;
  if (!lrcText) {
    if (!trackId) return null;
    try {
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
    tags: buildTags(fields, song),
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
