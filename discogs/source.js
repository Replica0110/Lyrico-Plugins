// Discogs source plugin — album artwork + full release metadata

var BASE = "https://api.discogs.com";
var UA = "LyricoDiscogsPlugin/1.0 (github.com/BingoKingo/Lyrico-Plugins)";
var RATE_ANON = 25;    // req/min without token
var RATE_TOKEN = 60;   // req/min with personal token
var TAG = "Discogs";

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
var _rate = { lastAt: 0, minMs: Math.floor(60000 / RATE_ANON) };

function _throttle() {
  var now = Date.now();
  var wait = _rate.minMs - (now - _rate.lastAt);
  if (wait > 0) {
    try { Platform.runtime && Platform.runtime.sleep(wait); } catch (e) {}
    var end = Date.now() + wait;
    while (Date.now() < end) {}
  }
  _rate.lastAt = Date.now();
}

function _getToken(request) {
  try { return String((request && request.config && request.config.user_token) || "").trim(); }
  catch (e) { return ""; }
}

function _get(path, params, request) {
  var token = _getToken(request);
  _rate.minMs = Math.floor(60000 / (token ? RATE_TOKEN : RATE_ANON));
  _throttle();

  var qs = [];
  if (params) {
    var keys = Object.keys(params);
    for (var i = 0; i < keys.length; i++) {
      var v = params[keys[i]];
      if (v !== undefined && v !== null && v !== "") {
        qs.push(encodeURIComponent(keys[i]) + "=" + encodeURIComponent(String(v)));
      }
    }
  }
  var url = BASE + path + (qs.length ? "?" + qs.join("&") : "");

  var headers = { "User-Agent": UA, "Accept": "application/json" };
  if (token) headers["Authorization"] = "Discogs token=" + token;

  try {
    var text = Platform.http.getText(url, { headers: headers, readTimeoutMs: 15000 });
    var json = JSON.parse(text);
    if (json && json.message && json.message.indexOf("Too many requests") >= 0) {
      Platform.log.warn(TAG, Platform.i18n.t("error.apiRateLimited"));
      return null;
    }
    return json;
  } catch (e) {
    try {
      return Lyrico.parseJson(Lyrico.getText(url, { headers: headers, readTimeoutMs: 15000 }));
    } catch (e2) {
      Platform.log.warn(TAG, "GET " + path + " failed: " + String(e && e.message ? e.message : e));
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function _buildQuery(request) {
  var keyword = String(request.keyword || "").trim();
  var title = String(request.title || "").trim();
  var artist = String(request.artist || "").trim();
  if (title && artist) return { release_title: title, artist: artist };
  if (title) {
    var p = title.split(/\s+/);
    if (p.length >= 2) return { release_title: p[0], artist: p.slice(1).join(" ") };
    return { release_title: title };
  }
  if (artist) return { artist: artist };
  if (keyword) {
    var t = keyword.split(/\s+/);
    if (t.length >= 2) return { release_title: t[0], artist: t.slice(1).join(" ") };
    return { release_title: keyword };
  }
  return null;
}

function _searchReleases(request) {
  var q = _buildQuery(request);
  if (!q) return [];
  var page = Math.max(1, Number(request.page || 1));
  var pageSize = Number(request.pageSize || 20) || 20;
  var data = _get("/database/search", {
    type: "release", release_title: q.release_title, artist: q.artist,
    per_page: pageSize, page: page, sort: "have", sort_order: "desc"
  }, request);
  var results = data ? (data.results || []) : [];
  // release_title/artist AND 查询对中文等多词 keyword 容易拆错 → 0 结果时用 q 全字段 fallback
  if (results.length === 0) {
    var keyword = String((request && (request.keyword || request.title)) || "").trim();
    if (keyword) {
      var fb = _get("/database/search", {
        type: "release", q: keyword,
        per_page: pageSize, page: page, sort: "have", sort_order: "desc"
      }, request);
      results = fb ? (fb.results || []) : [];
    }
  }
  return results;
}

function _fetchDetail(id, request) {
  if (!id) return null;
  var d = _get("/releases/" + encodeURIComponent(String(id)), null, request);
  return (d && !d.message) ? d : null;
}

// ---------------------------------------------------------------------------
// Field extraction (handles both search-preview and full release detail)
// ---------------------------------------------------------------------------

function _getArtists(d) {
  if (Array.isArray(d.artists) && d.artists.length) return d.artists;
  var sort = String(d.artists_sort || "").trim();
  if (sort) return [{ name: sort, join: "" }];
  var t = String(d.title || "");
  var i = t.indexOf(" - ");
  return i > 0 ? [{ name: t.substring(0, i).trim(), join: "" }] : [];
}

function _getAlbumTitle(d) {
  var t = String(d.title || "");
  var i = t.indexOf(" - ");
  return i > 0 ? t.substring(i + 3).trim() : t.trim();
}

function _getLabels(d) {
  // detail: labels=[{name,catno}]  preview: label=[name], catno="x"
  if (Array.isArray(d.labels) && d.labels.length && typeof d.labels[0] === "object") {
    var names = [], catnos = [];
    for (var i = 0; i < d.labels.length; i++) {
      if (d.labels[i].name) names.push(String(d.labels[i].name));
      if (d.labels[i].catno && d.labels[i].catno !== "(none)") catnos.push(String(d.labels[i].catno));
    }
    return { names: names, catnos: catnos };
  }
  var n = Array.isArray(d.label) ? d.label.slice() : [];
  return { names: n, catnos: (d.catno && d.catno !== "(none)") ? [String(d.catno)] : [] };
}

function _getImage(d) {
  if (Array.isArray(d.images) && d.images.length) {
    for (var i = 0; i < d.images.length; i++) {
      if (d.images[i].type === "primary" && d.images[i].uri) return String(d.images[i].uri);
    }
    if (d.images[0].uri) return String(d.images[0].uri);
  }
  return d.cover_image ? String(d.cover_image) : (d.thumb ? String(d.thumb) : "");
}

function _getBarcode(d) {
  if (Array.isArray(d.identifiers)) {
    for (var i = 0; i < d.identifiers.length; i++) {
      if (d.identifiers[i].type === "Barcode" && d.identifiers[i].value) return String(d.identifiers[i].value).trim();
    }
  }
  if (Array.isArray(d.barcode) && d.barcode.length) return String(d.barcode[0]).trim();
  return "";
}

function _joinArtists(artists, sep) {
  if (!Array.isArray(artists) || !artists.length) return "";
  var out = [];
  for (var i = 0; i < artists.length; i++) {
    var n = String((artists[i] || {}).name || "").trim();
    if (n) out.push(n);
  }
  return out.join(sep || "/");
}

function _parseDuration(s) {
  s = String(s || "").trim();
  if (!s) return 0;
  var p = s.split(":");
  var h = 0, m = 0, sec = 0;
  if (p.length === 3) { h = +p[0]; m = +p[1]; sec = +p[2]; }
  else if (p.length === 2) { m = +p[0]; sec = +p[1]; }
  else { sec = +p[0]; }
  return ((h || 0) * 3600 + (m || 0) * 60 + (sec || 0)) * 1000;
}

function _parsePosition(pos) {
  var s = String(pos || "").trim();
  if (!s) return { disc: "", track: "" };
  var i = s.indexOf("-");
  return i >= 0 ? { disc: s.substring(0, i), track: s.substring(i + 1) } : { disc: "", track: s };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function _baseFields(release, artist, albumTitle, separator, isDetail) {
  var lbl = _getLabels(release);
  var rating = (release.community && release.community.rating) || {};
  var genres = Array.isArray(release.genres) ? release.genres : (Array.isArray(release.genre) ? release.genre : []);
  var styles = Array.isArray(release.styles) ? release.styles : (Array.isArray(release.style) ? release.style : []);
  var formats = isDetail
    ? (Array.isArray(release.formats) ? release.formats.map(function (f) { return f.name; }) : [])
    : (Array.isArray(release.format) ? release.format : []);

  return {
    title: albumTitle,
    artist: artist,
    album: albumTitle,
    album_artist: artist,
    date: release.released ? String(release.released) : String(release.year || ""),
    cover_url: _getImage(release),
    genre: genres.concat(styles).join(separator),
    label: lbl.names.join(separator),
    catalog_number: lbl.catnos.join(separator),
    barcode: _getBarcode(release),
    country: String(release.country || ""),
    format: formats.join(separator),
    rating: rating.average != null ? String(rating.average) : "",
    rating_votes: rating.count != null ? String(rating.count) : ""
  };
}

function _mapPreview(release, request) {
  if (!release) return null;
  var sep = request.separator || "/";
  var artists = _getArtists(release);
  var albumArtist = _joinArtists(artists, sep);
  var albumTitle = _getAlbumTitle(release);
  var fields = _baseFields(release, albumArtist, albumTitle, sep, false);

  return {
    id: String(release.id || ""),
    title: albumTitle,
    artist: albumArtist,
    album: albumTitle,
    date: fields.date,
    duration: 0,
    picUrl: fields.cover_url,
    fields: fields,
    internal: { discogs_release_id: String(release.id || ""), discogs_master_id: release.master_id ? String(release.master_id) : "" }
  };
}

function _mapRelease(release, request) {
  if (!release) return null;
  var sep = request.separator || "/";
  var artists = _getArtists(release);
  var albumArtist = _joinArtists(artists, sep);
  var albumTitle = _getAlbumTitle(release);
  var fields = _baseFields(release, albumArtist, albumTitle, sep, true);
  fields.credits = (Array.isArray(release.extraartists) ? release.extraartists : []).map(function (e) {
    return e.name && e.role ? String(e.role) + ": " + String(e.name) : String(e.name || "");
  }).filter(Boolean).join("; ");

  return {
    id: String(release.id || ""),
    title: albumTitle,
    artist: albumArtist,
    album: albumTitle,
    date: fields.date,
    duration: 0,
    picUrl: fields.cover_url,
    fields: fields,
    internal: { discogs_release_id: String(release.id || ""), discogs_master_id: release.master_id ? String(release.master_id) : "" }
  };
}

function _mapTrack(track, release, request) {
  if (!track || !release) return null;
  var sep = request.separator || "/";
  var releaseArtists = _getArtists(release);
  var albumArtist = _joinArtists(releaseArtists, sep);
  var albumTitle = _getAlbumTitle(release);
  var trackArtists = (Array.isArray(track.artists) && track.artists.length) ? track.artists : releaseArtists;
  var trackArtist = _joinArtists(trackArtists, sep);
  var pos = _parsePosition(track.position);

  var fields = _baseFields(release, trackArtist, albumTitle, sep, true);
  fields.album_artist = albumArtist;
  fields.title = String(track.title || "");
  fields.duration = String(_parseDuration(track.duration));
  fields.track_number = pos.track;
  fields.disc_number = pos.disc;
  fields.credits = (Array.isArray(release.extraartists) ? release.extraartists : []).map(function (e) {
    return e.name && e.role ? String(e.role) + ": " + String(e.name) : String(e.name || "");
  }).filter(Boolean).join("; ");

  return {
    id: String(release.id || "") + "-" + String(track.position || ""),
    title: fields.title,
    artist: trackArtist,
    album: albumTitle,
    date: fields.date,
    duration: _parseDuration(track.duration),
    picUrl: fields.cover_url,
    trackNumber: pos.track,
    fields: fields,
    internal: { discogs_release_id: String(release.id || ""), discogs_master_id: release.master_id ? String(release.master_id) : "" }
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function searchCovers(request) {
  try {
    var req = request || {};
    var raw = _searchReleases(req);
    if (!raw.length) return [];

    var limit = Math.max(1, Number(req.pageSize || 5));
    var out = [];

    for (var i = 0; i < raw.length && out.length < limit; i++) {
      var d = _fetchDetail(raw[i].id, req);
      if (!d) {
        Platform.log.warn(TAG, Platform.i18n.t("warn.detailFetchFailed", String(raw[i].id || ""), "empty response"));
        continue;
      }
      var s = _mapRelease(d, req);
      if (s && s.picUrl && s.title && s.artist && s.album) out.push(s);
    }
    return out;
  } catch (e) {
    Platform.log.error(TAG, Platform.i18n.t("error.searchCoversFailed", String(e && e.message ? e.message : e)));
    return [];
  }
}

function searchSongs(request) {
  try {
    var req = request || {};
    var raw = _searchReleases(req);
    if (!raw.length) return [];

    var enrich = true;
    try { enrich = String((req.config && req.config.enrich_tracks) || "true") !== "false"; } catch (e) {}

    var pageSize = Math.max(1, Number(req.pageSize || 20));
    var out = [];

    for (var i = 0; i < raw.length && out.length < pageSize; i++) {
      if (!enrich) {
        var p = _mapPreview(raw[i], req);
        if (p && p.title) out.push(p);
        continue;
      }

      var d = _fetchDetail(raw[i].id, req);
      if (!d) {
        Platform.log.warn(TAG, Platform.i18n.t("warn.detailFetchFailed", String(raw[i].id || ""), "empty response"));
        continue;
      }

      var tracklist = Array.isArray(d.tracklist) ? d.tracklist : [];
      if (tracklist.length) {
        for (var t = 0; t < tracklist.length && out.length < pageSize; t++) {
          var tk = tracklist[t];
          if (tk.type === "index" || tk.type === "heading") continue;
          var s = _mapTrack(tk, d, req);
          if (s && s.title) out.push(s);
        }
      } else {
        var s2 = _mapRelease(d, req);
        if (s2 && s2.title) out.push(s2);
      }
    }
    return out;
  } catch (e) {
    Platform.log.error(TAG, Platform.i18n.t("error.searchSongsFailed", String(e && e.message ? e.message : e)));
    return [];
  }
}
