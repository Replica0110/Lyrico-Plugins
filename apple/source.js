function mapSong(id, attrs, request) {
  const size = configValue(request, "cover_size", "3000");
  const url = String(attrs.url || "");
  const appleId = (url.split("?i=")[1] || "").split("&")[0] || url.substring(url.lastIndexOf("/") + 1) || String(id);
  const artwork = attrs.artwork && attrs.artwork.url
    ? String(attrs.artwork.url).replace("{w}", size).replace("{h}", size).replace("{f}", "jpg")
    : "";
  const genres = Array.isArray(attrs.genreNames) ? attrs.genreNames.filter(Boolean).join(" / ") : "";
  const trackNumber = attrs.trackNumber == null ? "" : String(attrs.trackNumber);
  const fields = {
    title: String(attrs.name || ""),
    artist: splitArtist(attrs.artistName, request.separator),
    album: String(attrs.albumName || ""),
    date: String(attrs.releaseDate || ""),
    track_number: trackNumber,
    cover_url: artwork,
    apple_id: appleId
  };
  if (attrs.composerName) fields.composer = String(attrs.composerName);
  if (genres) fields.genre = genres;
  if (attrs.discNumber != null) fields.disc_number = String(attrs.discNumber);
  return {
    id: appleId,
    title: fields.title,
    artist: fields.artist,
    album: fields.album,
    duration: Number(attrs.durationInMillis || 0),
    date: fields.date,
    trackNumber: trackNumber,
    picUrl: artwork,
    fields: fields
  };
}

function searchSongs(request) {
  const token = getToken(request);
  if (!token) {
    warnApple("search aborted because token is empty");
    return [];
  }
  const region = configValue(request, "region", "zh-CN");
  const offset = Math.max(0, (Number(request.page || 1) - 1) * Number(request.pageSize || 20));
  const url = "https://amp-api.music.apple.com/v1/catalog/" + storefront(region) + "/search"
    + "?term=" + encodeURIComponent(request.keyword || "")
    + "&types=songs&limit=" + encodeURIComponent(request.pageSize || 20)
    + "&offset=" + encodeURIComponent(offset)
    + "&l=" + encodeURIComponent(region)
    + "&platform=web&format[resources]=map";
  logApple("search request keyword=" + String(request.keyword || "") + " region=" + region + " url=" + url);
  const raw = appleGet(url, token);
  logApple("search response length=" + String(raw.length) + " preview=" + previewText(raw, 1500));
  const root = JSON.parse(raw);
  const data = (((root.results || {}).songs || {}).data || []);
  const resources = (((root.resources || {}).songs) || {});
  logApple("search parsed dataCount=" + String(data.length) + " resourcesCount=" + String(Object.keys(resources).length));
  const results = data.map(item => resources[String(item.id || "")] || item).filter(Boolean)
    .map(song => mapSong(song.id, song.attributes || {}, request))
    .filter(song => song.title);
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
  }).filter(song => song.picUrl);
}

function parseThirdPartyLyrics(rawJson, song) {
  const root = JSON.parse(rawJson);
  const content = Array.isArray(root.content) ? root.content : [];
  const original = content.map(line => {
    const start = Number(line.timestamp || 0);
    const end = Number(line.endtime || start);
    const textArray = Array.isArray(line.text) ? line.text : [];
    const words = textArray.map((word, index) => {
      const text = String(word.text || "");
      const next = textArray[index + 1] ? String(textArray[index + 1].text || "") : "";
      return [Number(word.timestamp || start), Number(word.endtime || end), text + (shouldAppendSpace(text, next) ? " " : "")];
    }).filter(word => word[2]);
    if (words.length) return [start, end, words];
    const text = String(line.plain || (typeof line.text === "string" ? line.text : ""));
    return text ? [start, end, text] : null;
  }).filter(Boolean);
  const track = root.track || {};
  const tags = {
    ti: String(track.name || song.title || ""),
    ar: String(track.artistName || song.artist || ""),
    al: String(track.albumName || song.album || "")
  };
  if (track.composerName) tags.composer = String(track.composerName);
  if (track.releaseDate) tags.date = String(track.releaseDate);
  const songwriters = (((root.metadata || {}).songwriters) || []).filter(Boolean).join(" / ");
  if (songwriters) tags.lyricist = songwriters;
  return {
    type: "structured",
    tags: tags,
    original: original,
    rawPlainLrc: String(root.lrc || ""),
    rawEnhancedLrc: String(root.elrc || root.elrcMultiPerson || ""),
    rawTtml: String(root.ttmlContent || ""),
    rawMultiPersonEnhancedLrc: String(root.elrcMultiPerson || "")
  };
}

function getLyrics(request) {
  const song = request.song || {};
  if ((request.config || {}).lyrics_provider === "official") return null;
  const fields = song.fields || {};
  const appleId = fields.apple_id || song.id || "";
  if (!appleId) return null;
  const body = Lyrico.http.getText("https://lyrics.paxsenix.org/apple-music/lyrics?id=" + encodeURIComponent(appleId) + "&ttml=false", {
    headers: {
      "accept": "application/json",
      "User-Agent": getLyricoUserAgent()
    }
  });
  logApple("lyrics response appleId=" + appleId + " length=" + String(body.length) + " preview=" + previewText(body, 1500));
  return parseThirdPartyLyrics(body, song);
}
