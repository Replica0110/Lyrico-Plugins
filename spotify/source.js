var SPOTIFY_TAG = "Spotify";
var SECRETS_URL = "https://raw.githubusercontent.com/xyloflake/spot-secrets-go/refs/heads/main/secrets/secretDict.json";
var TOKEN_URL = "https://open.spotify.com/api/token";
var SERVER_TIME_URL = "https://open.spotify.com/api/server-time";
var CLIENT_TOKEN_URL = "https://clienttoken.spotify.com/v1/clienttoken";
var PARTNER_GRAPHQL_URL = "https://api-partner.spotify.com/pathfinder/v2/query";
var SEARCH_HASHES = [
  "0dff51c99e552b992377a2a6f40d213dc42b62db86ca0bcf16cf3934aec1aae6",
  "75bbf6bfcfdf85b8fc828417bfad92b7cd66bf7f556d85670f4da8292373ebec"
];
var LYRICS_URL = "https://spclient.wg.spotify.com/color-lyrics/v2/track/";
var CLIENT_VERSION = "1.2.57.183.g8c1b7eb0";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
var FALLBACK_SECRET_DATA = [99,111,47,88,49,56,118,65,52,67,50,104,117,101,55,94,95,75,94,49,69,36,85,64,74,60];
var FALLBACK_TOTP_VERSION = "19";

function spotifySpDc(request) {
  return String(Lyrico.config(request, "sp_dc", "") || "").trim();
}

