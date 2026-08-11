function firstPositiveNumber(values) {
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const number = value == null ? 0 : Number(value);
    if (number > 0) return number;
  }
  return 0;
}

function getArtists(song) {
  if (Array.isArray(song.artists)) return song.artists;
  if (Array.isArray(song.ar)) return song.ar;
  return [];
}

function getAlbum(song) {
  return song.album || song.al || {};
}

function getAliases(song) {
  if (Array.isArray(song.alias)) return song.alias;
  if (Array.isArray(song.alia)) return song.alia;
  return [];
}

function getSongDuration(song) {
  return Number(song.duration || song.dt || 0);
}

function getTrackNumber(song) {
  return String(song.no || song.trackNumber || song.trackerNumber || "");
}
function getDiscNumber(song) {
  return String(song.cd || "");
}
function getPublishTime(song) {
  const album = getAlbum(song);
  return firstPositiveNumber([
    song.publishTime,
    song.publishTimeMs,
    album.publishTime,
    album.publishTimeMs
  ]);
}

function getAlbumId(song) {
  const album = getAlbum(song);
  const internal = song && song.internal ? song.internal : {};
  return firstPositiveNumber([
    album.id,
    internal.albumId,
    internal.album_id
  ]);
}

function resolveSongDate(song) {
  const knownDate = String(song.date || ((song.fields || {}).date) || "");
  if (knownDate) return knownDate;

  let albumId = getAlbumId(song);
  try {
    if (!albumId && song.id) {
      const detail = postForm("https://music.163.com/api/v3/song/detail", {
        c: JSON.stringify([{ id: Number(song.id) }]),
        ids: JSON.stringify([Number(song.id)])
      });
      const detailedSong = detail && Array.isArray(detail.songs) ? detail.songs[0] : null;
      albumId = getAlbumId(detailedSong || {});
    }

    if (!albumId) return "";
    const root = getJson("https://music.163.com/api/v1/album/" + encodeURIComponent(String(albumId)));
    return formatDate(getPublishTime((root && root.album) || {}));
  } catch (e) {
    Platform.log.warn(
      "NE",
      "Resolve song date failed: " + String(e && e.message ? e.message : e)
    );
    return "";
  }
}

function getMvId(song) {
  return Number(song.mvid || song.mv || song.mvId || 0);
}

function getQualityBitrate(song) {
  const qualities = [
    song.sq,
    song.hMusic || song.h,
    song.mMusic || song.m,
    song.lMusic || song.l,
    song.losslessQuality,
    song.highQuality,
    song.mediumQuality,
    song.lowQuality
  ];

  for (let i = 0; i < qualities.length; i++) {
    const q = qualities[i];
    if (!q) continue;

    const bitrate = Number(q.bitrate || q.br || 0);
    if (bitrate > 0) return bitrate;
  }

  return 0;
}

