// MusicBrainz 数据映射：artist-credit 拼接、work 关系 → 词曲作者
var MusicBrainz = MusicBrainz || {};

/**
 * artist-credit 数组 → 字符串。
 * 优先使用 MB 自带的 joinphrase（如 " feat. "、" & "），缺失时回退分隔符
 */
MusicBrainz.joinArtistCredit = function (credit, separator) {
  if (!Array.isArray(credit)) return "";
  var result = "";
  for (var i = 0; i < credit.length; i++) {
    var part = credit[i];
    if (!part || !part.name) continue;
    result += part.name;
    if (part.joinphrase) {
      result += part.joinphrase;
    } else if (i < credit.length - 1) {
      result += (separator || "/");
    }
  }
  return result;
};

/** 取录音详情中第一个关联的 work MBID（recording lookup 需 inc=work-rels） */
MusicBrainz.extractWorkMbid = function (recordingDetail) {
  var relations = (recordingDetail && recordingDetail.relations) || [];
  for (var i = 0; i < relations.length; i++) {
    var rel = relations[i];
    if (rel["target-type"] === "work" && rel.work && rel.work.id) {
      return rel.work.id;
    }
  }
  return null;
};

/**
 * work 详情（inc=artist-rels）→ 词曲作者。
 * MB 关系类型：composer（作曲）/ lyricist（作词）/ writer（词曲兼写，映射到两者）
 */
MusicBrainz.extractCreditsFromWork = function (workDetail) {
  var composers = [];
  var lyricists = [];
  var relations = (workDetail && workDetail.relations) || [];
  for (var i = 0; i < relations.length; i++) {
    var rel = relations[i];
    var name = rel.artist && rel.artist.name;
    if (!name) continue;
    if (rel.type === "composer") {
      composers.push(name);
    } else if (rel.type === "lyricist") {
      lyricists.push(name);
    } else if (rel.type === "writer") {
      composers.push(name);
      lyricists.push(name);
    }
  }
  return { composers: composers, lyricists: lyricists };
};

/** 录音详情的 genres（inc=genres）→ 名称数组，按计数降序 */
MusicBrainz.extractGenres = function (recordingDetail) {
  var genres = (recordingDetail && recordingDetail.genres) || [];
  var mapped = [];
  for (var i = 0; i < genres.length; i++) {
    if (genres[i] && genres[i].name) mapped.push({ name: genres[i].name, count: genres[i].count || 0 });
  }
  mapped.sort(function (a, b) { return b.count - a.count; });
  return mapped.map(function (g) { return g.name; });
};
