function mapTrack(track, request) {
  const trackId = String(track.track_id || "");
  const title = String(track.track_name || "");
  const artist = String(track.artist_name || "");
  const album = String(track.album_name || "");
  const coverUrl = String(
    track.album_coverart_800x800 ||
    track.album_coverart_500x500 ||
    track.album_coverart_350x350 ||
    track.album_coverart_100x100 ||
    track.album_coverart_url ||
    ""
  ).replace("http:", "https:");
  const usableCover = /nocover\.(png|jpe?g)/i.test(coverUrl) ? "" : coverUrl;
  const duration = Number(track.track_length || 0) * 1000;
  const date = parseMxmDate(track.first_release_date || track.track_release_date);

  const fields = {
    title: title,
    artist: artist,
    album: album,
    date: date,
    cover_url: usableCover
  };

  return {
    id: trackId,
    title: title,
    artist: artist,
    album: album,
    duration: duration,
    date: date,
    picUrl: usableCover,
    fields: fields,
    internal: {
      track_id: trackId
    }
  };
}

function searchSongs(request) {
  let token = ensureMxmToken(request);
  const usesGuestToken = !!token && !mxmUserToken(request);

  if (!token) {
    warnMxm("search skipped because no usertoken or guest token is available");
    return [];
  }

  const page = Math.max(1, Number(request.page || 1));
  const pageSize = Math.max(1, Number(request.pageSize || 20));

  const qTrack = request.title || request.keyword || "";
  const qArtist = request.artist || "";
  let root;
  try {
    root = mxmGet("track.search", {
      q_track: qTrack,
      q_artist: qArtist,
      q_album: "",
      page: page,
      page_size: pageSize,
      f_has_lyrics: 1,
      s_track_rating: "desc",
      usertoken: token
    });
  } catch (e) {
    const msg = String(e && e.message || "");
    // 如果是 401 错误且 token 是自动获取的（非用户配置的），则重试一次
    if (usesGuestToken && msg.indexOf("状态码 401") >= 0) {
      invalidateMxmToken();
      token = ensureMxmToken(request);
      try {
        root = mxmGet("track.search", {
          q_track: qTrack,
          q_artist: qArtist,
          q_album: "",
          page: page,
          page_size: pageSize,
          f_has_lyrics: 1,
          s_track_rating: "desc",
          usertoken: token
        });
      } catch (e2) {
        warnMxm("search failed: " + String(e2 && e2.message ? e2.message : e2));
        return [];
      }
    } else {
      warnMxm("search failed: " + msg);
      return [];
    }
  }

  const trackList = dig(root, ["message", "body", "track_list"]) || [];
  if (!Array.isArray(trackList)) return [];

  return trackList
    .map(function (item) {
      return item && item.track ? mapTrack(item.track, request) : null;
    })
    .filter(function (song) {
      return song && song.id && song.title;
    });
}

function searchCovers(request) {
  const songs = searchSongs({
    keyword: request.title || request.keyword || "",
    title: request.title || "",
    artist: request.artist || "",
    page: request.page || 1,
    pageSize: request.pageSize || 5,
    separator: "/",
    config: request.config || {}
  });

  return songs.filter(function (song) {
    return song.picUrl && song.title && song.artist && song.album && song.date;
  });
}

function extractOriginalLrc(macroRoot) {
  const body = dig(macroRoot, ["message", "body", "macro_calls", "track.subtitles.get", "message", "body"]);
  if (body && body.subtitle_list) {
    const subtitleList = body.subtitle_list || [];
    if (Array.isArray(subtitleList) && subtitleList.length) {
      const subtitle = (subtitleList[0] || {}).subtitle || {};
      const lrc = String(subtitle.subtitle_body || "");
      if (lrc) return lrc;
    }
  }

  const fallback = deepFind(macroRoot, "subtitle_body");
  return typeof fallback === "string" ? fallback : "";
}

function extractMatcherTrack(macroRoot) {
  const track =
    dig(macroRoot, ["message", "body", "macro_calls", "matcher.track.get", "message", "body", "track"]) ||
    deepFind(macroRoot, "track") ||
    {};

  const hasRichsyncRaw = track.has_richsync;
  const hasRichsync = String(hasRichsyncRaw) === "1" || hasRichsyncRaw === true;

  return {
    commontrackId: String(track.commontrack_id || ""),
    hasRichsync: hasRichsync,
    title: String(track.track_name || ""),
    artist: String(track.artist_name || ""),
    album: String(track.album_name || ""),
    date: parseMxmDate(track.first_release_date || track.track_release_date)
  };
}

function extractMacroRichSync(macroRoot) {
  const body = dig(macroRoot, [
    "message", "body", "macro_calls", "track.richsync.get", "message", "body", "richsync", "richsync_body"
  ]);
  return typeof body === "string" ? body : "";
}

