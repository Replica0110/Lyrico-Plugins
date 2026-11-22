// COV (covers.musichoarders.xyz) — 纯封面插件。
// 一次搜索聚合 25+ 在线音乐服务的专辑封面，返回各源的最大尺寸封面 URL 与富元数据。
// 只实现 searchCovers（该服务无歌词数据）。

var COV_TAG = "COV";

function covResolveQuery(request) {
  request = request || {};
  var song = request.song || {};
  var title = Lyrico.firstText(request.title, song.title);
  var artist = Lyrico.firstText(request.artist, song.artist);
  var album = Lyrico.firstText(request.album, song.album);
  var keyword = Lyrico.firstText(request.keyword);
  // COV 以 album 为主键；没有 album 时用 title 兜底搜，artist 辅助。
  var queryAlbum = album || title || keyword;
  var queryArtist = artist || "";
  if (!queryAlbum && keyword) {
    // keyword 形如 "歌名 艺术家"：无法可靠切分，整体当 album 查（源端会模糊匹配）
    queryAlbum = keyword;
  }
  return { album: queryAlbum, artist: queryArtist, title: title, song: song };
}

function covBuildCoverResult(rec, q, index) {
  // 宿主 searchCovers 校验（apiVersion>=4）要求 title/artist/album/date 都非空，缺一报错。
  var title = rec.title || q.title || q.album || "0000";
  var artist = rec.artist || q.artist || "Unknown Artist";
  var album = rec.album || q.album || title;
  var date = rec.date || (q.song && q.song.date) || "0000";
  return {
    id: String(rec.barcode || rec.source + ":" + index),
    title: title,
    artist: artist,
    album: album,
    date: date,
    picUrl: rec.picUrl,
    fields: {
      title: title,
      artist: artist,
      album: album,
      date: date,
      cover_url: rec.picUrl
    },
    internal: {
      cov_source: rec.source,
      cov_source_name: rec.sourceName,
      cov_url: rec.url,
      cov_barcode: rec.barcode,
      cov_tracks: rec.tracks,
      cov_small_url: rec.smallUrl
    }
  };
}

function searchCovers(request) {
  request = request || {};
  var config = request.config || {};
  var q = covResolveQuery(request);
  if (!q.album) return [];
  var country = String(Lyrico.firstText(config.country) || "us").toLowerCase();
  var sources = null;
  var custom = String(Lyrico.firstText(config.sources) || "").trim();
  if (custom) {
    sources = custom.split(/[,\s]+/).map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  }
  var limit = Number(request.pageSize || 20);
  try {
    var records = CovApi.search(q.album, q.artist, country, sources, limit);
    if (!records || !records.length) return [];
    var out = [];
    for (var i = 0; i < records.length && out.length < limit; i++) {
      out.push(covBuildCoverResult(records[i], q, i));
    }
    return out;
  } catch (e) {
    Lyrico.warn(COV_TAG, "searchCovers failed: " + String(e && e.message ? e.message : e));
    return [];
  }
}
