var QQ = QQ || {};

QQ.API_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";

// 桌面端参数在海外网络下也能返回结果；移动端参数作为备用
QQ.DESKTOP_COMM = { ct: "19", cv: "1859", uin: "0" };
QQ.LITE_COMM = {
  ct: "11",
  cv: "1003006",
  v: "1003006",
  os_ver: "15",
  phonetype: "24122RKC7C",
  tmeAppID: "qqmusiclight",
  nettype: "NETWORK_WIFI"
};

// 一次 POST 里可以放多个子请求，返回值按同样的键取
QQ.post = function (comm, requests, httpOptions) {
  var body = { comm: comm };
  Object.keys(requests).forEach(function (key) {
    body[key] = requests[key];
  });
  var text = Platform.http.postText(QQ.API_URL, JSON.stringify(body), Object.assign({
    contentType: "application/json; charset=utf-8",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://y.qq.com/"
    }
  }, httpOptions || {}));
  return JSON.parse(text);
};

// 接口返回非 0 错误码（例如限流 2001）时抛出，由 QQ.search 换接口并让这个接口冷却一会儿
QQ.checkCode = function (code) {
  if (code != null && code !== 0) throw new Error("code " + code);
};

QQ.searchDesktop = function (keyword, page, pageSize) {
  var res = QQ.post(QQ.DESKTOP_COMM, {
    req_0: {
      module: "music.search.SearchCgiService",
      method: "DoSearchForQQMusicDesktop",
      param: { query: keyword, search_type: 0, num_per_page: pageSize, page_num: page }
    }
  }, Meta.SEARCH_HTTP_OPTIONS);
  QQ.checkCode((res.req_0 || {}).code);
  var body = ((res.req_0 || {}).data || {}).body || {};
  return (body.song || {}).list || [];
};

QQ.searchLite = function (keyword, page, pageSize) {
  var res = QQ.post(QQ.LITE_COMM, {
    req_0: {
      module: "music.search.SearchCgiService",
      method: "DoSearchForQQMusicLite",
      param: {
        search_id: String(Math.floor(10000000000000000 + Math.random() * 80000000000000000)),
        remoteplace: "search.android.keyboard",
        query: keyword,
        search_type: 0,
        num_per_page: pageSize,
        page_num: page,
        highlight: 0,
        nqc_flag: 0,
        page_id: 1,
        grp: 1
      }
    }
  }, Meta.SEARCH_HTTP_OPTIONS);
  QQ.checkCode((res.req_0 || {}).code);
  return ((((res.req_0 || {}).data || {}).body || {}).item_song) || [];
};

// 旧版网页搜索接口，new_json=1 时返回格式与 musicu 相同。musicu 被限流（错误码 2001）时它通常仍可用
QQ.searchLegacy = function (keyword, page, pageSize) {
  var url = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&new_json=1&cr=1&aggr=1" +
    "&p=" + page + "&n=" + pageSize + "&w=" + encodeURIComponent(keyword);
  var text = Platform.http.getText(url, Object.assign({
    headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://y.qq.com/" }
  }, Meta.SEARCH_HTTP_OPTIONS));
  var root = JSON.parse(text);
  QQ.checkCode(root.code);
  return ((root.data || {}).song || {}).list || [];
};

// 旧版快速搜索接口：约 1 秒，但只有旧格式字段（没有音轨号、碟号、回放增益，由详情补上）
QQ.searchFast = function (keyword, page, pageSize) {
  // aggr=1：把同一首歌在其他专辑里的版本放进 grp 一起返回
  var url = "https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?format=json&aggr=1" +
    "&p=" + page + "&n=" + pageSize + "&w=" + encodeURIComponent(keyword);
  var text = Platform.http.getText(url, Object.assign({
    headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://y.qq.com/" }
  }, Meta.SEARCH_HTTP_OPTIONS));
  var root = JSON.parse(text);
  QQ.checkCode(root.code);
  var convert = function (x) {
    return {
      id: x.songid,
      mid: x.songmid,
      title: x.songname,
      singer: x.singer || [],
      album: { mid: x.albummid, name: x.albumname },
      time_public: x.pubtime ? Meta.formatDateCst(Number(x.pubtime) * 1000) : "",
      interval: x.interval,
      grp: (x.grp || []).map(function (g) { return convert(g); })
    };
  };
  return (((root.data || {}).song || {}).list || []).map(convert);
};

