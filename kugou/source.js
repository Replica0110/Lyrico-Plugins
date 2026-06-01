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
  return searchSongs({
    keyword: request.keyword,
    page: 1,
    pageSize: request.pageSize || 5,
    separator: "/"
  }).filter(song => song.picUrl);
}

function getLyrics(request) {
  const song = request.song || {};
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
