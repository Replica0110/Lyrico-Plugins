var KG = KG || {};

// 酷狗安卓客户端的签名参数：signature = md5(盐 + 按键名排序拼接的参数 + 请求体 + 盐)
// 概念版（lite）用于搜索和歌词，标准版用于 gateway 的批量详情接口
KG.LITE = { salt: "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA", appid: "3116", clientver: "11070" };
KG.STD = { salt: "OIlwieks28dk2k092lksi2UIkp", appid: "1005", clientver: "20489" };
KG.MID = Platform.crypto.md5(String(Date.now()));

KG.sign = function (params, body, salt) {
  var sorted = Object.keys(params).sort().map(function (k) { return k + "=" + params[k]; }).join("");
  params.signature = Platform.crypto.md5(salt + sorted + (body || "") + salt);
  return params;
};

KG.query = function (params) {
  return Object.keys(params).sort().map(function (k) {
    return encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k]));
  }).join("&");
};

KG.getJson = function (url, headers, httpOptions) {
  var text = Platform.http.getText(url, Object.assign({
    headers: Object.assign({ "User-Agent": "Android14-1070-11070-201-0-SearchSong-wifi" }, headers || {})
  }, httpOptions || {}));
  return JSON.parse(text);
};

KG.checkCode = function (root) {
  var code = root ? Number(root.error_code != null ? root.error_code : (root.errcode || 0)) : -1;
  if (!root || code !== 0 || root.status === 0) throw new Error("code " + (root ? code : "empty"));
  return root;
};

// gateway 批量接口（POST JSON，标准版签名）
KG.gateway = function (path, data, extraHeaders) {
  var body = JSON.stringify(data);
  var params = KG.sign({
    dfid: "-", mid: KG.MID, uuid: "-", appid: KG.STD.appid, clientver: KG.STD.clientver,
    clienttime: String(Math.floor(Date.now() / 1000))
  }, body, KG.STD.salt);
  var text = Platform.http.postText("https://gateway.kugou.com" + path + "?" + KG.query(params), body, Object.assign({
    contentType: "application/json",
    headers: Object.assign({
      "User-Agent": "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi",
      "dfid": "-", "mid": KG.MID, "clienttime": params.clienttime
    }, extraHeaders || {})
  }, Meta.DETAIL_HTTP_OPTIONS));
  return KG.checkCode(JSON.parse(text));
};

KG.stripTags = function (text) {
  return String(text || "").replace(/<[^>]+>/g, "").trim();
};

// 三种搜索接口返回的字段名不同，统一成插件内部格式（也作为缓存内容）
KG.normalize = function (x) {
  var tp = x.trans_param || {};
  var singers = Array.isArray(x.Singers) && x.Singers.length
    ? x.Singers.map(function (s) { return s.name || s.Name; })
    : String(x.SingerName || x.singername || "").split("、");
  var date = String(x.PublishDate || "").slice(0, 10);
  return {
    id: String(x.ID || x.MixSongID || x.album_audio_id || ""),
    hash: String(x.FileHash || x.hash || "").toUpperCase(),
    title: KG.stripTags(x.SongName || x.songname),
    singers: singers.map(KG.stripTags).filter(Boolean),
    album: KG.stripTags(x.AlbumName || x.album_name),
    albumId: String(x.AlbumID || x.album_id || ""),
    duration: Number(x.Duration || x.duration || 0),
    date: /^0000/.test(date) ? "" : date,
    image: String(x.Image || tp.union_cover || ""),
    language: String(tp.language || ""),
    aux: String(x.Auxiliary || "")
  };
};

KG.searchComplex = function (keyword, page, pageSize) {
  var params = KG.sign({
    userid: "0", appid: KG.LITE.appid, token: "", clienttime: String(Math.floor(Date.now() / 1000)),
    iscorrection: "1", uuid: "-", mid: KG.MID, dfid: "-", clientver: KG.LITE.clientver, platform: "AndroidFilter",
    keyword: keyword, page: String(page), pagesize: String(pageSize)
  }, "", KG.LITE.salt);
  var root = KG.checkCode(KG.getJson("https://complexsearch.kugou.com/v2/search/song?" + KG.query(params),
    { "x-router": "complexsearch.kugou.com" }, Meta.SEARCH_HTTP_OPTIONS));
  return ((root.data || {}).lists) || [];
};