// 按速度和数据完整度排序：被限流的接口会冷却，自动跳到下一个
QQ.SEARCHERS = [
  { name: "desktop", run: QQ.searchDesktop },
  { name: "fast", run: QQ.searchFast },
  { name: "legacy", run: QQ.searchLegacy },
  { name: "lite", run: QQ.searchLite }
];

// 被限流的接口冷却 2 分钟，期间排到最后，省掉一次注定失败的请求
QQ.COOLDOWN_MS = 2 * 60 * 1000;

// 只保留插件用到的字段，缓存更小
QQ.trimItem = function (item) {
  var album = item.album || {};
  return {
    id: item.id,
    mid: item.mid,
    title: item.title || item.name,
    subtitle: item.subtitle || item.desc || "",
    singer: (item.singer || []).map(function (s) { return { name: s.name }; }),
    album: { mid: album.mid, name: album.name || album.title, time_public: album.time_public },
    time_public: item.time_public,
    index_album: item.index_album,
    index_cd: item.index_cd,
    interval: item.interval,
    volume: item.volume ? { gain: item.volume.gain, peak: item.volume.peak } : null
  };
};

// QQ 把同一首歌在其他专辑里的版本折叠在 grp 里。展开成独立的结果，紧跟在主结果后面
QQ.expand = function (items) {
  var out = [];
  var seen = {};
  items.forEach(function (item) {
    [item].concat(item.grp || []).forEach(function (x) {
      var trimmed = QQ.trimItem(x);
      var key = String(trimmed.mid || trimmed.id || "");
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push(trimmed);
    });
  });
  return out;
};

// 先查缓存；再依次尝试各个搜索接口（冷却中的排到最后），拿到结果就返回；前面耗时太久就不再换接口
QQ.search = function (keyword, page, pageSize) {
  pageSize = Meta.fetchSize(pageSize);
  var cacheKey = Meta.searchCacheKey("qq.search.v4.", keyword, page, pageSize);
  var cached = Meta.cacheGet(cacheKey);
  if (cached) return cached;

  var ready = QQ.SEARCHERS.filter(function (s) { return !Meta.cacheGet("qq.cooldown." + s.name); });
  var cooling = QQ.SEARCHERS.filter(function (s) { return ready.indexOf(s) < 0; });
  var order = ready.concat(cooling);
  var startedAt = Date.now();

  for (var i = 0; i < order.length; i++) {
    if (i > 0 && Date.now() - startedAt > 7000) break;
    var searcher = order[i];
    try {
      var items = QQ.expand(searcher.run(keyword, page, pageSize));
      if (items.length) {
        Meta.cacheSet(cacheKey, items, Meta.SEARCH_CACHE_TTL_MS);
        return items;
      }
    } catch (e) {
      Meta.cacheSet("qq.cooldown." + searcher.name, true, QQ.COOLDOWN_MS);
      Platform.log.warn("QQMeta", searcher.name + " search failed: " + Meta.errMsg(e));
    }
  }
  return [];
};

// 不带尺寸参数就是原图（一般 1500 像素左右）；QQ 最大的固定尺寸是 1200
QQ.buildCoverUrl = function (albumMid, size) {
  if (!albumMid) return "";
  if (!size || size === "original") return "https://y.gtimg.cn/music/photo_new/T002M000" + albumMid + ".jpg";
  return "https://y.gtimg.cn/music/photo_new/T002R" + size + "x" + size + "M000" + albumMid + ".jpg";
};

QQ.infoValues = function (info, key) {
  var content = ((info || {})[key] || {}).content || [];
  return content
    .map(function (c) { return String((c && c.value) || "").trim(); })
    .filter(Boolean);
};

QQ.decodeLyric = function (text) {
  if (!text) return "";
  try {
    var decoded = Platform.base64.decodeText(text);
    if (decoded && decoded.indexOf("[") >= 0) return decoded;
  } catch (e) {
    // 已经是明文
  }
  return String(text);
};

// musicu 一次 POST 最多接受 30 个子请求，超过会整体报错
QQ.MAX_SUBREQUESTS = 30;

// 手动搜索时只给排在最前面的这么多条结果查详情（约 2 个请求），其余结果只带搜索结果自带的信息
QQ.DETAIL_MAX = 20;

