// 批量匹配封面（三个插件中的本文件内容相同）。
//
// 规则：
//   1. 只认本地文件已有的「歌名 + 歌手 + 专辑」。平台上的结果要歌名、歌手、专辑三样都对得上才算数；
//      专辑名不一样的版本一律不用，不会因为别的专辑封面像素更高就拿来。
//   2. QQ 音乐、网易云、酷狗三个平台都查。有这张专辑的平台各量出原图的真实像素，用最大的那张；
//      哪个平台没有（或者接口出错）就用其余平台的。
//   3. 三个平台都没有这张专辑时不返回封面，Lyrico 会跳过这首歌。
var CoverHunt = CoverHunt || {};

// Lyrico 一次调用最多 15 秒。搜索用到第 10 秒为止，之后不再发新的搜索，已经找到的照常比较；
// 量像素最晚到第 13 秒
CoverHunt.BUDGET_MS = 10000;
CoverHunt.PROBE_DEADLINE_MS = 13000;
CoverHunt.SEARCH_SIZE = 10;

// 请求的超时不超过离 deadlineMs 剩下的时间
CoverHunt.httpOptions = function (ctx, deadlineMs) {
  var left = Math.max(1000, ctx.startedAt + (deadlineMs || CoverHunt.BUDGET_MS) - Date.now());
  return { connectTimeoutMs: Math.min(3000, left), readTimeoutMs: Math.min(5000, left) };
};

// ---------------- 三个平台的搜索 ----------------
// songs(keyword)  搜歌，返回 [{ title, artist, album, date, url }]，同一首歌在其他专辑里的版本也展开；
// albums(keyword) 搜专辑，返回 [{ artist, album, date, url }]。
// url 都是原图链接（平台上最大的那张）

