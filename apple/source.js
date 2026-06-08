function mapSong(id, attrs, request) {
  const size = configValue(request, "cover_size", "3000");
  const url = String(attrs.url || "");

  const urlAppleId = (url.split("?i=")[1] || "").split("&")[0];
  const pathAppleId = url.substring(url.lastIndexOf("/") + 1);
  const appleId = String(id || urlAppleId || pathAppleId || "");

  const artwork = attrs.artwork && attrs.artwork.url
    ? String(attrs.artwork.url)
        .replace("{w}", size)
        .replace("{h}", size)
        .replace("{f}", "jpg")
    : "";

  const genres = Array.isArray(attrs.genreNames)
    ? attrs.genreNames.filter(Boolean).join(" / ")
    : "";

  const trackNumber = attrs.trackNumber == null ? "" : String(attrs.trackNumber);

  const fields = {
    title: String(attrs.name || ""),
    artist: splitArtist(attrs.artistName, request.separator),
    album: String(attrs.albumName || ""),
    date: String(attrs.releaseDate || ""),
    track_number: trackNumber,
    cover_url: artwork
  };

  const internal = {
    apple_id: appleId
  };

  if (attrs.composerName) {
    fields.composer = String(attrs.composerName);
  }

  if (genres) {
    fields.genre = genres;
  }

  if (attrs.discNumber != null) {
    fields.disc_number = String(attrs.discNumber);
  }

  if (attrs.playParams && attrs.playParams.id) {
    internal.play_params_id = String(attrs.playParams.id);
  }

  return {
    id: appleId,
    title: fields.title,
    artist: fields.artist,
    album: fields.album,
    duration: Number(attrs.durationInMillis || 0),
    date: fields.date,
    trackNumber: trackNumber,
    picUrl: artwork,
    fields: fields,
    internal: internal
  };
}

function appleRequestRegion(request) {
  return configValue(request, "region", "zh-CN");
}

function appleRequestLanguage(request) {
  /*
   * 兼容旧 manifest：
   * - 旧配置只有 region=zh-CN/en-US/...
   * - 新配置可以有 region=cn/us/... + language=zh-Hans/en-US/...
   */
  const fallback = configValue(request, "region", "zh-CN");
  return configValue(request, "language", fallback);
}

function searchSongs(request) {
  const developerToken = getDeveloperToken();

  if (!developerToken) {
    warnApple("search aborted because developer token is empty");
    return [];
  }

  const region = appleRequestRegion(request);
  const language = appleRequestLanguage(request);

  const offset = Math.max(
    0,
    (Number(request.page || 1) - 1) * Number(request.pageSize || 20)
  );

  const url = "https://amp-api.music.apple.com/v1/catalog/" + storefront(region) + "/search"
    + "?term=" + encodeURIComponent(request.keyword || "")
    + "&types=songs"
    + "&limit=" + encodeURIComponent(request.pageSize || 20)
    + "&offset=" + encodeURIComponent(offset)
    + "&l=" + encodeURIComponent(language)
    + "&platform=web"
    + "&format[resources]=map";

  logApple(
    "search request keyword=" +
      String(request.keyword || "") +
      " region=" +
      region +
      " language=" +
      language +
      " url=" +
      url
  );

  const raw = appleGet(url, developerToken, "");
  logApple("search response length=" + String(raw.length) + " preview=" + previewText(raw, 1500));

  const root = JSON.parse(raw);
  const data = (((root.results || {}).songs || {}).data || []);
  const resources = (((root.resources || {}).songs) || {});

  logApple(
    "search parsed dataCount=" +
      String(data.length) +
      " resourcesCount=" +
      String(Object.keys(resources).length)
  );

  const results = data
    .map(function(item) {
      return resources[String(item.id || "")] || item;
    })
    .filter(Boolean)
    .map(function(song) {
      return mapSong(song.id, song.attributes || {}, request);
    })
    .filter(function(song) {
      return song.title;
    });

  logApple("search mapped resultCount=" + String(results.length));
  return results;
}

function searchCovers(request) {
  return searchSongs({
    keyword: request.keyword,
    page: 1,
    pageSize: request.pageSize || 5,
    separator: "/",
    config: request.config || {}
  }).filter(function(song) {
    return song.picUrl;
  });
}

