// 酷狗音乐 · 元数据增强（作者 ChillPandas）
//
// 能获取的标签（Lyrico 标准字段 key → 含义 → 来源）
//   title / artist / album           标题、艺术家、专辑          搜索结果
//   date                             发行日期                    专辑的发行日期（补全详情），否则用搜索结果里的首发日期
//   cover_url                        封面（500/800/1200/原图）   搜索结果；批量匹配封面的规则见 lib/05_cover_hunt.js
//   language                         语种                        搜索结果 / 歌曲详情
//   comment                          备注                        搜索结果
//   lyricist / composer              作词、作曲                  歌曲详情（补全详情）
//   track_number / disc_number       音轨号、碟号                歌曲详情（补全详情）
//   genre                            流派                        歌曲详情的标签（补全详情）
//   album_artist                     专辑艺术家                  专辑详情（补全详情）
//   copyright                        唱片公司                    专辑详情（补全详情）
// 歌词：逐字 KRC，没有时用逐行 LRC；翻译、罗马音（整行）来自 KRC 内嵌的 [language:] 标签
//
// 同一首歌出现在多张专辑时，每个专辑版本都是一条结果，日期和音轨号跟着专辑走；
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

function mapSong(item, request, extra) {
  var config = readConfig(request);
  var separator = request.separator || "/";
  extra = extra || {};

  var fields = Meta.compactFields({
    title: item.title,
    artist: Meta.joinUnique(item.singers, separator),
    album: item.album,
    album_artist: Meta.joinUnique(extra.albumArtists, separator),
    date: extra.albumDate || item.date || extra.date || "",
    track_number: Meta.toTrackString(extra.trackIndex),
    disc_number: Meta.toTrackString(extra.disc),
    cover_url: KG.buildCoverUrl(item.image, config.coverSize),
    genre: KG.formatGenres(extra.genres, config.genreStyle, separator),
    language: extra.language || item.language,
    copyright: extra.copyright,
    lyricist: Meta.joinUnique(extra.lyricists, separator),
    composer: Meta.joinUnique(extra.composers, separator),
    comment: item.aux
  });

  return {
    id: item.id,
    title: fields.title || "",
    artist: fields.artist || "",
    album: fields.album || "",
    duration: Number(item.duration || 0) * 1000,
    date: fields.date || "",
    trackNumber: fields.track_number || "",
    picUrl: fields.cover_url || "",
    fields: fields,
    internal: {
      hash: item.hash,
      album_id: item.albumId
    }
  };
}

function searchSongs(request) {
  var startedAt = Date.now();
  var config = readConfig(request);
  var keyword = String(request.keyword || "").trim();
  if (!keyword) return [];

  var items;
  try {
    items = KG.search(keyword, Math.max(1, Number(request.page || 1)), Number(request.pageSize || 20));
  } catch (e) {
    Platform.log.error("KGMeta", "search failed: " + Meta.errMsg(e));
    return [];
  }

  // 先按搜索结果自带的信息排序，再决定给哪些结果查详情。
  // 酷狗搜索结果里的日期是歌曲首发日期，各专辑版本都一样，这一步它们保持平台顺序；
  // 查到专辑发行日期后，下面的最终排序再按日期排
  items = Meta.limitResults(Meta.rankByKeyword(keyword, items, function (item) {
    return { title: item.title, artist: item.singers.join("/"), album: item.album, date: "" };
  }), request);

  var extras = [];
  if (config.details && items.length && !Meta.isLyricsBatchSearch(request)) {
    try {
      extras = KG.fetchExtras(items.slice(0, KG.DETAIL_MAX), startedAt);
    } catch (e) {
      Platform.log.warn("KGMeta", "detail lookup failed: " + Meta.errMsg(e));
    }
  }

  var songs = items.map(function (item, i) { return mapSong(item, request, extras[i]); });
  return Meta.rankByKeyword(keyword, songs);
}

// 批量匹配封面：按本地文件的歌名、歌手、专辑找，三样都对得上才用，专辑不一样的版本不要。
// 酷狗、QQ、网易云里有这张专辑的，用原图像素最高的那张（像素相同时用酷狗的）；酷狗没有就用另外两个平台的；
// 都没有就不返回封面。设置里关掉「比较三个平台」后只在酷狗里找。
// 手动搜索封面：按「封面尺寸」设置给图。酷狗的固定尺寸会把小图放大（原图 500 也能要到 1200），原图才是真实像素
function searchCovers(request) {
  if (Meta.isBatchCover(request)) {
    var both = Meta.readCoverConfig(request.config).crossPlatform;
    var found = CoverHunt.find(request, both ? [CoverHunt.KUGOU, CoverHunt.QQ, CoverHunt.NETEASE] : [CoverHunt.KUGOU]);
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

// Lyrico 会把本插件 searchSongs 的结果原样传进来；没有 hash 时（例如独立歌词搜索）先按标题和歌手搜索
function getLyrics(request) {
  var startedAt = Date.now();
  var song = request.song || {};
  var songs = (song.internal || {}).hash
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
    try {
      var lyrics = KGLyrics.fetch(songs[i]);
      if (lyrics) results.push(Object.assign({ tags: Meta.lyricsTags(songs[i]) }, Meta.applyLyricOptions(lyrics, request.config)));
    } catch (e) {
      Platform.log.warn("KGMeta", "lyrics failed for " + songs[i].id + ": " + Meta.errMsg(e));
    }
  }
  return results;
}