// 查询歌曲详情、歌词署名和专辑信息：所有结果打包进尽量少的请求，查过的直接读缓存
QQ.fetchExtras = function (items, startedAt) {
  var deadline = (startedAt || Date.now()) + Meta.DETAIL_DEADLINE_MS;
  var extras = items.map(function (item) {
    return item.mid ? Meta.cacheGet("qq.song.v3." + item.mid) : null;
  });
  var albumInfo = {};
  var albumQueued = {};
  var chunks = [];
  var current = null;

  items.forEach(function (item, i) {
    if (!item.mid || extras[i]) return;
    var albumMid = (item.album || {}).mid || "";
    if (albumMid && !albumInfo[albumMid] && !albumQueued[albumMid]) {
      var cachedAlbum = Meta.cacheGet("qq.album." + albumMid);
      if (cachedAlbum) albumInfo[albumMid] = cachedAlbum;
    }
    var needAlbum = albumMid && !albumInfo[albumMid] && !albumQueued[albumMid];
    var cost = needAlbum ? 3 : 2;

    if (!current || current.count + cost > QQ.MAX_SUBREQUESTS) {
      current = { requests: {}, count: 0, songs: [], albums: [] };
      chunks.push(current);
    }
    current.requests["d" + i] = {
      module: "music.pf_song_detail_svr",
      method: "get_song_detail_yqq",
      param: { song_type: 0, song_mid: item.mid }
    };
    current.requests["l" + i] = {
      module: "music.musichallSong.PlayLyricInfo",
      method: "GetPlayLyricInfo",
      param: { songMID: item.mid, crypt: 0, qrc: 0, trans: 0, roma: 0, type: 0 }
    };
    current.songs.push(i);
    if (needAlbum) {
      current.requests["a_" + albumMid] = {
        module: "music.musichallAlbum.AlbumInfoServer",
        method: "GetAlbumDetail",
        param: { albumMid: albumMid }
      };
      current.albums.push(albumMid);
      albumQueued[albumMid] = true;
    }
    current.count += cost;
  });

  var songParts = {};
  for (var c = 0; c < chunks.length; c++) {
    if (Date.now() > deadline) break;
    var chunk = chunks[c];
    var res;
    try {
      res = QQ.post(QQ.DESKTOP_COMM, chunk.requests, Meta.DETAIL_HTTP_OPTIONS);
    } catch (e) {
      Platform.log.warn("QQMeta", "detail batch failed: " + Meta.errMsg(e));
      break;
    }

    chunk.albums.forEach(function (albumMid) {
      var r = res["a_" + albumMid] || {};
      if (r.code !== 0) return;
      var data = r.data || {};
      albumInfo[albumMid] = {
        artists: Meta.unique(((data.singer || {}).singerList || []).map(function (s) { return s.name; })),
        company: String((data.company || {}).name || ""),
        date: String((data.basicInfo || {}).publishDate || "")
      };
      Meta.cacheSet("qq.album." + albumMid, albumInfo[albumMid]);
    });

    chunk.songs.forEach(function (i) {
      var d = res["d" + i] || {};
      var l = res["l" + i] || {};
      var info = (d.data || {}).info || {};
      var track = (d.data || {}).track_info || {};
      var credits = Meta.parseCredits(QQ.decodeLyric((l.data || {}).lyric));
      songParts[i] = {
        ok: d.code === 0 && l.code === 0,
        genres: Meta.unique(QQ.infoValues(info, "genre")),
        languages: Meta.unique(QQ.infoValues(info, "lan")),
        company: QQ.infoValues(info, "company")[0] || "",
        date: QQ.infoValues(info, "pub_time")[0] || "",
        lyricists: credits.lyricists,
        composers: credits.composers,
        // 快速搜索接口缺的字段从 track_info 补
        trackIndex: track.index_album,
        discIndex: track.index_cd,
        volume: track.volume ? { gain: track.volume.gain, peak: track.volume.peak } : null,
        subtitle: track.subtitle || ""
      };
    });
  }

  items.forEach(function (item, i) {
    var part = songParts[i];
    if (!part) return;
    var albumMid = (item.album || {}).mid || "";
    var album = albumInfo[albumMid] || null;
    extras[i] = {
      genres: part.genres,
      languages: part.languages,
      copyright: part.company || (album ? album.company : ""),
      date: part.date,
      // 专辑自己的发行日期：同一首歌在不同专辑里，日期要跟着专辑走
      albumDate: album ? album.date : "",
      albumArtists: album ? album.artists : [],
      lyricists: part.lyricists,
      composers: part.composers,
      trackIndex: part.trackIndex,
      discIndex: part.discIndex,
      volume: part.volume,
      subtitle: part.subtitle
    };
    if (part.ok && (album || !albumMid)) Meta.cacheSet("qq.song.v3." + item.mid, extras[i]);
  });

  return extras;
};