function parseThirdPartyLyrics(rawJson, song) {
  const root = JSON.parse(rawJson);
  const content = Array.isArray(root.content) ? root.content : [];

  const original = content
    .map(function(line) {
      const start = Number(line.timestamp || 0);
      const end = Number(line.endtime || start);
      const textArray = Array.isArray(line.text) ? line.text : [];

      const words = textArray
        .map(function(word, index) {
          const text = String(word.text || "");
          const next = textArray[index + 1] ? String(textArray[index + 1].text || "") : "";

          return [
            Number(word.timestamp || start),
            Number(word.endtime || end),
            text + (shouldAppendSpace(text, next) ? " " : "")
          ];
        })
        .filter(function(word) {
          return word[2];
        });

      if (words.length) {
        return [start, end, words];
      }

      const text = String(line.plain || (typeof line.text === "string" ? line.text : ""));
      return text ? [start, end, text] : null;
    })
    .filter(Boolean);

  const track = root.track || {};

  const tags = {
    ti: String(track.name || song.title || ""),
    ar: String(track.artistName || song.artist || ""),
    al: String(track.albumName || song.album || "")
  };

  if (track.composerName) {
    tags.composer = String(track.composerName);
  }

  if (track.releaseDate) {
    tags.date = String(track.releaseDate);
  }

  const songwriters = (((root.metadata || {}).songwriters) || [])
    .filter(Boolean)
    .join(" / ");

  if (songwriters) {
    tags.lyricist = songwriters;
  }

  const rawPlainLrc = String(root.lrc || "");
  const rawEnhancedLrc = String(root.elrc || root.elrcMultiPerson || "");
  const rawTtml = String(root.ttmlContent || "");
  const rawMultiPersonEnhancedLrc = String(root.elrcMultiPerson || "");

  if (rawTtml) {
    return {
      type: "rawTtml",
      tags: tags,
      rawTtml: rawTtml
    };
  }

  if (rawMultiPersonEnhancedLrc) {
    return {
      type: "rawMultiPersonEnhancedLrc",
      tags: tags,
      rawMultiPersonEnhancedLrc: rawMultiPersonEnhancedLrc
    };
  }

  if (rawEnhancedLrc) {
    return {
      type: "rawEnhancedLrc",
      tags: tags,
      rawEnhancedLrc: rawEnhancedLrc
    };
  }

  if (rawPlainLrc && !original.length) {
    return {
      type: "rawPlainLrc",
      tags: tags,
      rawPlainLrc: rawPlainLrc
    };
  }

  return {
    type: "structured",
    tags: tags,
    original: original
  };
}

function parseOfficialLyrics(rawJson, fallbackSong, request) {
  const root = JSON.parse(rawJson);
  const song = ((root.data || [])[0]) || {};
  const attrs = song.attributes || {};
  const language = appleRequestLanguage(request);

  const official = getOfficialTtml(song, language);
  const ttml = applyAppleOfficialLocalizationToTtml(official.ttml, language);

  if (!ttml) {
    warnApple(
      "official lyrics ttml is empty. relationship keys=" +
      Object.keys(song.relationships || {}).join(",") +
      ", hasLyrics=" + String(attrs.hasLyrics) +
      ", hasTimeSyncedLyrics=" + String(attrs.hasTimeSyncedLyrics)
    );
    return null;
  }

  const tags = {
    ti: String(attrs.name || fallbackSong.title || ""),
    ar: String(attrs.artistName || fallbackSong.artist || ""),
    al: String(attrs.albumName || fallbackSong.album || "")
  };

  if (attrs.composerName) tags.composer = String(attrs.composerName);
  if (attrs.releaseDate) tags.date = String(attrs.releaseDate);

  return {
    type: "rawTtml",
    tags: tags,
    rawTtml: ttml,
    source: official.relationship
  };
}

function getThirdPartyLyrics(request, appleId, song) {
  const url = "https://lyrics.paxsenix.org/apple-music/lyrics"
    + "?id=" + encodeURIComponent(appleId)
    + "&ttml=false";

  const body = Platform.http.getText(url, {
    headers: {
      "accept": "application/json",
      "User-Agent": getLyricoUserAgent()
    }
  });

  logApple(
    "third-party lyrics response appleId=" +
      appleId +
      " length=" +
      String(body.length) +
      " preview=" +
      previewText(body, 1500)
  );

  return parseThirdPartyLyrics(body, song);
}

