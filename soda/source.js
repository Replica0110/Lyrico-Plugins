function buildCover(cover) {
  cover = cover || {};
  const urls = Array.isArray(cover.urls) ? cover.urls : [];
  const domain = urls[0] || "";
  const uri = cover.uri || "";
  if (!domain || !uri) return "";
  return domain.indexOf(uri) >= 0 ? domain : domain + uri + "~c5_1400x1400.jpg";
}

function names(items, separator) {
  return (Array.isArray(items) ? items : []).map(x => x.name || "").filter(Boolean).join(separator || "/");
}

function parseTags(track) {
  const grouped = {};
  (Array.isArray(track.tags) ? track.tags : []).forEach(tag => {
    const category = ((tag.category || {}).name || "").toLowerCase();
    if (!category) return;
    if (!grouped[category]) grouped[category] = [];
    [tag.second, tag.first].forEach(value => {
      const name = value && value.name;
      if (name && grouped[category].indexOf(name) < 0) grouped[category].push(name);
    });
  });
  const result = {};
  Object.keys(grouped).forEach(key => result[key] = grouped[key].join(" / "));
  return result;
}

function mapTrack(track, request) {
  const makerTeam = track.song_maker_team || track.makerTeam || {};
  const subtitle = String(track.relation_media || track.relationMedia || "");
  const cover = buildCover((track.album || {}).url_cover || (track.album || {}).cover);
  const fields = {
    title: String(track.name || ""),
    artist: names(track.artists, request.separator),
    album: String((track.album || {}).name || ""),
    cover_url: cover,
    soda_track_id: String(track.id || "")
  };
  const composers = names(makerTeam.composers, request.separator);
  const lyricists = names(makerTeam.lyricists, request.separator);
  if (composers) fields.composer = composers;
  if (lyricists) fields.lyricist = lyricists;
  if (subtitle) fields.subtitle = subtitle;
  const tags = parseTags(track);
  Object.keys(tags).forEach(key => fields[key] = tags[key]);
  return {
    id: String(track.id || ""),
    title: fields.title,
    artist: fields.artist,
    album: fields.album,
    duration: Number(track.duration || 0),
    picUrl: cover,
    fields: fields
  };
}

function searchSongs(request) {
  const cursor = Math.max(0, (Number(request.page || 1) - 1) * Number(request.pageSize || 20));
  const root = getJson("luna/pc/search/track", {
    q: request.keyword || "",
    cursor: cursor,
    search_method: "input",
    aid: "386088",
    device_platform: "web",
    channel: "pc_web"
  });
  const data = ((((root.result_groups || [])[0] || {}).data) || []);
  return data.map(item => item.entity && item.entity.track)
    .filter(Boolean)
    .map(track => mapTrack(track, request))
    .filter(song => song.id && song.title);
}

function searchCovers(request) {
  return searchSongs({
    keyword: request.keyword,
    page: 1,
    pageSize: request.pageSize || 5,
    separator: "/",
    config: request.config || {}
  }).filter(song => song.picUrl);
}

function getLyrics(request) {
  const song = request.song || {};
  const fields = song.fields || {};
  const trackId = fields.soda_track_id || song.id || "";
  if (!trackId) return null;
  const root = getJson("luna/pc/track_v2", {
    track_id: trackId,
    media_type: "track",
    aid: "386088",
    device_platform: "web",
    channel: "pc_web"
  });
  const lyric = root.lyric || {};
  const raw = String(lyric.content || "");
  const translated = String(((lyric.translations || {}).cn) || "");
  if (!raw && !translated) return null;
  return {
    tags: { ti: song.title || "", ar: song.artist || "", al: song.album || "" },
    original: parseTimed(raw),
    translated: parseTimed(translated),
    rawPlainLrc: /^\s*\[\d{1,}:\d{2}/m.test(raw) ? raw : "",
    rawVerbatimLrc: /^\s*\[\d+,\d+]/m.test(raw) ? "" : raw
  };
}
