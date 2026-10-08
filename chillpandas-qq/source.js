// QQ 音乐 · 元数据增强（作者 ChillPandas）
//
// 能获取的标签（Lyrico 标准字段 key → 含义 → 来源）
//   title / artist / album           标题、艺术家、专辑          搜索结果
//   date                             发行日期                    专辑的发行日期（补全详情），否则用搜索结果里的
//   track_number / disc_number       音轨号、碟号                搜索结果，缺失时取歌曲详情
//   cover_url                        封面（500/800/1200/原图）   搜索结果；批量匹配封面的规则见 lib/05_cover_hunt.js
//   comment                          备注（歌曲副标题）          搜索结果
//   replaygain_track_gain / _peak    音轨增益、峰值              搜索结果（设置里可关闭）
//   replaygain_reference_loudness    参考响度（-18 LUFS）        搜索结果
//   album_artist                     专辑艺术家                  专辑详情（补全详情）
//   genre / language                 流派、语种                  歌曲详情（补全详情）
//   copyright                        唱片公司                    歌曲详情 / 专辑详情（补全详情）
//   lyricist / composer              作词、作曲                  歌词开头的署名行（补全详情）
// 歌词：逐字 QRC（解密见 lib/03_qrc.js），没有时用逐行 LRC；带翻译、罗马音（整行）
//
// 同一首歌出现在多张专辑时，每个专辑版本都是一条结果，日期和音轨号跟着专辑走；
// 结果按和关键词的匹配度排序，关键词里写了专辑名或年份，对应的版本排第一
//
// 批量匹配并发建议设为 1 或 2，不要大于 2：并发越高越容易被 QQ 音乐限流（错误码 2001）

function readConfig(request) {
  var config = request.config || {};
  return {
    coverSize: config.cover_size || "1200",
    replaygain: config.replaygain !== "false" && config.replaygain !== false,
    details: config.details !== "false" && config.details !== false
  };
}

function formatFixed(value, digits, suffix) {
  var number = Number(value);
  if (value == null || value === "" || !isFinite(number)) return "";
  return number.toFixed(digits) + (suffix || "");
}

function mapSong(item, request, extra) {
  var config = readConfig(request);
  var separator = request.separator || "/";
  var album = item.album || {};
  var singers = (Array.isArray(item.singer) ? item.singer : []).map(function (s) { return s.name; });
  extra = extra || {};

  var fields = {
    title: item.title || item.name || "",
    artist: Meta.joinUnique(singers, separator),
    album: album.name || album.title || "",
    album_artist: Meta.joinUnique(extra.albumArtists, separator),
    date: extra.albumDate || item.time_public || album.time_public || extra.date || "",
    track_number: Meta.toTrackString(item.index_album) || Meta.toTrackString(extra.trackIndex),
    cover_url: QQ.buildCoverUrl(album.mid, config.coverSize),
    genre: Meta.joinUnique(extra.genres, separator),
    language: Meta.joinUnique(extra.languages, separator),
    copyright: extra.copyright,
    lyricist: Meta.joinUnique(extra.lyricists, separator),
    composer: Meta.joinUnique(extra.composers, separator),
    comment: item.subtitle || item.desc || extra.subtitle || ""
  };

  // QQ 的碟号从 0 开始
  var discIndex = typeof item.index_cd === "number" ? item.index_cd : extra.discIndex;
  // 没有专辑的歌（现场、混音等）不写碟号
  if (fields.album && typeof discIndex === "number" && discIndex >= 0 && discIndex < 999) {
    fields.disc_number = String(discIndex + 1);
  }

  var volume = item.volume || extra.volume;
  if (config.replaygain && volume) {
    var gain = formatFixed(volume.gain, 3, " dB");
    var peak = formatFixed(volume.peak, 6, "");
    if (gain) {
      fields.replaygain_track_gain = gain;
      fields.replaygain_reference_loudness = "-18 LUFS";
    }
    if (peak) fields.replaygain_track_peak = peak;
  }

  fields = Meta.compactFields(fields);

  return {
    id: String(item.id || ""),
    title: fields.title || "",
    artist: fields.artist || "",
    album: fields.album || "",
    duration: Number(item.interval || 0) * 1000,
    date: fields.date || "",
    trackNumber: fields.track_number || "",
    picUrl: fields.cover_url || "",
    fields: fields,
    internal: {
      song_mid: String(item.mid || ""),
      album_mid: String(album.mid || "")
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
    items = QQ.search(keyword, Math.max(1, Number(request.page || 1)), Number(request.pageSize || 20));
  } catch (e) {
    Platform.log.error("QQMeta", "search failed: " + Meta.errMsg(e));
    return [];
  }

  // 先按搜索结果自带的信息排序（QQ 每个专辑版本的日期在搜索结果里就是对的），再决定给哪些结果查详情
  items = Meta.limitResults(Meta.rankByKeyword(keyword, items, function (item) {
    return {
      title: item.title,
      artist: (item.singer || []).map(function (s) { return s.name; }).join("/"),
      album: (item.album || {}).name,
      date: item.time_public
    };
  }), request);

  var extras = [];
  if (config.details && items.length && !Meta.isLyricsBatchSearch(request)) {
    try {
      extras = QQ.fetchExtras(items.slice(0, QQ.DETAIL_MAX), startedAt);
    } catch (e) {
      Platform.log.warn("QQMeta", "detail lookup failed: " + Meta.errMsg(e));
    }
  }

  var songs = items
    .map(function (item, i) { return mapSong(item, request, extras[i]); })
    .filter(function (song) { return song.id && song.title; });
  return Meta.rankByKeyword(keyword, songs);
}

// 批量匹配封面：按本地文件的歌名、歌手、专辑找，三样都对得上才用，专辑不一样的版本不要。
// QQ、网易云、酷狗里有这张专辑的，用原图像素最高的那张（像素相同时用 QQ 的）；QQ 没有就用另外两个平台的；
// 都没有就不返回封面。设置里关掉「比较三个平台」后只在 QQ 里找。
// 手动搜索封面：按「封面尺寸」设置给图
function searchCovers(request) {
  if (Meta.isBatchCover(request)) {
    var both = Meta.readCoverConfig(request.config).crossPlatform;
    var found = CoverHunt.find(request, both ? [CoverHunt.QQ, CoverHunt.NETEASE, CoverHunt.KUGOU] : [CoverHunt.QQ]);
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
  var songs = (song.internal || {}).song_mid
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
      var lyrics = QQLyrics.fetch(songs[i]);
      if (lyrics) results.push(Object.assign({ tags: Meta.lyricsTags(songs[i]) }, Meta.applyLyricOptions(lyrics, request.config)));
    } catch (e) {
      Platform.log.warn("QQMeta", "lyrics failed for " + songs[i].id + ": " + Meta.errMsg(e));
    }
  }
  return results;
}
