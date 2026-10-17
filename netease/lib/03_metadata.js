// 补全只消费结构化详情；三个插件单独打包，因此各自包含此工具。
const Metadata = {
  prefix: "netease.metadata.v1.",
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
  const albumKey = song => {
    const id = String((song.internal || {}).albumId || "");
    return /^[1-9]\d*$/.test(id) ? id : "";
  };
  const albums = Metadata.select(songs, albumKey, 3).filter(id => !Metadata.get("album." + id));
  if (albums.length) {
    Metadata.run(startedAt, options => {
      const params = albums.map(id => encodeURIComponent("/api/v1/album/" + id) + "=" + encodeURIComponent("{}"));
      const root = JSON.parse(Platform.http.postText("https://music.163.com/api/batch", params.join("&"), Object.assign({
        contentType: "application/x-www-form-urlencoded; charset=utf-8",
        headers: { "User-Agent": USER_AGENT, "Referer": "https://music.163.com/" }
      }, options)));
      let failed = Number(root.code) !== 200;
      albums.forEach(id => {
        const result = root["/api/v1/album/" + id];
        if (!result || Number(result.code) !== 200 || !result.album || String(result.album.id) !== id) { failed = true; return; }
        const album = result.album;
        const artists = Array.isArray(album.artists) && album.artists.length ? album.artists : (album.artist ? [album.artist] : []);
        Metadata.set("album." + id, { album_artist: Metadata.names(artists.map(artist => artist && artist.name)) });
      });
      if (failed) throw new Error("NetEase metadata response rejected or incomplete");
      return true;
    });
  }
  songs.forEach(song => Metadata.apply(song, Metadata.get("album." + albumKey(song)), request.separator));
  return songs;
}