function fetchTranslation(trackId, languageId, token) {
  try {
    const root = mxmGet("track.translations.get", {
      track_id: trackId,
      language_id: languageId,
      subtitle_format: "lrc",
      usertoken: token
    });

    const list = dig(root, ["message", "body", "translation_list"]) || [];
    if (!Array.isArray(list) || !list.length) return "";

    return String((list[0].translation || {}).translation_body || "");
  } catch (e) {
    warnMxm("translation fetch failed: " + String(e && e.message ? e.message : e));
    return "";
  }
}

function mxmMacroParams(song, token) {
  const trackId = String(song.id || (song.internal && song.internal.track_id) || "");
  const params = {
    namespace: "lyrics_richsynched",
    optional_calls: "track.richsync",
    user_language: "en",
    f_subtitle_length_max_deviation: 40,
    subtitle_format: "lrc",
    usertoken: token
  };
  if (trackId) {
    params.track_id = trackId;
  } else {
    params.q_track = song.title || "";
    params.q_artist = song.artist || "";
    params.q_album = song.album || "";
  }
  return params;
}

function getLyricsForSong(request, song) {
  let token = ensureMxmToken(request);
  const usesGuestToken = !!token && !mxmUserToken(request);

  if (!song.title) return null;
  if (!token) {
    warnMxm("lyrics skipped because no usertoken or guest token is available");
    return null;
  }

  let macroRoot;
  try {
    macroRoot = mxmGet("macro.subtitles.get", mxmMacroParams(song, token));
  } catch (e) {
    const msg = String(e && e.message || "");
    // 如果是 401 错误且 token 是自动获取的（非用户配置的），则重试一次
    if (usesGuestToken && msg.indexOf("状态码 401") >= 0) {
      invalidateMxmToken();
      token = ensureMxmToken(request);
      try {
        macroRoot = mxmGet("macro.subtitles.get", mxmMacroParams(song, token));
      } catch (e2) {
        warnMxm("subtitles request failed: " + String(e2 && e2.message ? e2.message : e2));
        return null;
      }
    } else {
      warnMxm("subtitles request failed: " + msg);
      return null;
    }
  }

  const matcher = extractMatcherTrack(macroRoot);
  const originalLrc = extractOriginalLrc(macroRoot);
  if (!originalLrc && !(matcher.hasRichsync && matcher.commontrackId)) return null;

  let original = null;
  const lyricsMode = String(configValue(request, "lyrics_mode", "word") || "word");
  if (lyricsMode !== "line") {
    const richBody = extractMacroRichSync(macroRoot);
    if (richBody) {
      const parsedRich = parseRichSync(richBody);
      if (parsedRich.length) original = parsedRich;
    }
  }

  if (!original || !original.length) {
    if (!originalLrc) return null;
    original = parseLrc(originalLrc);
    // 逐行模式：把每行合并成单个文本，避免宿主把单个“词”误判为逐字歌词。
    if (lyricsMode === "line") {
      original = original.map(function (line) {
        return [line[0], line[1], extractLineText(line)];
      });
    }
  }
  if (!original.length) return null;

  let translated = null;
  const languageId = String(configValue(request, "translation_language", "off") || "off");
  const trackId = String(song.id || (song.internal && song.internal.track_id) || "");
  if (languageId !== "off" && trackId) {
    const translationLrc = fetchTranslation(trackId, languageId, token);
    if (translationLrc) {
      translated = lyricsMerge(original, parseLrc(translationLrc));
    }
  }

  const tags = {
    ti: matcher.title || song.title,
    ar: matcher.artist || song.artist,
    al: matcher.album || song.album
  };

  const date = matcher.date || String(song.date || ((song.fields || {}).date) || "");
  if (date) tags.date = date;

  return {
    type: "structured",
    tags: tags,
    original: original,
    translated: translated && translated.length ? translated : null,
    romanization: null
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

  return songs.map(function (song) {
    try {
      const lyrics = getLyricsForSong(request, song);
      if (!lyrics) return null;
      lyrics.tags = lyrics.tags || {};
      lyrics.tags.ti = String(lyrics.tags.ti || song.title);
      lyrics.tags.ar = String(lyrics.tags.ar || song.artist);
      lyrics.tags.al = String(lyrics.tags.al || song.album);
      const year = String(lyrics.tags.date || song.date || ((song.fields || {}).date) || "");
      if (year) lyrics.tags.date = year;
      if (!lyrics.tags.ti || !lyrics.tags.ar || !lyrics.tags.al || !year) return null;
      return lyrics;
    } catch (e) {
      warnMxm("Lyrics candidate failed: " + String(e && e.message ? e.message : e));
      return null;
    }
  }).filter(Boolean);
}