function build163Key(song) {
  try {
    const album = getAlbum(song);
    const artists = getArtists(song);
    const bitrate = getQualityBitrate(song);

    const picDocId = Number(
      album.pic_str ||
      album.picStr ||
      album.picId ||
      album.pic ||
      0
    );

    const metadata = {
      musicName: String(song.name || ""),
      musicId: Number(song.id || 0),
      artist: artists.map(function (artist) {
        return [
          String(artist.name || ""),
          Number(artist.id || 0)
        ];
      }),
      album: String(album.name || ""),
      albumId: Number(album.id || 0),
      albumPic: String(album.picUrl || ""),
      albumPicDocId: picDocId,
      bitrate: bitrate,
      duration: getSongDuration(song),
      mvId: getMvId(song),
      alias: getAliases(song),
      transNames: [],
      format: bitrate > 320000 ? "flac" : "mp3",
      flag: 0,
      gain: 0.0
    };

    const json = JSON.stringify(metadata).replace(/\//g, "\\/");
    return (
      "163 key(Don't modify):" +
      Platform.crypto.aesEcbPkcs5EncryptBase64("music:" + json, AES_163_KEY)
    );
  } catch (e) {
    Platform.log.warn("NE", "build163Key failed: " + String(e && e.message ? e.message : e));
    return "";
  }
}
function getCommentContentMode(request) {
  const config = request && request.config ? request.config : {};
  return String(config.comment_content || "alias");
}

function buildCommentField(song, request) {
  const mode = getCommentContentMode(request);
  const aliases = getAliases(song);

  if (mode === "none") {
    return "";
  }

  if (mode === "alias") {
    return aliases.length ? aliases.join(" / ") : "";
  }

  if (mode === "netease_163_key") {
    return build163Key(song);
  }

  return "";
}
function mapSong(song, request) {
  const artists = getArtists(song);
  const album = getAlbum(song);

  const picUrl = String(album.picUrl || "").replace("http:", "https:");
  const artistText = artists
    .map(function (artist) {
      return artist.name || "";
    })
    .filter(Boolean)
    .join(request.separator || "/");

  const fields = {
    title: String(song.name || ""),
    artist: artistText,
    album: String(album.name || ""),
    date: formatDate(getPublishTime(song)),
    track_number: getTrackNumber(song),
    disc_number: getDiscNumber(song),
    cover_url: picUrl
  };

  const comment = buildCommentField(song, request);
  if (comment) {
    fields.comment = comment;
  }

  return {
    id: String(song.id || ""),
    title: fields.title,
    artist: fields.artist,
    album: fields.album,
    duration: getSongDuration(song),
    date: fields.date,
    trackNumber: fields.track_number,
    discNumber: fields.disc_number,
    picUrl: picUrl,
    fields: fields,
    internal: {
      albumId: String(album.id || "")
    }
  };
}

function mapEapiSongResource(resource, request) {
  const song =
    resource &&
    resource.baseInfo &&
    resource.baseInfo.simpleSongData
      ? resource.baseInfo.simpleSongData
      : null;

  if (!song) return null;
  return mapSong(song, request);
}

function searchSongsByEapi(request) {
  const pageSize = Number(request.pageSize || 20);
  const page = Math.max(1, Number(request.page || 1));
  const offset = Math.max(0, (page - 1) * pageSize);

  const root = eapiRequest("/eapi/search/song/list/page", {
    limit: String(pageSize),
    offset: String(offset),
    keyword: request.keyword || "",
    scene: "NORMAL",
    needCorrect: "true"
  });

  const resources =
    root &&
    root.data &&
    Array.isArray(root.data.resources)
      ? root.data.resources
      : [];

  return resources
    .map(function (resource) {
      return mapEapiSongResource(resource, request);
    })
    .filter(function (song) {
      return song && song.id && song.title;
    });
}

function searchSongsByCloudSearchFallback(request) {
  const pageSize = Number(request.pageSize || 20);
  const page = Math.max(1, Number(request.page || 1));
  const offset = Math.max(0, (page - 1) * pageSize);

  const root = postForm("https://music.163.com/api/cloudsearch/pc", {
    s: request.keyword || "",
    type: 1,
    offset: offset,
    limit: pageSize
  });

  const songs =
    root &&
    root.result &&
    Array.isArray(root.result.songs)
      ? root.result.songs
      : [];

  return songs
    .map(function (song) {
      return mapSong(song, request);
    })
    .filter(function (song) {
      return song && song.id && song.title;
    });
}

function searchSongs(request) {
  try {
    return searchSongsByEapi(request);
  } catch (e) {
    Platform.log.warn(
      "NE",
      "EAPI search failed, fallback to cloudsearch: " +
        String(e && e.message ? e.message : e)
    );

    return searchSongsByCloudSearchFallback(request);
  }
}

function searchCovers(request) {
  return searchSongs({
    keyword: request.keyword,
    page: request.page || 1,
    pageSize: request.pageSize || 5,
    separator: "/",
    config: request.config || {}
  }).filter(function (song) {
    return song.picUrl && song.title && song.artist && song.album && song.date;
  });
}

function getLyricsForSong(request, song) {
  if (!song.id) return null;

  const root = eapiRequest("/eapi/song/lyric/v1", {
    id: Number(song.id || 0),
    lv: "-1",
    tv: "-1",
    rv: "-1",
    yv: "-1"
  });

  const yrc =
    root.yrc && root.yrc.lyric
      ? String(root.yrc.lyric)
      : "";

  const lrc =
    root.lrc && root.lrc.lyric
      ? String(root.lrc.lyric)
      : "";

  const tlyric =
    root.tlyric && root.tlyric.lyric
      ? String(root.tlyric.lyric)
      : "";

  const romalrc =
    root.romalrc && root.romalrc.lyric
      ? String(root.romalrc.lyric)
      : "";

  Platform.log.debug(
    "NE",
    "Lyric result: " +
      JSON.stringify({
        code: root.code,
        hasYrc: !!yrc,
        hasLrc: !!lrc,
        hasTlyric: !!tlyric,
        hasRomalrc: !!romalrc,
        yrcLength: yrc.length,
        lrcLength: lrc.length,
        tlyricLength: tlyric.length,
        romalrcLength: romalrc.length
      })
  );

  if (!yrc && !lrc) {
    return null;
  }

  const original = parseNeteaseOriginalLyrics(yrc, lrc);
  const translated = lyricsMerge(original, parseLrc(tlyric));
  const romanization = lyricsMerge(original, parseLrc(romalrc));

  return {
    type: "structured",
    tags: {
      ti: song.title || "",
      ar: song.artist || "",
      al: song.album || ""
    },
    original: original,
    translated: translated,
    romanization: romanization
  };
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
      const date = resolveSongDate(song);
      if (!lyrics || !song.title || !song.artist || !song.album || !date) return null;
      lyrics.tags = lyrics.tags || {};
      lyrics.tags.ti = String(song.title);
      lyrics.tags.ar = String(song.artist);
      lyrics.tags.al = String(song.album);
      lyrics.tags.date = date;
      return lyrics;
    } catch (e) {
      Platform.log.warn("NE", "Lyrics candidate failed: " + String(e && e.message ? e.message : e));
      return null;
    }
  }).filter(Boolean);
}
