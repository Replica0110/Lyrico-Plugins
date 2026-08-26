// MusicBrainz × Lyrico 插件入口
// 数据源：https://musicbrainz.org（开放元数据库，无歌词数据，仅元数据与封面）
// 封面来自 Cover Art Archive：URL 按 release MBID 规律构造，零额外请求

/**
 * 构建结构化 Lucene 查询。
 * Lyrico 的搜索关键词通常为"歌名 艺术家"（title + artist 空格拼接），直接模糊查询会把
 * 艺术家名误当歌名匹配（如搜"17 Avril Lavigne"返回一堆歌名叫"Avril Lavigne"的翻唱）。
 * 这里对每个切分点组合 recording/artist 字段查询并加权，整体短语兜底：
 * 正确切分（如 recording:"17" AND artist:"Avril Lavigne"）得分最高排最前，
 * 错确切分查不到结果不影响，兜底子句保证模糊匹配能力不退化。
 */
function buildQuery(keyword) {
  var tokens = keyword.split(/\s+/);
  if (tokens.length < 2) return keyword;

  function esc(s) { return s.replace(/"/g, '\\"'); }

  var clauses = [];
  var maxSplit = Math.min(tokens.length - 1, 6); // 词过多时限制子句数，避免查询串过长
  for (var i = 1; i <= maxSplit; i++) {
    var title = esc(tokens.slice(0, i).join(" "));
    var artist = esc(tokens.slice(i).join(" "));
    clauses.push('(recording:"' + title + '" AND artist:"' + artist + '")^4');
  }
  clauses.push('"' + esc(keyword) + '"'); // 整体模糊兜底
  return clauses.join(" OR ");
}

/** Lyrico 后续版本将直接下发结构化 title/artist 字段，有则构建字段化查询（无需切分穷举） */
function buildStructuredQuery(title, artist) {
  function esc(s) { return s.replace(/"/g, '\\"'); }
  if (title && artist) return '(recording:"' + esc(title) + '" AND artist:"' + esc(artist) + '")^4';
  if (title) return 'recording:"' + esc(title) + '"';
  return 'artist:"' + esc(artist) + '"';
}

/** 调 /ws/2/recording 搜索（query 由调用方构建），返回原始 recordings */
function searchApiRecordings(query, page, pageSize, config) {
  var offset = (Math.max(1, page) - 1) * pageSize;
  var data = MusicBrainz.get("/recording/", { query: query, limit: pageSize, offset: offset }, config, null);
  return (data && data.recordings) || [];
}

/** MB 录音 → Lyrico song 对象（仅用搜索结果，无额外请求） */
function mapRecording(rec, request) {
  var separator = request.separator || "/";
  var release = (rec.releases && rec.releases[0]) || {};
  var medium = (release.media && release.media[0]) || {};
  var track = (medium.track && medium.track[0]) || {};

  var artist = MusicBrainz.joinArtistCredit(rec["artist-credit"], separator);
  var albumArtist = MusicBrainz.joinArtistCredit(release["artist-credit"], separator);
  var date = release.date || rec["first-release-date"] || "";

  var fields = {
    title: rec.title || "",
    artist: artist,
    album: release.title || "",
    date: date
  };
  if (albumArtist) fields.album_artist = albumArtist;
  if (track.number) fields.track_number = String(track.number);
  if (medium.position) fields.disc_number = String(medium.position);

  // 封面：Cover Art Archive 按 release MBID 构造（无封面时 Lyrico 侧加载失败，可接受）
  var coverUrl = release.id ? ("https://coverartarchive.org/release/" + release.id + "/front") : "";

  return {
    id: rec.id || "",
    title: rec.title || "",
    artist: artist,
    album: release.title || "",
    date: date,
    duration: rec.length || 0,
    picUrl: coverUrl,
    fields: fields,
    internal: {
      mb_recording: rec.id || "",
      mb_release: release.id || ""
    }
  };
}

/**
 * 补全词曲作者与流派：recording 详情（work-rels + genres）→ work 详情（artist-rels）
 * 两跳共 2 请求/首，全部命中缓存则 0 请求；任一跳失败视为限流，中断本次补全
 */
function enrichSong(song, config, separator) {
  var mbid = song.internal && song.internal.mb_recording;
  if (!mbid) return true;

  var detail = MusicBrainz.get("/recording/" + mbid, { inc: "work-rels+genres" }, config, "mb.rec." + mbid);
  if (!detail) return false;

  var genres = MusicBrainz.extractGenres(detail);
  if (genres.length > 0) song.fields.genre = genres.join(separator);

  var workMbid = MusicBrainz.extractWorkMbid(detail);
  if (workMbid) {
    var work = MusicBrainz.get("/work/" + workMbid, { inc: "artist-rels" }, config, "mb.work." + workMbid);
    if (!work) return false;
    var credits = MusicBrainz.extractCreditsFromWork(work);
    if (credits.composers.length > 0) song.fields.composer = credits.composers.join(separator);
    if (credits.lyricists.length > 0) song.fields.lyricist = credits.lyricists.join(separator);
  }
  return true;
}

function searchSongs(request) {
  try {
    var config = MusicBrainz.getConfig(request);
    var keyword = String(request.keyword || "").trim();
    var reqTitle = String(request.title || "").trim();
    var reqArtist = String(request.artist || "").trim();
    if (!keyword && !reqTitle && !reqArtist) return [];

    var page = Math.max(1, Number(request.page || 1));
    var pageSize = Number(request.pageSize || 20);

    var query = (reqTitle || reqArtist)
      ? buildStructuredQuery(reqTitle, reqArtist)
      : buildQuery(keyword);
    var recordings = searchApiRecordings(query, page, pageSize, config);

    var separator = request.separator || "/";
    var songs = recordings
      .map(function (rec) { return mapRecording(rec, request); })
      .filter(function (song) { return song.id && song.title; });

    // 完整元数据：受 MB 限流约束，仅补全前 N 首；失败（限流）即中断，靠缓存逐步补全
    if (config.enrich) {
      var limit = Math.min(config.enrichLimit, songs.length);
      for (var i = 0; i < limit; i++) {
        if (!enrichSong(songs[i], config, separator)) break;
      }
    }

    return songs;
  } catch (e) {
    Platform.log.error("MusicBrainz", "searchSongs failed: " + (e && e.message ? e.message : e));
    return [];
  }
}

function searchCovers(request) {
  try {
    var config = MusicBrainz.getConfig(request);
    var keyword = String(request.keyword || "").trim();
    // song 模式：Lyrico 的 searchCovers(request.song) 携带结构化 title/artist（批量打标场景）；
    // 顶层 title/artist 为未来版本预留字段，两者取先
    var reqSong = request.song || {};
    var reqTitle = String(request.title || reqSong.title || "").trim();
    var reqArtist = String(request.artist || reqSong.artist || "").trim();
    if (!keyword && !reqTitle && !reqArtist) return [];

    var page = Math.max(1, Number(request.page || 1));
    var pageSize = Number(request.pageSize || 5);

    var query = (reqTitle || reqArtist)
      ? buildStructuredQuery(reqTitle, reqArtist)
      : buildQuery(keyword);
    var recordings = searchApiRecordings(query, page, pageSize, config);
    var songs = recordings
      .map(function (rec) { return mapRecording(rec, request); })
      .filter(function (song) { return song.picUrl && song.title && song.artist && song.album && song.date; });

    return songs;
  } catch (e) {
    Platform.log.error("MusicBrainz", "searchCovers failed: " + (e && e.message ? e.message : e));
    return [];
  }
}
