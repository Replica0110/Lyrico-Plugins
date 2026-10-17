function buildCover(cover) {
  cover = cover || {};
  const urls = Array.isArray(cover.urls) ? cover.urls : [];
  const domain = urls[0] || "";
  const uri = cover.uri || "";

  if (!domain || !uri) return "";

  return domain.indexOf(uri) >= 0
    ? domain
    : domain + uri + "~c5_1400x1400.jpg";
}

function names(items, separator) {
  return (Array.isArray(items) ? items : [])
    .map(x => x.name || "")
    .filter(Boolean)
    .join(separator || "/");
}

function shareLyricsToLrc(routerData) {
  const loaderData = (routerData || {}).loaderData || {};
  const trackPage = loaderData.track_page || {};
  const audioOption = trackPage.audioWithLyricsOption || {};
  const lyrics = audioOption.lyrics || {};
  const sentences = Array.isArray(lyrics.sentences) ? lyrics.sentences : [];

  return sentences.map(function(sentence) {
    const startMs = Math.max(0, Number(sentence.startMs || 0));
    const minutes = Math.floor(startMs / 60000);
    const seconds = Math.floor((startMs % 60000) / 1000);
    const millis = Math.floor(startMs % 1000);
    const text = (Array.isArray(sentence.words) ? sentence.words : [])
      .map(word => String((word || {}).text || ""))
      .join("");
    return "[" + String(minutes).padStart(2, "0") + ":" +
      String(seconds).padStart(2, "0") + "." +
      String(millis).padStart(3, "0") + "]" + text;
  }).filter(Boolean).join("\n");
}

function parseTags(track) {
  const grouped = {};

  (Array.isArray(track.tags) ? track.tags : []).forEach(tag => {
    const category = ((tag.category || {}).name || "").toLowerCase();
    if (!category) return;

    if (!grouped[category]) grouped[category] = [];

    [tag.second, tag.first].forEach(value => {
      const name = value && value.name;
      if (name && grouped[category].indexOf(name) < 0) {
        grouped[category].push(name);
      }
    });
  });

  const result = {};
  Object.keys(grouped).forEach(key => {
    result[key] = grouped[key].join(" / ");
  });

  return result;
}

const SUPPORTED_TAG_FIELDS = {
  genre: true,
  language: true,
  comment: true,
  copyright: true
};

function mapTrack(track, request) {
  const makerTeam = track.song_maker_team || track.makerTeam || {};
  const subtitle = String(track.relation_media || track.relationMedia || "");
  const cover = buildCover((track.album || {}).url_cover || (track.album || {}).cover);

  const fields = {
    title: String(track.name || ""),
    artist: names(track.artists, request.separator),
    album: String((track.album || {}).name || ""),
    date: sodaDate(
      track.publish_time ||
      track.publishTime ||
      (track.album || {}).release_date ||
      (track.album || {}).releaseDate ||
      ""
    ),
    cover_url: cover
  };

  const internal = {
    soda_track_id: String(track.id || "")
  };

  const composers = names(makerTeam.composers, request.separator);
  const lyricists = names(makerTeam.lyricists, request.separator);

  if (composers) fields.composer = composers;
  if (lyricists) fields.lyricist = lyricists;
  if (subtitle) fields.comment = subtitle;

  const tags = parseTags(track);
  Object.keys(tags).forEach(key => {
    if (SUPPORTED_TAG_FIELDS[key] && tags[key] && !fields[key]) {
      fields[key] = tags[key];
    }
  });

  return {
    id: String(track.id || ""),
    title: fields.title,
    artist: fields.artist,
    album: fields.album,
    duration: Number(track.duration || 0),
    date: fields.date,
    picUrl: cover,
    fields: fields,
    internal: internal
  };
}

function searchSongs(request) {
  const pageSize = Math.max(1, Math.min(50, Number(request.pageSize || 20)));
  const cursor = Math.max(0, (Number(request.page || 1) - 1) * pageSize);
  const root = getSearchJson({
    q: request.keyword || "",
    cursor: cursor,
    count: pageSize
  }, request.config || {});

  const data = [];
  (root.result_groups || []).forEach(group => {
    (group.data || []).forEach(item => data.push(item));
  });
  const seen = {};

  return data
    .map(item => item.entity && item.entity.track)
    .filter(Boolean)
    .map(track => mapTrack(track, request))
    .filter(song => {
      if (!song.id || !song.title || seen[song.id]) return false;
      seen[song.id] = true;
      return true;
    }).slice(0, pageSize);
}

function searchCovers(request) {
  return searchSongs({
    keyword: request.keyword,
    page: request.page || 1,
    pageSize: request.pageSize || 5,
    separator: "/",
    config: request.config || {}
  }).filter(song => song.picUrl && song.title && song.artist && song.album && song.date);
}

function getLyricsForSong(request, song) {
  const internal = song.internal || {};
  const trackId = internal.soda_track_id || song.id || "";

  if (!trackId) return null;

  const config = request.config || {};
  let raw = "";
  let translatedRaw = "";

  let detailSong = {};
  try {
    const root = getSeoTrackData(trackId, config);
    const seo = root.seo_track || {};
    detailSong = mapTrack(seo.track || {}, { separator: "/" });
    const lyric = (seo.lyric || {}).content ? seo.lyric : (root.lyric || {});
    raw = String(lyric.content || "");
    translatedRaw = String(((lyric.translations || {}).cn) || "");
  } catch (error) {
    Platform.log.warn("SODA", Platform.i18n.t("warn.seoLyricsFallback", String(error && error.message ? error.message : error)));
  }

  if (!raw && !translatedRaw) {
    try {
      raw = shareLyricsToLrc(getShareTrackData(trackId));
    } catch (error) {
      Platform.log.warn("SODA", Platform.i18n.t("warn.shareLyricsFallback", String(error && error.message ? error.message : error)));
    }
  }

  if (!raw && !translatedRaw) return null;

  const parsed = parseSodaLyrics({
    original: raw,
    translated: translatedRaw,
    romanization: ""
  });

  const tags = parsed.tags || {};
  tags.ti = song.title || detailSong.title || tags.ti || "";
  tags.ar = song.artist || detailSong.artist || tags.ar || "";
  tags.al = song.album || detailSong.album || tags.al || "";
  tags.date = sodaDate(song.date || ((song.fields || {}).date) || detailSong.date || "");

  return {
    type: "structured",
    tags: tags,
    original: parsed.original || [],
    translated: parsed.translated,
    romanization: parsed.romanization
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
      if (!lyrics || !(lyrics.original || []).length && !(lyrics.translated || []).length) return null;
      if (!lyrics.tags.ti || !lyrics.tags.ar || !lyrics.tags.al || !lyrics.tags.date) return null;
      return lyrics;
    } catch (e) {
      Platform.log.warn("SODA", Platform.i18n.t("error.lyricsCandidate", String(song.title || song.id || ""), String(e && e.message ? e.message : e)));
      return null;
    }
  }).filter(Boolean);
}
