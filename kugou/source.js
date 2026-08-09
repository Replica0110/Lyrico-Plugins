function mapSong(item, separator) {
  const singers = Array.isArray(item.Singers) ? item.Singers : [];
  const artist = singers.map(s => s.name || s.Name || "").filter(Boolean).join(separator || "/");
  const title = String(item.SongName || "");
  const album = String(item.AlbumName || "");
  const date = String(item.PublishDate || "");
  const coverUrl = normalizeImage(item.Image);
  const hash = String(item.FileHash || "");
  return {
    id: String(item.ID || ""),
    title: title,
    artist: artist,
    album: album,
    duration: Number(item.Duration || 0) * 1000,
    date: date,
    picUrl: coverUrl,
    fields: {
      title: title,
      artist: artist,
      album: album,
      date: date,
      cover_url: coverUrl,
      comment: String(item.Auxiliary || "")
    },
    internal: {
      hash: hash
    }
  };
}

function searchSongs(request) {
  const params = signParams({
    keyword: request.keyword || "",
    page: String(request.page || 1),
    pagesize: String(request.pageSize || 20)
  }, "", "Search");
  const url = "https://complexsearch.kugou.com/v2/search/song?" + buildQuery(params);
  const response = getJson(url, { "x-router": "complexsearch.kugou.com" });
  if (Number(response.error_code || 0) !== 0) return [];
  const list = response.data && Array.isArray(response.data.lists) ? response.data.lists : [];
  return list.map(item => mapSong(item, request.separator || "/"));
}

function searchCovers(request) {
  // 规范 search_type：0=歌曲（默认）、1=歌手、2=专辑。
  const canonical = Number(request.search_type || 0);

  // 歌手 / 专辑：走 mobilecdn.kugou.com 的 v3 接口（无需签名）
  if (canonical === 1 || canonical === 2) {
    const page = String(request.page || 1);
    const pageSize = String(request.pageSize || 5);
    const kw = String(request.keyword || "");

    if (canonical === 1) {
      // 1) 搜歌手 → data[]: { singername, singerid }
      const listUrl =
        "https://mobilecdn.kugou.com/api/v3/search/singer?keyword=" +
        encodeURIComponent(kw) + "&page=" + page + "&pagesize=" + pageSize;
      const listResp = getJson(listUrl, {});
      const singers = Array.isArray(listResp.data) ? listResp.data : [];
      const results = [];
      // 2) 逐个取歌手详情拿头像图（singer/info.data.imgurl）
      for (let i = 0; i < singers.length; i++) {
        const s = singers[i];
        if (!s || !s.singerid || !s.singername) continue;
        let imgUrl = "";
        try {
          const infoUrl =
            "https://mobilecdn.kugou.com/api/v3/singer/info?singerid=" +
            String(s.singerid);
          const infoResp = getJson(infoUrl, {});
          imgUrl = normalizeImage(infoResp.data && infoResp.data.imgurl);
        } catch (e) {
          imgUrl = "";
        }
        const name = String(s.singername || "");
        results.push({
          id: String(s.singerid || ""),
          title: name,
          artist: name,
          album: "",
          duration: 0,
          date: "",
          trackNumber: "",
          picUrl: imgUrl,
          fields: {
            title: name,
            artist: name,
            cover_url: imgUrl
          }
        });
      }
      return results.filter(song => song.id && song.title && song.picUrl);
    }

    // canonical === 2（专辑）：data.info[]: { albumid, albumname, imgurl, singername, publishtime }
    const albumUrl =
      "https://mobilecdn.kugou.com/api/v3/search/album?keyword=" +
      encodeURIComponent(kw) + "&page=" + page + "&pagesize=" + pageSize;
    const albumResp = getJson(albumUrl, {});
    const albums = (albumResp.data && Array.isArray(albumResp.data.info)) ? albumResp.data.info : [];
    return albums.map(function(a) {
      const imgUrl = normalizeImage(a.imgurl);
      const name = String(a.albumname || "");
      const artist = String(a.singername || "");
      return {
        id: String(a.albumid || ""),
        title: name,
        artist: artist,
        album: name,
        duration: 0,
        date: String(a.publishtime || ""),
        trackNumber: "",
        picUrl: imgUrl,
        fields: {
          title: name,
          artist: artist,
          album: name,
          date: String(a.publishtime || ""),
          cover_url: imgUrl
        }
      };
    }).filter(song => song.id && song.title && song.picUrl);
  }

  return searchSongs({
    keyword: request.keyword,
    page: request.page || 1,
    pageSize: request.pageSize || 5,
    separator: "/"
  }).filter(song => song.picUrl && song.title && song.artist && song.album && song.date);
}

function getLyricsForSong(request, song) {
  const internal = song.internal || {};
  const hash = internal.hash || "";
  if (!hash) return null;

  const searchParams = signParams({
    album_audio_id: song.id || "",
    duration: String(song.duration || 0),
    hash: hash,
    keyword: (song.artist || "") + " - " + (song.title || ""),
    lrctxt: "1",
    man: "no"
  }, "", "Lyric");
  const searchUrl = "https://lyrics.kugou.com/v1/search?" + buildQuery(searchParams);
  const searchResp = getJson(searchUrl, {});
  const candidate = searchResp.candidates && searchResp.candidates[0];
  if (!candidate) return null;

  const downloadParams = signParams({
    accesskey: candidate.accesskey,
    charset: "utf8",
    client: "mobi",
    fmt: "krc",
    id: candidate.id,
    ver: "1"
  }, "", "Lyric");
  const downloadUrl = "https://lyrics.kugou.com/download?" + buildQuery(downloadParams);
  const contentResp = getJson(downloadUrl, {});
  if (!contentResp || !contentResp.content) return null;

  const lyricText = Number(contentResp.contenttype || 0) === 2
    ? Platform.base64.decodeText(contentResp.content)
    : decryptKrc(contentResp.content);
  const parsed = parseKrc(lyricText);
  parsed.tags.ti = parsed.tags.ti || song.title || "";
  parsed.tags.ar = parsed.tags.ar || song.artist || "";
  parsed.tags.al = parsed.tags.al || song.album || "";
  return parsed;
}

function getLyrics(request) {
  const requestedSong = request.song || {};
  const songs = requestedSong.id && requestedSong.id !== "local-song"
    ? [requestedSong]
    : searchSongs({
        keyword: [requestedSong.title, requestedSong.artist].filter(Boolean).join(" "),
        page: request.page || 1,
        pageSize: request.pageSize || 5,
        separator: "/",
        config: request.config || {}
      });

  return songs.map(function(song) {
    try {
      const lyrics = getLyricsForSong(request, song);
      const year = String(song.date || ((song.fields || {}).date) || "");
      if (!lyrics || !song.title || !song.artist || !song.album || !year) return null;
      lyrics.tags = lyrics.tags || {};
      lyrics.tags.ti = String(song.title);
      lyrics.tags.ar = String(song.artist);
      lyrics.tags.al = String(song.album);
      lyrics.tags.date = year;
      return lyrics;
    } catch (e) {
      Platform.log.warn("KG", "Lyrics candidate failed: " + String(e && e.message ? e.message : e));
      return null;
    }
  }).filter(Boolean);
}