CoverHunt.QQ = {
  name: "qq",
  request: function (keyword, type, options) {
    var root = JSON.parse(Platform.http.getText(
      "https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?format=json&aggr=1&p=1&n=" + CoverHunt.SEARCH_SIZE +
        (type ? "&t=" + type : "") + "&w=" + encodeURIComponent(keyword),
      Object.assign({ headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://y.qq.com/" } }, options)
    ));
    if (root.code !== 0) throw new Error("code " + root.code);
    return root.data || {};
  },
  cover: function (albumMid) {
    return albumMid ? "https://y.gtimg.cn/music/photo_new/T002M000" + albumMid + ".jpg" : "";
  },
  songs: function (keyword, options) {
    var out = [];
    (((CoverHunt.QQ.request(keyword, 0, options).song || {}).list) || []).forEach(function (x) {
      [x].concat(x.grp || []).forEach(function (s) {
        out.push({
          title: s.songname,
          artist: (s.singer || []).map(function (a) { return a.name; }).join("/"),
          album: s.albumname,
          date: s.pubtime ? Meta.formatDateCst(Number(s.pubtime) * 1000) : "",
          url: CoverHunt.QQ.cover(s.albummid)
        });
      });
    });
    return out;
  },
  albums: function (keyword, options) {
    return (((CoverHunt.QQ.request(keyword, 8, options).album || {}).list) || []).map(function (a) {
      var singers = (a.singer_list || []).map(function (s) { return s.name; }).filter(Boolean);
      return {
        artist: singers.length ? singers.join("/") : a.singerName,
        album: a.albumName,
        date: String(a.publicTime || ""),
        url: CoverHunt.QQ.cover(a.albumMID)
      };
    });
  }
};

CoverHunt.NETEASE = {
  name: "netease",
  request: function (keyword, type, options) {
    var body = "s=" + encodeURIComponent(keyword) + "&type=" + type + "&offset=0&limit=" + CoverHunt.SEARCH_SIZE;
    var root = JSON.parse(Platform.http.postText("https://music.163.com/api/cloudsearch/pc", body, Object.assign({
      contentType: "application/x-www-form-urlencoded; charset=utf-8",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Referer": "https://music.163.com/"
      }
    }, options)));
    if (root.code !== 200) throw new Error("code " + root.code);
    return root.result || {};
  },
  cover: function (picUrl) {
    var url = String(picUrl || "").replace(/^http:\/\//, "https://").split("?")[0];
    // 没有封面的专辑，网易云给的是同一张默认唱片图，不能当封面用
    return /\/3132508627578625\.jpg$/.test(url) ? "" : url;
  },
  names: function (artists) {
    return (artists || []).map(function (a) { return a.name; }).filter(Boolean).join("/");
  },
  songs: function (keyword, options) {
    return (CoverHunt.NETEASE.request(keyword, 1, options).songs || []).map(function (s) {
      var album = s.al || {};
      return {
        title: s.name,
        artist: CoverHunt.NETEASE.names(s.ar),
        album: album.name,
        date: Meta.formatDateCst(s.publishTime),
        url: CoverHunt.NETEASE.cover(album.picUrl)
      };
    });
  },
  albums: function (keyword, options) {
    return (CoverHunt.NETEASE.request(keyword, 10, options).albums || []).map(function (a) {
      return {
        artist: CoverHunt.NETEASE.names(a.artists && a.artists.length ? a.artists : [a.artist || {}]),
        album: a.name,
        date: Meta.formatDateCst(a.publishTime),
        url: CoverHunt.NETEASE.cover(a.picUrl)
      };
    });
  }
};

CoverHunt.KUGOU = {
  name: "kugou",
  SALT: "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA",
  // 用客户端的签名搜索接口：网页版接口连续请求几次后会返回空列表
  request: function (path, keyword, options) {
    var params = {
      userid: "0", appid: "3116", token: "", clienttime: String(Math.floor(Date.now() / 1000)),
      iscorrection: "1", uuid: "-", mid: Platform.crypto.md5(String(Date.now())), dfid: "-",
      clientver: "11070", platform: "AndroidFilter", keyword: keyword, page: "1", pagesize: String(CoverHunt.SEARCH_SIZE)
    };
    var keys = Object.keys(params).sort();
    var salt = CoverHunt.KUGOU.SALT;
    var signature = Platform.crypto.md5(salt + keys.map(function (k) { return k + "=" + params[k]; }).join("") + salt);
    var query = keys.map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); }).join("&") +
      "&signature=" + signature;
    var root = JSON.parse(Platform.http.getText("https://complexsearch.kugou.com" + path + "?" + query, Object.assign({
      headers: { "User-Agent": "Android14-1070-11070-201-0-SearchSong-wifi", "x-router": "complexsearch.kugou.com" }
    }, options)));
    if (root.status !== 1) throw new Error("code " + root.error_code);
    return (root.data || {}).lists || [];
  },
  // 酷狗的封面链接里有一段尺寸（搜歌给的是 {size} 占位，搜专辑给的是 240），去掉这一段就是原图。
  // 固定尺寸会把小图放大，所以只用原图。softhead 开头的是歌手头像，不是封面
  cover: function (image) {
    var url = String(image || "").replace(/^http:\/\//, "https://");
    if (!url || url.indexOf("/softhead/") >= 0) return "";
    return url.replace("{size}/", "").replace(/\/stdmusic\/\d{2,4}\//, "/stdmusic/");
  },
  text: function (value) {
    return String(value == null ? "" : value).replace(/<[^>]+>/g, "").trim();
  },
  names: function (singers, fallback) {
    var names = (Array.isArray(singers) ? singers : []).map(function (a) { return a.name; }).filter(Boolean);
    return CoverHunt.KUGOU.text(names.length ? names.join("/") : String(fallback || "").split("、").join("/"));
  },
  date: function (value) {
    var date = String(value || "").slice(0, 10);
    return /^0000/.test(date) ? "" : date;
  },
  songs: function (keyword, options) {
    var out = [];
    CoverHunt.KUGOU.request("/v2/search/song", keyword, options).forEach(function (x) {
      [x].concat(x.Grp || []).forEach(function (s) {
        out.push({
          title: CoverHunt.KUGOU.text(s.SongName),
          artist: CoverHunt.KUGOU.names(s.Singers, s.SingerName),
          album: CoverHunt.KUGOU.text(s.AlbumName),
          date: CoverHunt.KUGOU.date(s.PublishDate),
          url: CoverHunt.KUGOU.cover(s.Image || (s.trans_param || {}).union_cover)
        });
      });
    });
    return out;
  },
  albums: function (keyword, options) {
    return CoverHunt.KUGOU.request("/v1/search/album", keyword, options).map(function (a) {
      return {
        artist: CoverHunt.KUGOU.names(a.singers, a.singer),
        album: CoverHunt.KUGOU.text(a.albumname),
        date: CoverHunt.KUGOU.date(a.publish_time),
        url: CoverHunt.KUGOU.cover(a.img)
      };
    });
  }
};

// ---------------- 判断是不是同一首歌、同一张专辑 ----------------

// 没写标签的文件，Lyrico 可能给「未知」这类占位文字，当作没有
CoverHunt.clean = function (text) {
  var value = String(text == null ? "" : text).trim();
  return /^(?:未知.{0,4}|<?unknown>?(?:\s+(?:album|artist|title))?)$/i.test(value) ? "" : value;
};

// 比较用的写法：不分大小写、全角半角，忽略空格和标点（「What's Going On…?」和「What's Going On...?」是同一个名字）。
// 全是符号的名字（比如专辑「÷」）保留原样
CoverHunt.key = function (text) {
  var folded = String(text == null ? "" : text)
    .replace(/[\uFF01-\uFF5E]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); });
  // \u2000-\u206F 是省略号、各种横线和引号，\u3000-\u303F 是中日文标点
  var plain = folded.replace(/[\u2000-\u206F\u3000-\u303F\u30FB\u00B7]/g, " ");
  return Meta.normText(plain).replace(/ /g, "") || folded.trim().toLowerCase();
};

