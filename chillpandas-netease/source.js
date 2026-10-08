// 网易云音乐 · 元数据增强（作者 ChillPandas）
//
// 能获取的标签（Lyrico 标准字段 key → 含义 → 来源）
//   title / artist / album           标题、艺术家、专辑          搜索结果
//   date                             发行日期                    专辑的发行日期（补全详情），否则用搜索结果里的
//   track_number / disc_number       音轨号、碟号                搜索结果
//   cover_url                        封面（500/800/1200/原图）   搜索结果；批量匹配封面的规则见 lib/05_cover_hunt.js
//   comment                          备注（歌曲别名）            搜索结果
//   album_artist                     专辑艺术家                  专辑详情（补全详情）
//   copyright                        唱片公司                    专辑详情（补全详情）
//   lyricist / composer              作词、作曲                  歌词开头的署名行（补全详情）
//   genre / language                 曲风、语种                  音乐百科（补全详情，每次只能查前 2 条）
// 歌词：逐字 yrc（部分歌曲有），没有时用逐行 LRC；带翻译、罗马音（整行）
//
// 同一首歌出现在多张专辑时，每个专辑版本都是一条结果，日期跟着专辑走；
// 结果按和关键词的匹配度排序，关键词里写了专辑名或年份，对应的版本排第一
//
// 批量匹配并发建议设为 1 或 2，不要大于 2：并发越高越容易被限流

function readConfig(request) {
  var config = request.config || {};
  return {
    coverSize: config.cover_size || "1200",
    genreStyle: config.genre_style || "full",
    details: config.details !== "false" && config.details !== false
  };
}

function mapSong(song, request, extra) {
  var config = readConfig(request);
  var separator = request.separator || "/";
  var album = song.al || song.album || {};
  var artists = (Array.isArray(song.ar) ? song.ar : (song.artists || [])).map(function (a) { return a.name; });
  var aliases = Array.isArray(song.alia) ? song.alia : (song.alias || []);
  extra = extra || {};

  var fields = Meta.compactFields({
    title: song.name || "",
    artist: Meta.joinUnique(artists, separator),
    album: album.name || "",
    album_artist: Meta.joinUnique(extra.albumArtists, separator),
    // extra.date 是专辑的发行日期；网易云歌曲自己的日期经常和所在专辑对不上
    date: extra.date || Meta.formatDateCst(song.publishTime) || "",
    track_number: Meta.toPositiveIntString(song.no),
    disc_number: Meta.toPositiveIntString(song.cd),
    cover_url: NE.buildCoverUrl(album.picUrl, config.coverSize),
    genre: Meta.joinUnique((extra.genres || []).map(function (g) {
      return NE.formatGenre(g, config.genreStyle);
    }), separator),
    language: Meta.joinUnique(extra.languages, separator),
    copyright: extra.copyright,
    lyricist: Meta.joinUnique(extra.lyricists, separator),
    composer: Meta.joinUnique(extra.composers, separator),
    comment: aliases.join(" / ")
  });

  return {
    id: String(song.id || ""),
    title: fields.title || "",
    artist: fields.artist || "",
    album: fields.album || "",
    duration: Number(song.dt || song.duration || 0),
    date: fields.date || "",
    trackNumber: fields.track_number || "",
    picUrl: fields.cover_url || "",
    fields: fields,
    internal: {
      song_id: String(song.id || ""),
      album_id: String(album.id || "")
    }
  };
}

function searchSongs(request) {
  var startedAt = Date.now();
  var config = readConfig(request);
  var keyword = String(request.keyword || "").trim();
  if (!keyword) return [];

  var songs;
  try {
    songs = NE.search(keyword, Math.max(1, Number(request.page || 1)), Number(request.pageSize || 20));
  } catch (e) {
    Platform.log.error("NEMeta", "search failed: " + Meta.errMsg(e));
    return [];
  }

  // 批量匹配时向平台多要了几条（共用缓存），这里只保留最匹配的几条再查详情
  songs = Meta.limitResults(Meta.rankByKeyword(keyword, songs, function (song) {
    return {
      title: song.name,
      artist: (song.ar || []).map(function (a) { return a.name; }).join("/"),
      album: (song.al || {}).name,
      date: ""
    };
  }), request);

  var extras = [];
  if (config.details && songs.length && !Meta.isLyricsBatchSearch(request)) {
    try {
      extras = NE.fetchExtras(songs, startedAt);
    } catch (e) {
      Platform.log.warn("NEMeta", "detail lookup failed: " + Meta.errMsg(e));
    }
  }

  var results = songs
    .map(function (song, i) { return mapSong(song, request, extras[i]); })
    .filter(function (song) { return song.id && song.title; });
  return Meta.rankByKeyword(keyword, results);
}

// 批量匹配封面：按本地文件的歌名、歌手、专辑找，三样都对得上才用，专辑不一样的版本不要。
// 网易云、QQ、酷狗里有这张专辑的，用原图像素最高的那张（像素相同时用网易云的）；网易云没有就用另外两个平台的；
// 都没有就不返回封面。设置里关掉「比较三个平台」后只在网易云里找。
// 网易云有些原图是 PNG，一张能有六七 MB，会换成同样像素的 JPEG。
// 手动搜索封面：按「封面尺寸」设置给图
function searchCovers(request) {
  if (Meta.isBatchCover(request)) {
    var both = Meta.readCoverConfig(request.config).crossPlatform;
    var found = CoverHunt.find(request, both ? [CoverHunt.NETEASE, CoverHunt.QQ, CoverHunt.KUGOU] : [CoverHunt.NETEASE]);
    return found ? [found] : [];
  }
  return searchSongs({
    keyword: request.keyword,
    page: request.page || 1,
    pageSize: request.pageSize || 5,
    separator: "/",
    config: Object.assign({}, request.config || {}, { details: "false" })
  }).filter(function (song) {
    return song.picUrl && song.title && song.artist && song.album && song.date;
  });
}

// Lyrico 会把本插件 searchSongs 的结果原样传进来；没有平台 ID 时（例如独立歌词搜索）先按标题和歌手搜索
function getLyrics(request) {
  var startedAt = Date.now();
  var song = request.song || {};
  var internal = song.internal || {};
  var songs = internal.song_id || internal.album_id != null
    ? [song]
    : searchSongs({
        keyword: [song.title, song.artist].filter(Boolean).join(" "),
        page: request.page || 1,
        pageSize: Math.min(Number(request.pageSize || 3), 3),
        separator: "/",
        config: Object.assign({}, request.config || {}, { details: "false" })
      });

  var results = [];
  // 没有平台 ID、靠搜索找歌时最多取前 3 首的歌词
  for (var i = 0; i < Math.min(songs.length, 3); i++) {
    if (i > 0 && Date.now() - startedAt > 9000) break;
    var id = (songs[i].internal || {}).song_id || songs[i].id;
    try {
      var lyrics = NELyrics.fetch(id);
      if (lyrics) results.push(Object.assign({ tags: Meta.lyricsTags(songs[i]) }, Meta.applyLyricOptions(lyrics, request.config)));
    } catch (e) {
      Platform.log.warn("NEMeta", "lyrics failed for " + id + ": " + Meta.errMsg(e));
    }
  }
  return results;
}