// ---------- crypto ----------
function spotifySha1Bytes(bytes) {
  function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
  var h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  var msg = bytes.slice();
  var bitLen = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  // append length as 64-bit big-endian
  var hi = Math.floor(bitLen / 0x100000000);
  var lo = bitLen >>> 0;
  for (var i = 7; i >= 4; i--) msg.push((hi >>> (i * 8)) & 0xff);
  for (var i = 3; i >= 0; i--) msg.push((lo >>> (i * 8)) & 0xff);

  for (var off = 0; off < msg.length; off += 64) {
    var w = [];
    for (var i = 0; i < 16; i++) {
      w[i] = (msg[off + i*4] << 24) | (msg[off + i*4 + 1] << 16) | (msg[off + i*4 + 2] << 8) | (msg[off + i*4 + 3]);
    }
    for (var i = 16; i < 80; i++) {
      w[i] = rotl(w[i-3] ^ w[i-8] ^ w[i-14] ^ w[i-16], 1);
    }
    var a = h0, b = h1, c = h2, d = h3, e = h4;
    for (var i = 0; i < 80; i++) {
      var f, k;
      if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      var temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  var out = [];
  [h0,h1,h2,h3,h4].forEach(function (h) {
    for (var i = 3; i >= 0; i--) out.push((h >>> (i*8)) & 0xff);
  });
  return out;
}

function spotifyHmacSha1(keyStr, msgBytes) {
  var keyBytes = [];
  for (var i = 0; i < keyStr.length; i++) keyBytes.push(keyStr.charCodeAt(i) & 0xff);
  var blockSize = 64;
  if (keyBytes.length > blockSize) keyBytes = spotifySha1Bytes(keyBytes);
  while (keyBytes.length < blockSize) keyBytes.push(0);
  var iKey = [], oKey = [];
  for (var i = 0; i < blockSize; i++) {
    iKey.push(keyBytes[i] ^ 0x36);
    oKey.push(keyBytes[i] ^ 0x5c);
  }
  var inner = spotifySha1Bytes(iKey.concat(msgBytes));
  return spotifySha1Bytes(oKey.concat(inner));
}

function spotifyTotp(secretStr, timeMs) {
  var counter = Math.floor(timeMs / 1000 / 30);
  var counterBytes = [];
  var tmp = counter;
  for (var i = 7; i >= 0; i--) {
    counterBytes[i] = tmp & 0xff;
    tmp = Math.floor(tmp / 256);
  }
  // ensure 8 bytes
  if (counterBytes.length !== 8) {
    var cb = [0,0,0,0,0,0,0,0];
    for (var i = 0; i < 8; i++) cb[i] = counterBytes[i] || 0;
    counterBytes = cb;
  }
  var hash = spotifyHmacSha1(secretStr, counterBytes);
  var offset = hash[hash.length - 1] & 0x0f;
  var binary = ((hash[offset] & 0x7f) << 24)
    | ((hash[offset + 1] & 0xff) << 16)
    | ((hash[offset + 2] & 0xff) << 8)
    | (hash[offset + 3] & 0xff);
  var otp = binary % 1000000;
  var s = String(otp);
  while (s.length < 6) s = "0" + s;
  return s;
}

// ---------- secrets ----------
function spotifySecrets() {
  var cached = Lyrico.cacheGet("spotify.secrets.v1");
  if (cached && cached.secret && cached.version) return cached;
  var text = Lyrico.getText(SECRETS_URL, { headers: { "User-Agent": UA }, readTimeoutMs: 15000 });
  var json = text ? Lyrico.parseJson(text) : null;
  var secret = null, version = null;
  if (json && typeof json === "object") {
    var newest = -1;
    for (var k in json) {
      var v = parseInt(k, 10);
      if (!isNaN(v) && v > newest) newest = v;
    }
    if (newest >= 0) {
      var arr = json[String(newest)];
      if (Array.isArray(arr)) {
        var xored = arr.map(function (val, i) { return Number(val) ^ ((i % 33) + 9); });
        secret = xored.map(function (v) { return String(v); }).join("");
        version = String(newest);
      }
    }
  }
  if (!secret) {
    secret = FALLBACK_SECRET_DATA.map(function (v) { return String(v); }).join("");
    version = FALLBACK_TOTP_VERSION;
  }
  var out = { secret: secret, version: version };
  Lyrico.cacheSet("spotify.secrets.v1", out, 60 * 60 * 1000);
  return out;
}

// ---------- auth ----------
var spotifyClientIdHolder = "";

function spotifyServerTimeMs(spDc) {
  var res = Lyrico.request("GET", SERVER_TIME_URL, {
    headers: { "User-Agent": UA, "Accept": "application/json", "Cookie": "sp_dc=" + spDc },
    readTimeoutMs: 10000
  });
  if (res.code === 200) {
    var json = Lyrico.parseJson(res.body);
    if (json && json.serverTime) return Number(json.serverTime) * 1000;
  }
  return Date.now();
}

function spotifyAccessToken(spDc) {
  if (!spDc) return null;
  var cacheKey = "spotify.token." + spDc.slice(0, 6);
  var cached = Lyrico.cacheGet(cacheKey);
  if (cached && cached.accessToken) return cached.accessToken;

  var sec = spotifySecrets();
  if (!sec) return null;
  var serverTimeMs = spotifyServerTimeMs(spDc);
  var totpValue = spotifyTotp(sec.secret, serverTimeMs);
  var url = TOKEN_URL + "?" + Lyrico.buildQuery({
    reason: "init",
    productType: "web-player",
    totp: totpValue,
    totpVer: sec.version,
    totpServer: totpValue
  });
  var res = Lyrico.request("GET", url, {
    headers: {
      "User-Agent": UA, "Accept": "application/json", "App-Platform": "WebPlayer",
      "Referer": "https://open.spotify.com/", "Cookie": "sp_dc=" + spDc
    },
    readTimeoutMs: 15000
  });
  if (res.code !== 200) {
    Lyrico.warn(SPOTIFY_TAG, "token http " + res.code + " " + String(res.body).slice(0, 200));
    return null;
  }
  var json = Lyrico.parseJson(res.body);
  if (!json || !json.accessToken) return null;
  spotifyClientIdHolder = json.clientId || spotifyClientIdHolder;
  var expiresIn = Number(json.expiresIn || 3600);
  Lyrico.cacheSet(cacheKey, { accessToken: json.accessToken, clientId: json.clientId || "" }, Math.max(60000, expiresIn * 1000 - 60000));
  return json.accessToken;
}

function spotifyClientToken(spDc) {
  if (!spDc) return null;
  var cacheKey = "spotify.clienttoken." + spDc.slice(0, 6);
  var cached = Lyrico.cacheGet(cacheKey);
  if (cached && cached.token) return cached.token;
  var accessToken = spotifyAccessToken(spDc);
  if (!accessToken) return null;
  var clientId = spotifyClientIdHolder;
  if (!clientId) {
    var tc = Lyrico.cacheGet("spotify.token." + spDc.slice(0, 6));
    clientId = (tc && tc.clientId) || "";
  }
  if (!clientId) return null;
  var deviceId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0;
    var v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
  var body = JSON.stringify({
    client_data: {
      client_version: CLIENT_VERSION,
      client_id: clientId,
      js_sdk_data: {
        device_brand: "unknown", device_model: "unknown", os: "linux",
        os_version: "unknown", device_id: deviceId, device_type: "computer"
      }
    }
  });
  var res = Lyrico.request("POST", CLIENT_TOKEN_URL, {
    body: body,
    headers: {
      "User-Agent": UA, "Accept": "application/json", "Content-Type": "application/json",
      "Origin": "https://open.spotify.com", "Referer": "https://open.spotify.com"
    },
    contentType: "application/json",
    readTimeoutMs: 15000
  });
  if (res.code !== 200) return null;
  var json = Lyrico.parseJson(res.body);
  var granted = json && json.granted_token;
  if (!granted || !granted.token) return null;
  var expiresIn = Number(granted.expires_after || 3600);
  Lyrico.cacheSet(cacheKey, { token: granted.token }, Math.max(60000, expiresIn * 1000 - 60000));
  return granted.token;
}

// ---------- search ----------
function spotifySearchTrack(spDc, title, artist) {
  var accessToken = spotifyAccessToken(spDc);
  if (!accessToken) return null;
  var clientToken = spotifyClientToken(spDc);
  var query = (title + " " + artist).trim();
  for (var h = 0; h < SEARCH_HASHES.length; h++) {
    var body = JSON.stringify({
      extensions: { persistedQuery: { sha256Hash: SEARCH_HASHES[h], version: 1 } },
      operationName: "searchDesktop",
      variables: { searchTerm: query, limit: 5, numberOfTopResults: 5, offset: 0 }
    });
    var headers = {
      "User-Agent": UA, "Accept": "application/json", "Content-Type": "application/json",
      "Authorization": "Bearer " + accessToken,
      "app-platform": "WebPlayer",
      "Referer": "https://open.spotify.com/",
      "Origin": "https://open.spotify.com",
      "spotify-app-version": CLIENT_VERSION
    };
    if (clientToken) headers["client-token"] = clientToken;
    var res = Lyrico.request("POST", PARTNER_GRAPHQL_URL, {
      body: body,
      headers: headers,
      contentType: "application/json",
      readTimeoutMs: 20000
    });
    if (res.code !== 200) continue;
    var json = Lyrico.parseJson(res.body);
    var hit = spotifyParseSearch(json);
    if (hit) return hit;
  }
  return null;
}

function spotifyParseSearch(json) {
  var data = json && json.data;
  if (!data) return null;
  var searchV2 = data.searchV2;
  var items = null;
  if (searchV2 && searchV2.tracks) items = searchV2.tracks.items;
  if (!items && data.search && data.search.tracks) items = data.search.tracks.items;
  if (!Array.isArray(items) || !items.length) return null;
  for (var i = 0; i < items.length; i++) {
    var wrapper = items[i];
    var node = (wrapper && wrapper.data) ? wrapper.data : wrapper;
    if (!node) continue;
    var id = node.id || "";
    if (!id && node.uri && String(node.uri).indexOf("spotify:track:") === 0) {
      id = String(node.uri).slice("spotify:track:".length);
    }
    if (!id) continue;
    var title = node.name || "";
    var artists = [];
    if (Array.isArray(node.artists)) {
      for (var a = 0; a < node.artists.length; a++) {
        var ar = node.artists[a];
        var name = (ar && (ar.name || (ar.profile && ar.profile.name))) || "";
        if (name) artists.push(name);
      }
    }
    if (!artists.length && node.artist) artists.push(String(node.artist));
    var album = "";
    var albumCover = "";
    if (node.albumOf && node.albumOf) {
      var albumNode = node.albumOf;
      album = albumNode.name || "";
      if (Array.isArray(albumNode.images) && albumNode.images.length > 0) {
        var largest = albumNode.images.reduce(function (max, img) {
          return (img.width || 0) > (max.width || 0) ? img : max;
        }, { width: 0 });
        albumCover = largest.url || "";
      }
    } else if (node.album && node.album) {
      var albumNode = node.album;
      album = albumNode.name || "";
      if (Array.isArray(albumNode.images) && albumNode.images.length > 0) {
        var largest = albumNode.images.reduce(function (max, img) {
          return (img.width || 0) > (max.width || 0) ? img : max;
        }, { width: 0 });
        albumCover = largest.url || "";
      }
    }
    return { id: id, title: title, artists: artists, album: album, cover: albumCover };
  }
  return null;
}

// ---------- lyrics ----------
function spotifyParseStartTimeMs(obj) {
  var raw = obj && obj.startTimeMs;
  if (raw === undefined || raw === null || raw === "") return 0;
  var n = Number(raw);
  return isFinite(n) ? n : 0;
}

function spotifyParseSyllables(syllablesArr, lineText) {
  var words = [];
  var charOffset = 0;
  for (var j = 0; j < syllablesArr.length; j++) {
    var syll = syllablesArr[j];
    if (!syll) continue;
    var startMs = Number(syll.startTimeMs || 0);
    var endMs = Number(syll.endTimeMs || startMs);
    var numChars = Number(syll.numChars || 0);
    if (numChars <= 0) continue;
    while (charOffset < lineText.length && /\s/.test(lineText.charAt(charOffset))) charOffset++;
    if (charOffset >= lineText.length) break;
    var end = Math.min(charOffset + numChars, lineText.length);
    var wordText = lineText.substring(charOffset, end);
    if (wordText) words.push([startMs, endMs > startMs ? endMs : startMs + 1, wordText]);
    charOffset = end;
  }
  return words;
}

function spotifyParseLyrics(response) {
  var lyricsObj = response && response.lyrics;
  if (!lyricsObj) return null;
  var syncType = String(lyricsObj.syncType || "UNSYNCED");
  var linesArr = lyricsObj.lines;
  if (!Array.isArray(linesArr) || !linesArr.length) return null;

  var entries = [];
  for (var i = 0; i < linesArr.length; i++) {
    var lineObj = linesArr[i];
    if (!lineObj) continue;
    var text = String(lineObj.words || "").trim();
    if (!text) continue;
    if (syncType === "SYLLABLE_SYNCED") {
      var syllables = lineObj.syllables;
      var words = [];
      if (Array.isArray(syllables) && syllables.length) {
        words = spotifyParseSyllables(syllables, text);
      }
      if (!words.length) words = [[spotifyParseStartTimeMs(lineObj), spotifyParseStartTimeMs(lineObj) + 1, text]];
      entries.push({ start: spotifyParseStartTimeMs(lineObj), text: text, words: words, syllable: true });
    } else if (syncType !== "UNSYNCED") {
      entries.push({ start: spotifyParseStartTimeMs(lineObj), text: text, words: null, syllable: false });
    } else {
      entries.push({ start: 0, text: text, words: null, syllable: false });
    }
  }
  if (!entries.length) return null;
  entries.sort(function (a, b) { return a.start - b.start; });

  var original = [];
  for (var k = 0; k < entries.length; k++) {
    var e = entries[k];
    var end = k + 1 < entries.length ? entries[k + 1].start : e.start + 3000;
    if (end <= e.start) end = e.start + 3000;
    if (e.words) {
      // ensure word ends
      var ws = e.words;
      for (var w = 0; w < ws.length; w++) {
        if (ws[w][1] <= ws[w][0]) ws[w][1] = (w + 1 < ws.length) ? ws[w + 1][0] : end;
        if (ws[w][1] <= ws[w][0]) ws[w][1] = ws[w][0] + 1;
      }
      original.push([e.start, end, ws]);
    } else {
      original.push([e.start, end, e.text]);
    }
  }
  return original;
}

function spotifyFetchLyrics(spDc, trackId) {
  var accessToken = spotifyAccessToken(spDc);
  if (!accessToken) return null;
  var url = LYRICS_URL + encodeURIComponent(trackId) + "?format=json&market=from_token";
  var text = Lyrico.getBytesText(url, {
    headers: { "User-Agent": UA, "Authorization": "Bearer " + accessToken, "app-platform": "WebPlayer", "Accept": "application/json" },
    readTimeoutMs: 20000
  });
  if (!text) return null;
  return Lyrico.parseJson(text);
}

// ---------- plugin API ----------
function searchSongs(request) {
  request = request || {};
  var spDc = spotifySpDc(request);
  if (!spDc) return [];
  var title = Lyrico.firstText(request.title);
  var artist = Lyrico.firstText(request.artist);
  var keyword = Lyrico.firstText(request.keyword);
  var queryTitle = title || keyword;
  var queryArtist = artist || "";
  if (!queryTitle) return [];
  var hit = spotifySearchTrack(spDc, queryTitle, queryArtist);
  if (!hit) return [];
  return [{
    id: String(hit.id),
    title: hit.title || queryTitle,
    artist: (hit.artists || []).join(" / ") || queryArtist,
    album: hit.album || "",
    duration: 0,
    date: "",
    picUrl: hit.cover || "",
    fields: {
      title: hit.title || queryTitle,
      artist: (hit.artists || []).join(" / ") || queryArtist,
      album: hit.album || "",
      cover_url: hit.cover || ""
    },
    internal: { spotify_id: String(hit.id) }
  }];
}

function searchCovers(request) {
  request = request || {};
  var spDc = spotifySpDc(request);
  if (!spDc) return [];
  var title = Lyrico.firstText(request.title);
  var artist = Lyrico.firstText(request.artist);
  var keyword = Lyrico.firstText(request.keyword);
  var queryTitle = title || keyword;
  var queryArtist = artist || "";
  if (!queryTitle) return [];
  var hit = spotifySearchTrack(spDc, queryTitle, queryArtist);
  if (!hit || !hit.cover) return [];
  return [{
    id: String(hit.id),
    title: hit.title || queryTitle,
    artist: (hit.artists || []).join(" / ") || queryArtist,
    album: hit.album || "",
    picUrl: hit.cover,
    fields: {
      title: hit.title || queryTitle,
      artist: (hit.artists || []).join(" / ") || queryArtist,
      album: hit.album || "",
      cover_url: hit.cover
    },
    internal: { spotify_id: String(hit.id) }
  }];
}

function getLyrics(request) {
  request = request || {};
  var spDc = spotifySpDc(request);
  if (!spDc) {
    Lyrico.warn(SPOTIFY_TAG || "Spotify", "Spotify requires sp_dc cookie in plugin config.");
    return [];
  }
  var requestedSong = request.song || {};
  var songs = requestedSong.title ? [requestedSong] : [];
  if (!songs.length && request.keyword) {
    // Try iTunes catalog to obtain a title/artist pair.
    songs = [];
  }

  var candidates = [];
  for (var i = 0; i < songs.length; i++) {
    var song = songs[i];
    if (!song || !song.title) continue;
    try {
      var internal = song.internal || {};
      var trackId = Lyrico.firstText(internal.spotify_id);
      if (!trackId) {
        var hit = spotifySearchTrack(spDc, song.title, song.artist);
        if (hit) trackId = hit.id;
      }
      if (!trackId) continue;
      var response = spotifyFetchLyrics(spDc, trackId);
      if (!response) continue;
      var original = spotifyParseLyrics(response);
      if (!original || !original.length) continue;
      var tags = Lyrico.ensureTags(request, song, {
        ti: song.title,
        ar: song.artist || "Unknown Artist",
        al: song.album || song.title || "0000",
        date: song.date || "0000"
      });
      if (!tags) continue;
      candidates.push({ type: "structured", tags: tags, original: original });
    } catch (e) {
      Lyrico.warn(SPOTIFY_TAG || (song.title || "0000"), "lyrics candidate failed: " + String(e && e.message ? e.message : e));
    }
  }
  Lyrico.log(SPOTIFY_TAG, "lyrics candidates " + candidates.length);
  return candidates;
}