// 歌名末尾的括号如果只是别名、译名、合作歌手（「夜に駆ける (向夜晚奔去)」「xx (feat. yy)」）不影响判断；
// 是现场、混音、伴奏、其他语言这类版本说明就要保留，「xx (Live)」和「xx」不是同一首
CoverHunt.VERSION_NOTE_RE = /live|remix|mix|inst|demo|cover|ver\b|version|edit\b|remaster|acoustic|karaoke|dj|伴奏|现场|演唱会|翻自|翻唱|纯音乐|国语|粤语|日语|日文|英文|韩语|韩文|中文|版|站/i;

CoverHunt.baseTitle = function (title) {
  var text = String(title == null ? "" : title);
  var m = /^(.*\S)\s*[(（\[【]([^()（）\[\]【】]*)[)）\]】]\s*$/.exec(text);
  return m && !CoverHunt.VERSION_NOTE_RE.test(m[2]) ? m[1] : text;
};

CoverHunt.sameTitle = function (a, b) {
  var ka = CoverHunt.key(a);
  var kb = CoverHunt.key(b);
  if (!ka || !kb) return false;
  return ka === kb || CoverHunt.key(CoverHunt.baseTitle(a)) === CoverHunt.key(CoverHunt.baseTitle(b));
};

// 一个歌手名的几种写法。平台会在名字后面加括号注明本名或读音
// （「冯沁苑(买辣椒也用券)」「米津玄師 (よねづ けんし)」），或者中外文并列（「G.E.M. 邓紫棋」），拆开各算一种。
// 只认整个名字相同，不认「包含」：「周杰伦」和翻唱账号「周杰伦翻唱集」不是一个人
CoverHunt.CJK = "\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF";

CoverHunt.artistKeys = function (name) {
  var text = String(name == null ? "" : name).trim();
  var keys = [CoverHunt.key(text)];
  var m = /^(.*?)\s*[(（]([^()（）]+)[)）]\s*$/.exec(text);
  if (m) {
    keys.push(CoverHunt.key(m[1]), CoverHunt.key(m[2]));
  } else {
    var cjk = CoverHunt.key(text.replace(new RegExp("[^" + CoverHunt.CJK + "]+", "g"), " "));
    var other = CoverHunt.key(text.replace(new RegExp("[" + CoverHunt.CJK + "]+", "g"), " "));
    if (cjk.length >= 2 && other.length >= 3) keys.push(cjk, other);
  }
  return keys.filter(Boolean);
};

