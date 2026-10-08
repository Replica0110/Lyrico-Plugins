var NE = NE || {};

NE.HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "Referer": "https://music.163.com/"
};

NE.postForm = function (url, params, httpOptions) {
  var body = Object.keys(params)
    .map(function (key) {
      return encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key]));
    })
    .join("&");
  var text = Platform.http.postText(url, body, Object.assign({
    contentType: "application/x-www-form-urlencoded; charset=utf-8",
    headers: NE.HEADERS
  }, httpOptions || {}));
  return JSON.parse(text);
};

// eapi：网易云客户端用的加密接口（算法来自开源项目 NeteaseCloudMusicApi）。逐字歌词只有它返回
NE.EAPI_KEY = "e82ckenh8dichen8";
NE.EAPI_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.3.203419",
  "Referer": "https://music.163.com/",
  "Cookie": "os=pc; appver=3.1.3.203419; osver=Microsoft-Windows-10-Professional-build-19045-64bit"
};

NE.eapi = function (path, params, httpOptions) {
  var text = JSON.stringify(params);
  var digest = Platform.crypto.md5("nobody" + path + "use" + text + "md5forencrypt");
  var data = path + "-36cd479b6b5-" + text + "-36cd479b6b5-" + digest;
  var body = "params=" + Platform.crypto.aesEcbPkcs5EncryptHex(data, NE.EAPI_KEY);
  var res = Platform.http.postText("https://interface.music.163.com/eapi" + path.replace(/^\/api/, ""), body, Object.assign({
    contentType: "application/x-www-form-urlencoded",
    headers: NE.EAPI_HEADERS
  }, httpOptions || {}));
  return JSON.parse(res);
};

NE.checkCode = function (root) {
  if (!root || root.code !== 200) throw new Error("code " + (root && root.code));
  return root;
};

NE.searchApi = function (keyword, page, pageSize) {
  return NE.checkCode(NE.postForm("https://music.163.com/api/cloudsearch/pc", {
    s: keyword,
    type: 1,
    offset: Math.max(0, (page - 1) * pageSize),
    limit: pageSize
  }, Meta.SEARCH_HTTP_OPTIONS));
};

NE.searchEapi = function (keyword, page, pageSize) {
  return NE.checkCode(NE.eapi("/api/cloudsearch/pc", {
    s: keyword,
    type: 1,
    offset: Math.max(0, (page - 1) * pageSize),
    limit: pageSize,
    total: true
  }, Meta.SEARCH_HTTP_OPTIONS));
};

// 只保留插件用到的字段，缓存更小
NE.trimSong = function (song) {
  var album = song.al || song.album || {};
  return {
    id: song.id,
    name: song.name,
    ar: (song.ar || song.artists || []).map(function (a) { return { name: a.name }; }),
    al: { id: album.id, name: album.name, picUrl: album.picUrl },
    alia: song.alia || song.alias || [],
    publishTime: song.publishTime,
    no: song.no,
    cd: song.cd,
    dt: song.dt || song.duration
  };
};

// 先查缓存；网页接口被拒（例如请求太频繁）时改用 eapi 接口
NE.search = function (keyword, page, pageSize) {
  pageSize = Meta.fetchSize(pageSize);
  var cacheKey = Meta.searchCacheKey("ne.search.v2.", keyword, page, pageSize);
  var cached = Meta.cacheGet(cacheKey);
  if (cached) return cached;

  var searchers = [{ name: "api", run: NE.searchApi }, { name: "eapi", run: NE.searchEapi }];
  var ready = searchers.filter(function (s) { return !Meta.cacheGet("ne.cooldown." + s.name); });
  var order = ready.concat(searchers.filter(function (s) { return ready.indexOf(s) < 0; }));
  var lastError = null;

  for (var i = 0; i < order.length; i++) {
    try {
      var root = order[i].run(keyword, page, pageSize);
      var songs = ((root.result || {}).songs || []).map(NE.trimSong);
      if (songs.length) Meta.cacheSet(cacheKey, songs, Meta.SEARCH_CACHE_TTL_MS);
      return songs;
    } catch (e) {
      lastError = e;
      Meta.cacheSet("ne.cooldown." + order[i].name, true, 2 * 60 * 1000);
      Platform.log.warn("NEMeta", order[i].name + " search failed: " + Meta.errMsg(e));
    }
  }
  throw lastError || new Error("search failed");
};