// 网页版搜索：不需要签名，返回格式与上面相同
KG.searchWeb = function (keyword, page, pageSize) {
  var url = "https://songsearch.kugou.com/song_search_v2?platform=WebFilter&iscorrection=1" +
    "&keyword=" + encodeURIComponent(keyword) + "&page=" + page + "&pagesize=" + pageSize;
  var root = KG.checkCode(KG.getJson(url, { "User-Agent": "Mozilla/5.0", "Referer": "https://www.kugou.com/" }, Meta.SEARCH_HTTP_OPTIONS));
  return ((root.data || {}).lists) || [];
};

// 旧版移动端搜索：只支持 HTTP，字段最少（没有发行日期），放在最后
KG.searchMobile = function (keyword, page, pageSize) {
  var url = "http://mobilecdn.kugou.com/api/v3/search/song?format=json&showtype=1" +
    "&keyword=" + encodeURIComponent(keyword) + "&page=" + page + "&pagesize=" + pageSize;
  var root = KG.checkCode(KG.getJson(url, { "User-Agent": "Mozilla/5.0" }, Meta.SEARCH_HTTP_OPTIONS));
  return ((root.data || {}).info) || [];
};

// 酷狗把同一首歌在其他专辑里的版本折叠在 Grp（旧接口叫 group）里。展开成独立的结果，紧跟在主结果后面
KG.expand = function (list) {
  var out = [];
  var seen = {};
  list.forEach(function (x) {
    [x].concat(x.Grp || x.group || []).forEach(function (raw) {
      var item = KG.normalize(raw);
      if (!item.id || !item.title || seen[item.id]) return;
      seen[item.id] = true;
      out.push(item);
    });
  });
  return out;
};

KG.SEARCHERS = [
  { name: "complex", run: KG.searchComplex },
  { name: "web", run: KG.searchWeb },
  { name: "mobile", run: KG.searchMobile }
];

KG.COOLDOWN_MS = 2 * 60 * 1000;

// 先查缓存；再依次尝试各个搜索接口（被限流的冷却 2 分钟、排到最后）
KG.search = function (keyword, page, pageSize) {
  pageSize = Meta.fetchSize(pageSize);
  var cacheKey = Meta.searchCacheKey("kg.search.v3.", keyword, page, pageSize);
  var cached = Meta.cacheGet(cacheKey);
  if (cached) return cached;

  var ready = KG.SEARCHERS.filter(function (s) { return !Meta.cacheGet("kg.cooldown." + s.name); });
  var order = ready.concat(KG.SEARCHERS.filter(function (s) { return ready.indexOf(s) < 0; }));
  var startedAt = Date.now();
  for (var i = 0; i < order.length; i++) {
    if (i > 0 && Date.now() - startedAt > 7000) break;
    try {
      var items = KG.expand(order[i].run(keyword, page, pageSize));
      if (items.length) {
        Meta.cacheSet(cacheKey, items, Meta.SEARCH_CACHE_TTL_MS);
        return items;
      }
    } catch (e) {
      Meta.cacheSet("kg.cooldown." + order[i].name, true, KG.COOLDOWN_MS);
      Platform.log.warn("KGMeta", order[i].name + " search failed: " + Meta.errMsg(e));
    }
  }
  return [];
};