CoverHunt.artistNames = function (text) {
  var names = [];
  Meta.splitNames(text).forEach(function (name) {
    name.split(/\s+(?:feat\.?|ft\.?|featuring|with|x|×)\s+/i).forEach(function (part) {
      if (part.trim()) names.push(part.trim());
    });
  });
  return names;
};

// 有一个歌手对得上就行（合唱歌曲各平台列的歌手不一样多）
CoverHunt.sameArtist = function (a, b) {
  var mine = {};
  CoverHunt.artistNames(a).forEach(function (name) {
    CoverHunt.artistKeys(name).forEach(function (k) { mine[k] = true; });
  });
  return CoverHunt.artistNames(b).some(function (name) {
    return CoverHunt.artistKeys(name).some(function (k) { return mine[k] === true; });
  });
};

// 专辑名必须相同。「xx」和「xx (Deluxe)」「xx (通常盤)」「xx 精选」是不同的专辑，封面可能不一样，不算同一张。
// 只有两种平台加在专辑名后面的标注不算专辑名的一部分：
//   「(Explicit)」「(Clean)」，以及说明出处的「(电影《xx》主题曲)」这一类。
// 加号要算：「F*CK LOVE 3」和「F*CK LOVE 3+」是两张专辑
CoverHunt.ALBUM_NOTE_RE = /^\s*(?:explicit|clean)\s*$|主[题題]曲|片[头頭尾]曲|插曲|推[广廣]曲|宣[传傳]曲|主題歌|挿入歌/i;

CoverHunt.albumKey = function (album) {
  var text = String(album == null ? "" : album);
  for (var i = 0; i < 2; i++) {
    var m = /^(.*\S)\s*[(（\[【]([^()（）\[\]【】]*)[)）\]】]\s*$/.exec(text);
    if (!m || !CoverHunt.ALBUM_NOTE_RE.test(m[2])) break;
    text = m[1];
  }
  return CoverHunt.key(text.replace(/[+＋]/g, " plus "));
};

CoverHunt.sameAlbum = function (a, b) {
  var ka = CoverHunt.albumKey(a);
  return !!ka && ka === CoverHunt.albumKey(b);
};

CoverHunt.hasSong = function (list, want) {
  return list.some(function (c) {
    return CoverHunt.sameTitle(c.title, want.title) && CoverHunt.sameArtist(c.artist, want.artist);
  });
};

// 从搜索结果里挑出对得上的那条，没有返回 null。
// 搜歌的结果要歌名、歌手、专辑都对得上；搜专辑的结果没有歌名，要歌手、专辑对得上。
// 本地文件没有专辑名时（want.album 为空）只看歌名和歌手，取平台排在最前面的版本。
// 对得上的不止一条时（同名专辑再版），优先发行年份和本地文件相同的
CoverHunt.pick = function (list, want) {
  var first = null;
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (!c.url || !c.album || !CoverHunt.sameArtist(c.artist, want.artist)) continue;
    if (c.title != null && !CoverHunt.sameTitle(c.title, want.title)) continue;
    if (want.album && !CoverHunt.sameAlbum(c.album, want.album)) continue;
    if (want.year && String(c.date || "").slice(0, 4) === want.year) return c;
    if (!first) first = c;
  }
  return first;
};

// ---------------- 查找 ----------------

// 搜索结果缓存 6 小时，重跑同一批歌时不用再请求
CoverHunt.search = function (platform, kind, keyword, ctx) {
  var cacheKey = Meta.searchCacheKey("hunt2." + platform.name + "." + kind + ".", keyword, 1, CoverHunt.SEARCH_SIZE);
  var list = Meta.cacheGet(cacheKey);
  if (list) return list;
  if (Date.now() - ctx.startedAt > CoverHunt.BUDGET_MS) throw new Error("out of time");
  list = platform[kind](keyword, CoverHunt.httpOptions(ctx));
  if (list.length) Meta.cacheSet(cacheKey, list, Meta.SEARCH_CACHE_TTL_MS);
  return list;
};

