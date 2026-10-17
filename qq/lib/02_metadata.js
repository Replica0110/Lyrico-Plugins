// 补全只消费结构化详情；三个插件单独打包，因此各自包含此工具。
const Metadata = {
  prefix: "qq.metadata.v1.",
  ttl: 7 * 24 * 3600 * 1000,
  memory: new Map(),
  enabled(request) {
    const value = (request.config || {}).metadata_details;
    return request.metadata !== false && value !== false && value !== "false";
  },
  get(key) {
    key = this.prefix + key;
    const entry = this.memory.get(key);
    if (entry && entry.until > Date.now()) return entry.value;
    this.memory.delete(key);
    try {
      const raw = Platform.cache && Platform.cache.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  },
  set(key, value, ttl = this.ttl) {
    key = this.prefix + key;
    this.memory.set(key, { value, until: Date.now() + ttl });
    try {
      if (Platform.cache) Platform.cache.set(key, JSON.stringify(value), ttl);
    } catch (_) {}
  },
  text(value) {
    return typeof value === "string" ? value.replace(/[\u200B-\u200D\uFEFF]/g, "").trim() : "";
  },
  names(values) {
    const list = Array.isArray(values) ? values : [];
    return [...new Set(list.map(value => this.text(value)).filter(Boolean))];
  },
  people(value) {
    // 这是详情中的署名字段，不是歌词内容；只拆分平台给出的姓名列表。
    if (Array.isArray(value)) return this.names(value);
    return this.names(this.text(value).split(/\s*(?:、|\/|，|,|；|;|\s&\s)\s*/))
      .filter(name => !/^(未知|暂无|无|佚名|unknown|none)$/i.test(name));
  },
  index(value) {
    if (typeof value !== "string" && typeof value !== "number") return "";
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 && number < 1000 ? String(number) : "";
  },
  apply(song, fields, separator) {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) return;
    Object.keys(fields).forEach(key => {
      const value = Array.isArray(fields[key]) ? this.names(fields[key]).join(separator || "/") : this.text(fields[key]);
      if (value && !song.fields[key]) song.fields[key] = value;
    });
    song.trackNumber = song.fields.track_number || song.trackNumber;
    song.discNumber = song.fields.disc_number || song.discNumber;
  },
  select(songs, key, limit) {
    // 只查前 limit 条结果涉及的实体，不扫描整页展开后的所有版本。
    return [...new Set(songs.slice(0, limit).map(key).filter(Boolean))];
  },
  run(startedAt, fetch) {
    if (this.get("cooldown")) return null;
    const remaining = startedAt + 10000 - Date.now();
    if (remaining < 500) return null;
    const connectTimeoutMs = Math.min(1000, Math.floor(remaining / 3));
    const options = { connectTimeoutMs, readTimeoutMs: Math.min(2500, remaining - connectTimeoutMs) };
    try {
      return fetch(options);
    } catch (error) {
      this.set("cooldown", true, 2 * 60 * 1000);
      Platform.log.warn("Metadata", String(error && error.message ? error.message : error));
      return null;
    }
  }
};

function enrichMetadata(songs, request, startedAt) {
  if (!Metadata.enabled(request)) return songs;
  const songKey = song => (song.internal || {}).songMid || "";
  const albumKey = song => (song.internal || {}).albumMid || "";
  const mids = Metadata.select(songs, songKey, 5).filter(mid => !Metadata.get("song." + mid));
  const albums = Metadata.select(songs, albumKey, 3).filter(mid => !Metadata.get("album." + mid));
  if (mids.length || albums.length) {
    Metadata.run(startedAt, options => {
      const body = { comm: QQ_DESKTOP_COMM };
      mids.forEach((mid, i) => {
        body["s" + i] = {
          module: "music.pf_song_detail_svr", method: "get_song_detail_yqq",
          param: { song_type: 0, song_mid: mid }
        };
      });
      albums.forEach((mid, i) => {
        body["a" + i] = {
          module: "music.musichallAlbum.AlbumInfoServer", method: "GetAlbumDetail",
          param: { albumMid: mid }
        };
      });
      const root = JSON.parse(Platform.http.postText(QQ_MUSICU_DESKTOP_URL, JSON.stringify(body), Object.assign({
        contentType: "application/json; charset=utf-8",
        headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://y.qq.com/" }
      }, options)));
      let failed = root.code != null && Number(root.code) !== 0;
      mids.forEach((mid, i) => {
        const result = root["s" + i];
        if (!result || Number(result.code) !== 0 || !result.data || !result.data.info) { failed = true; return; }
        const info = result.data.info;
        const values = key => Metadata.names(((info[key] || {}).content || []).map(entry => entry && entry.value));
        Metadata.set("song." + mid, { genre: values("genre"), language: values("lan") });
      });
      albums.forEach((mid, i) => {
        const result = root["a" + i];
        if (!result || Number(result.code) !== 0 || !result.data || !result.data.singer) { failed = true; return; }
        const artists = result.data.singer.singerList;
        Metadata.set("album." + mid, { album_artist: Metadata.names((Array.isArray(artists) ? artists : []).map(artist => artist && artist.name)) });
      });
      if (failed) throw new Error("QQ metadata response rejected or incomplete");
      return true;
    });
  }
  songs.forEach(song => {
    Metadata.apply(song, Metadata.get("song." + songKey(song)), request.separator);
    Metadata.apply(song, Metadata.get("album." + albumKey(song)), request.separator);
  });
  return songs;
}