function pickTtmlLocalization(attrs, language) {
  const value = attrs.ttmlLocalizations;
  const candidates = appleLanguageCandidates(language);

  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    let fallback = "";

    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const locale = getLocalizationLocale(item);
      const ttml = extractTtmlFromLocalizationItem(item);

      if (!ttml) {
        continue;
      }

      if (candidates.indexOf(locale) >= 0) {
        return ttml;
      }

      if (!fallback) {
        fallback = ttml;
      }
    }

    return fallback;
  }

  if (typeof value === "object") {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];

      if (value[candidate]) {
        const directTarget = extractTtmlFromLocalizationItem(value[candidate]);
        if (directTarget) {
          return directTarget;
        }
      }
    }

    const direct = extractTtmlFromLocalizationItem(value);
    if (direct) {
      return direct;
    }

    const keys = Object.keys(value);
    let fallback = "";

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const ttml = extractTtmlFromLocalizationItem(value[key]);

      if (!ttml) {
        continue;
      }

      if (candidates.indexOf(key) >= 0) {
        return ttml;
      }

      if (!fallback) {
        fallback = ttml;
      }
    }

    return fallback;
  }

  return "";
}

function getLocalizationLocale(item) {
  if (!item || typeof item !== "object") {
    return "";
  }

  return String(
    item.locale ||
    item.language ||
    item.languageTag ||
    item.lang ||
    item.id ||
    ""
  );
}

function extractTtmlFromLocalizationItem(item) {
  if (!item) {
    return "";
  }

  if (typeof item === "string") {
    return item;
  }

  if (typeof item !== "object") {
    return "";
  }

  return String(
    item.ttml ||
    item.ttmlContent ||
    item.lyrics ||
    item.value ||
    ""
  );
}

function getOfficialTtml(song, language) {
  const relationships = song.relationships || {};
  const preferredKeys = ["syllable-lyrics", "lyrics"];

  for (let i = 0; i < preferredKeys.length; i++) {
    const key = preferredKeys[i];
    const rel = relationships[key] || {};
    const data = rel.data || [];

    if (!data.length) continue;

    const attrs = data[0].attributes || {};

    const localizedTtml = pickTtmlLocalization(attrs, language);
    if (localizedTtml) {
      logApple("official lyrics using relationship=" + key + " field=ttmlLocalizations");
      return {
        relationship: key,
        field: "ttmlLocalizations",
        ttml: localizedTtml
      };
    }

    const ttml = String(
      attrs.ttml ||
      attrs.ttmlContent ||
      attrs.lyrics ||
      ""
    );

    if (ttml) {
      logApple("official lyrics using relationship=" + key + " field=ttml");
      return {
        relationship: key,
        field: "ttml",
        ttml: ttml
      };
    }
  }

  return {
    relationship: "",
    field: "",
    ttml: ""
  };
}

function getOfficialLyrics(request, appleId, song) {
  const developerToken = getDeveloperToken();

  if (!developerToken) {
    warnApple("official lyrics aborted because developer token is empty");
    return null;
  }

  const mediaUserToken = String(configValue(request, "media_user_token", "") || "").trim();

  if (!mediaUserToken) {
    warnApple("official lyrics aborted because media-user-token is empty");
    return null;
  }

  const region = appleRequestRegion(request);
  const language = appleRequestLanguage(request);

  const url = "https://amp-api.music.apple.com/v1/catalog/" + storefront(region) + "/songs/" + encodeURIComponent(appleId)
    + "?include=syllable-lyrics,lyrics"
    + "&extend=ttmlLocalizations"
    + "&l=" + encodeURIComponent(language)
    + "&platform=web";

  logApple(
    "official lyrics request appleId=" +
      appleId +
      " region=" +
      region +
      " language=" +
      language +
      " url=" +
      url
  );

  const raw = appleGet(url, developerToken, mediaUserToken);

  logApple(
    "official lyrics response appleId=" +
      appleId +
      " length=" +
      String(raw.length) +
      " preview=" +
      previewText(raw, 1500)
  );

  return parseOfficialLyrics(raw, song, request);
}

function getLyrics(request) {
  const song = request.song || {};
  const internal = song.internal || {};
  const appleId = String(internal.apple_id || song.id || "").trim();

  if (!appleId) {
    warnApple("lyrics aborted because appleId is empty");
    return null;
  }

  const provider = configValue(request, "lyrics_provider", "third_party");

  if (provider === "official") {
    return getOfficialLyrics(request, appleId, song);
  }

  return getThirdPartyLyrics(request, appleId, song);
}