// 在一个平台上找这首歌所在的这张专辑，找不到（或接口出错）返回 null
CoverHunt.locate = function (platform, want, ctx) {
  try {
    // 第一步：按「歌名 歌手」搜歌。大多数歌到这里就找到了，只用一个请求
    var songs = CoverHunt.search(platform, "songs", ctx.keyword, ctx);
    var found = CoverHunt.pick(songs, want);
    if (found || !want.album) return found;

    // 第二步：这首歌平台上有，但前几条里没有这张专辑（收录它的专辑太多），关键词加上专辑名再搜一次
    if (CoverHunt.hasSong(songs, want)) {
      found = CoverHunt.pick(CoverHunt.search(platform, "songs", ctx.keyword + " " + want.album, ctx), want);
      if (found) return found;
    }

    // 第三步：直接搜这张专辑。歌名在平台上的写法和本地不一样时，搜歌是对不上的
    var artist = Meta.splitNames(want.artist)[0] || want.artist;
    return CoverHunt.pick(CoverHunt.search(platform, "albums", want.album + " " + artist, ctx), want);
  } catch (e) {
    Platform.log.warn("CoverHunt", platform.name + " failed: " + Meta.errMsg(e));
    return null;
  }
};

// 量出封面的真实像素（只下载开头 32KB）。失败时再试一次，还不行就当这张图不能用
CoverHunt.probe = function (url, ctx) {
  for (var attempt = 0; attempt < 2; attempt++) {
    if (Date.now() - ctx.startedAt > CoverHunt.PROBE_DEADLINE_MS - 1000) break;
    var info = Meta.probeImage(url, null, CoverHunt.httpOptions(ctx, CoverHunt.PROBE_DEADLINE_MS));
    if (info) return info;
  }
  return null;
};

// platforms 是要查的平台，按优先顺序排（像素相同时用排在前面的）。
// 返回 Lyrico 封面结果格式的一条结果；哪个平台都没有这张专辑时返回 null
CoverHunt.find = function (request, platforms) {
  var song = request.song || {};
  var want = {
    title: CoverHunt.clean(song.title),
    artist: CoverHunt.clean(song.artist),
    album: CoverHunt.clean(song.album),
    year: (/^\d{4}/.exec(String(song.date || "")) || [""])[0]
  };
  // 没有歌名或歌手就没法确认是不是同一首歌
  if (!want.title || !want.artist) return null;

  var ctx = { startedAt: Date.now(), keyword: want.title + " " + (Meta.splitNames(want.artist).join(" ") || want.artist) };
  var options = Meta.readCoverConfig(request.config);

  var best = null;
  platforms.forEach(function (platform) {
    var item = CoverHunt.locate(platform, want, ctx);
    if (!item) return;
    // 本地文件没有专辑名：以先找到的这个版本为准，后面的平台要是同一张专辑才参与比较
    if (!want.album) want = Object.assign({}, want, { album: item.album });

    var info = CoverHunt.probe(item.url, ctx);
    if (!info) return;
    var pixels = Math.min(info.width, info.height) || 0;
    if (!best || pixels > best.pixels) best = { platform: platform.name, item: item, info: info, pixels: pixels };
  });

  if (!best) return null;
  if (options.minPixels && best.pixels < options.minPixels) return null;
  Platform.log.debug("CoverHunt", want.title + " / " + want.album + " → " + best.platform + " " + best.pixels + "px");

  var url = Meta.finalCoverUrl(best.item.url, best.info);
  return {
    // 是不是同一首歌上面已经判断过了，这里用本地文件的写法，Lyrico 评分时不会因为平台多写了别名而落选
    title: want.title,
    artist: want.artist,
    album: CoverHunt.clean(song.album) || best.item.album,
    date: best.item.date || String(song.date || "") || "未知",
    duration: Number(song.duration || 0),
    picUrl: url,
    fields: { cover_url: url },
    internal: { cover_from: best.platform, cover_pixels: String(best.pixels || "") }
  };
};