NE.buildCoverUrl = function (picUrl, size) {
  if (!picUrl) return "";
  var url = String(picUrl).replace(/^http:\/\//, "https://").split("?")[0];
  return size && size !== "original" ? url + "?param=" + size + "y" + size : url;
};

NE.formatGenre = function (tag, style) {
  var parts = String(tag || "").split("-").map(function (s) { return s.trim(); }).filter(Boolean);
  if (!parts.length) return "";
  if (style === "main") return parts[0];
  if (style === "sub") return parts[parts.length - 1];
  return parts.join("-");
};

// 「音乐百科」里的曲风（原始形如「流行-华语流行」）和语种
NE.parseWiki = function (wiki) {
  var blocks = ((wiki || {}).data || {}).blocks || [];
  var genres = [];
  var languages = [];
  blocks.forEach(function (block) {
    if (!block || block.code !== "SONG_PLAY_ABOUT_SONG_BASIC") return;
    (block.creatives || []).forEach(function (c) {
      if (!c) return;
      if (c.creativeType === "songTag") {
        (c.resources || []).forEach(function (r) {
          var title = (((r || {}).uiElement || {}).mainTitle || {}).title;
          if (title) genres.push(title);
        });
      } else if (c.creativeType === "language") {
        ((c.uiElement || {}).textLinks || []).forEach(function (t) {
          if (t && t.text) languages.push(t.text);
        });
      }
    });
  });
  return { genres: Meta.unique(genres), languages: Meta.unique(languages) };
};

NE.parseAlbum = function (album) {
  var artists = (Array.isArray(album.artists) && album.artists.length)
    ? album.artists
    : (album.artist ? [album.artist] : []);
  return {
    artists: Meta.unique(artists.map(function (a) { return a.name; })),
    company: String(album.company || "").trim(),
    date: Meta.formatDateCst(album.publishTime)
  };
};

// /api/batch 一次最多约 50 个子请求，同一路径只能出现一次。
// 服务器会忽略路径里多余的斜杠，所以 /api/song/lyric、/api//song/lyric … 可以各查一首歌词；
// 「音乐百科」只认原路径和末尾加一个斜杠的写法，每次最多查 2 首。
NE.MAX_SUBREQUESTS = 45;
NE.MAX_LYRICS_PER_BATCH = 20;
NE.WIKI_KEYS = ["/api/song/play/about/block/page", "/api/song/play/about/block/page/"];

NE.lyricKey = function (n) {
  return "/api" + "/".repeat(n + 1) + "song/lyric";
};

NE.runBatch = function (plan) {
  var params = {};
  plan.lyrics.forEach(function (id, n) {
    params[NE.lyricKey(n)] = JSON.stringify({ id: Number(id), lv: 1 });
  });
  plan.wikis.forEach(function (id, n) {
    params[NE.WIKI_KEYS[n]] = JSON.stringify({ songId: String(id) });
  });
  plan.albums.forEach(function (id) {
    params["/api/v1/album/" + id] = "{}";
  });
  return NE.postForm("https://music.163.com/api/batch", params, Meta.DETAIL_HTTP_OPTIONS);
};

// 查询作词作曲、专辑信息和曲风语种：歌词与专辑全部结果一次查完，百科只查前 2 首；查过的直接读缓存
NE.fetchExtras = function (songs, startedAt) {
  var deadline = (startedAt || Date.now()) + Meta.DETAIL_DEADLINE_MS;
  var songInfo = {};
  var albumInfo = {};
  var wikiInfo = {};
  var needLyrics = [];
  var needAlbums = [];
  var needWikis = [];

  songs.forEach(function (song, i) {
    var id = String(song.id || "");
    if (!id) return;
    var albumId = String(((song.al || song.album) || {}).id || "");

    if (!(id in songInfo)) {
      songInfo[id] = Meta.cacheGet("ne.song." + id);
      if (!songInfo[id] && needLyrics.indexOf(id) < 0) needLyrics.push(id);
    }
    if (albumId && albumId !== "0" && !(albumId in albumInfo)) {
      albumInfo[albumId] = Meta.cacheGet("ne.album." + albumId);
      if (!albumInfo[albumId]) needAlbums.push(albumId);
    }
    if (i < NE.WIKI_KEYS.length && !(id in wikiInfo)) {
      wikiInfo[id] = Meta.cacheGet("ne.wiki." + id);
      if (!wikiInfo[id]) needWikis.push(id);
    }
  });

  var plans = [];
  while (needLyrics.length || needAlbums.length || needWikis.length) {
    var plan = {
      lyrics: needLyrics.splice(0, NE.MAX_LYRICS_PER_BATCH),
      wikis: needWikis.splice(0, NE.WIKI_KEYS.length),
      albums: []
    };
    plan.albums = needAlbums.splice(0, NE.MAX_SUBREQUESTS - plan.lyrics.length - plan.wikis.length);
    plans.push(plan);
  }

  plans.forEach(function (plan) {
    if (Date.now() > deadline) return;
    var res;
    try {
      res = NE.runBatch(plan);
      if (!res || res.code !== 200) throw new Error("batch code " + (res && res.code));
    } catch (e) {
      Platform.log.warn("NEMeta", "detail batch failed: " + Meta.errMsg(e));
      // 多斜杠写法如果失效，退回只查第一首（只用标准路径）
      if (plan.lyrics.length <= 1) return;
      plan = { lyrics: plan.lyrics.slice(0, 1), wikis: plan.wikis.slice(0, 1), albums: plan.albums.slice(0, 1) };
      try {
        res = NE.runBatch(plan);
        if (!res || res.code !== 200) return;
      } catch (e2) {
        return;
      }
    }

    plan.lyrics.forEach(function (id, n) {
      var r = res[NE.lyricKey(n)];
      if (!r || r.code !== 200) return;
      songInfo[id] = Meta.parseCredits(((r.lrc || {}).lyric) || "");
      Meta.cacheSet("ne.song." + id, songInfo[id]);
    });
    plan.wikis.forEach(function (id, n) {
      var r = res[NE.WIKI_KEYS[n]];
      if (!r || r.code !== 200) return;
      wikiInfo[id] = NE.parseWiki(r);
      Meta.cacheSet("ne.wiki." + id, wikiInfo[id]);
    });
    plan.albums.forEach(function (id) {
      var r = res["/api/v1/album/" + id];
      if (!r || r.code !== 200 || !r.album) return;
      albumInfo[id] = NE.parseAlbum(r.album);
      Meta.cacheSet("ne.album." + id, albumInfo[id]);
    });
  });

  return songs.map(function (song) {
    var id = String(song.id || "");
    var albumId = String(((song.al || song.album) || {}).id || "");
    var credits = songInfo[id] || {};
    var album = albumInfo[albumId] || {};
    var wiki = wikiInfo[id] || {};
    return {
      lyricists: credits.lyricists || [],
      composers: credits.composers || [],
      albumArtists: album.artists || [],
      copyright: album.company || "",
      date: album.date || "",
      genres: wiki.genres || [],
      languages: wiki.languages || []
    };
  });
};