KG.buildCoverUrl = function (image, size) {
  if (!image) return "";
  var url = String(image).replace(/^http:\/\//, "https://");
  // {size} 留空就是原图（链接里会出现双斜杠，酷狗图床能正常返回）
  return url.replace("{size}", size && size !== "original" ? size : "");
};

// 酷狗标签里 pid=3 的是流派大类（流行、摇滚、舞曲……），它们的子标签是细分流派
// ACG、原声带更像「用在哪」而不是曲风，排到后面
KG.CONTEXT_GENRE_IDS = { "77": true, "3069": true };

KG.genresFromTags = function (tags) {
  tags = Array.isArray(tags) ? tags : [];
  var mains = tags.filter(function (t) { return Number(t.pid) === 3 && t.name; });
  mains.sort(function (a, b) {
    return (KG.CONTEXT_GENRE_IDS[String(a.id)] ? 1 : 0) - (KG.CONTEXT_GENRE_IDS[String(b.id)] ? 1 : 0);
  });
  return mains.map(function (m) {
    var sub = tags.filter(function (t) { return Number(t.pid) === Number(m.id) && t.name; })[0];
    return { main: String(m.name), sub: sub ? String(sub.name) : "" };
  });
};

KG.formatGenres = function (genres, style, separator) {
  return Meta.joinUnique((genres || []).map(function (g) {
    if (style === "main") return g.main;
    if (style === "sub") return g.sub || g.main;
    return g.sub ? g.main + "-" + g.sub : g.main;
  }), separator);
};

KG.AUDIO_BATCH = 30;
KG.ALBUM_BATCH = 30;

// 手动搜索时只给排在最前面的这么多条结果查详情（歌曲、专辑各 1 个请求），其余结果只带搜索结果自带的信息
KG.DETAIL_MAX = 30;

// 详情：歌曲批量接口给作词、作曲、音轨号、碟号、语种、流派标签；专辑批量接口给专辑艺术家和唱片公司。查过的都缓存
KG.fetchExtras = function (items, startedAt) {
  var deadline = (startedAt || Date.now()) + Meta.DETAIL_DEADLINE_MS;
  var songInfo = {};
  var albumInfo = {};
  var needSongs = [];
  var needAlbums = [];

  items.forEach(function (item) {
    if (item.id && !(item.id in songInfo)) {
      songInfo[item.id] = Meta.cacheGet("kg.song." + item.id);
      if (!songInfo[item.id]) needSongs.push(item.id);
    }
    if (item.albumId && item.albumId !== "0" && !(item.albumId in albumInfo)) {
      albumInfo[item.albumId] = Meta.cacheGet("kg.album." + item.albumId);
      if (!albumInfo[item.albumId]) needAlbums.push(item.albumId);
    }
  });

  for (var i = 0; i < needSongs.length && Date.now() < deadline; i += KG.AUDIO_BATCH) {
    try {
      var res = KG.gateway("/kmr/v2/audio", {
        data: needSongs.slice(i, i + KG.AUDIO_BATCH).map(function (id) { return { entity_id: Number(id) }; }),
        fields: "base,extra,tags"
      }, { "x-router": "openapi.kugou.com", "KG-TID": "238" });
      (res.data || []).forEach(function (d) {
        var base = (d && d.base) || {};
        var extra = (d && d.extra) || {};
        var id = String(base.album_audio_id || "");
        if (!id) return;
        songInfo[id] = {
          lyricists: Meta.unique(Meta.splitNames(extra.lyrics)),
          composers: Meta.unique(Meta.splitNames(extra.composer)),
          trackIndex: extra.sort,
          disc: extra.disc,
          language: String(base.language || ""),
          date: String(base.publish_date || ""),
          genres: KG.genresFromTags(d.tags)
        };
        Meta.cacheSet("kg.song." + id, songInfo[id]);
      });
    } catch (e) {
      Platform.log.warn("KGMeta", "audio detail failed: " + Meta.errMsg(e));
      break;
    }
  }

  for (var j = 0; j < needAlbums.length && Date.now() < deadline; j += KG.ALBUM_BATCH) {
    try {
      var albums = KG.gateway("/kmr/v2/albums", {
        data: needAlbums.slice(j, j + KG.ALBUM_BATCH).map(function (id) { return { album_id: id }; }),
        is_buy: 0,
        fields: "album_id,album_name,authors,publish_company,publish_date,type"
      }, { "x-router": "openapi.kugou.com", "kg-tid": "255" });
      (albums.data || []).forEach(function (a) {
        if (!a || !a.album_id) return;
        var id = String(a.album_id);
        albumInfo[id] = {
          artists: Meta.unique((a.authors || []).map(function (x) { return x.author_name; })),
          company: String(a.publish_company || ""),
          date: String(a.publish_date || "")
        };
        Meta.cacheSet("kg.album." + id, albumInfo[id]);
      });
    } catch (e) {
      Platform.log.warn("KGMeta", "album detail failed: " + Meta.errMsg(e));
      break;
    }
  }

  return items.map(function (item) {
    var song = songInfo[item.id] || {};
    var album = albumInfo[item.albumId] || {};
    return {
      lyricists: song.lyricists || [],
      composers: song.composers || [],
      trackIndex: song.trackIndex,
      disc: song.disc,
      language: song.language || "",
      genres: song.genres || [],
      date: song.date || "",
      // 专辑自己的发行日期：搜索结果和歌曲详情里的日期是这首歌首次发行的日期，
      // 同一首歌后来收进别的专辑时，日期要跟着专辑走
      albumDate: album.date || "",
      albumArtists: album.artists || [],
      copyright: album.company || ""
    };
  });
};
