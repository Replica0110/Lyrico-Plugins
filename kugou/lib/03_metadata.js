// 补全只消费结构化详情；三个插件单独打包，因此各自包含此工具。
const Metadata = {
  prefix: "kugou.metadata.v1.",
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

function metadataGateway(path, data, tid, options) {
  const body = JSON.stringify(data);
  const params = {
    dfid: "-", mid: DEVICE_MID, uuid: "-", appid: "1005", clientver: "20489",
    clienttime: String(Math.floor(Date.now() / 1000))
  };
  const salt = "OIlwieks28dk2k092lksi2UIkp";
  const sorted = Object.keys(params).sort().map(key => key + "=" + params[key]).join("");
  params.signature = Platform.crypto.md5(salt + sorted + body + salt);
  const root = JSON.parse(Platform.http.postText("https://gateway.kugou.com" + path + "?" + buildQuery(params), body, Object.assign({
    contentType: "application/json",
    headers: {
      "User-Agent": "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi",
      "x-router": "openapi.kugou.com", "KG-TID": tid,
      dfid: "-", mid: DEVICE_MID, clienttime: params.clienttime
    }
  }, options)));
  if (!root || Number(root.error_code != null ? root.error_code : root.errcode || 0) !== 0 || root.status === 0 || !Array.isArray(root.data)) {
    throw new Error("Kugou metadata response rejected or incomplete");
  }
  return root.data;
}

function metadataGenres(tags) {
  if (!Array.isArray(tags)) return [];
  return Metadata.names(tags.filter(tag => tag && Number(tag.pid) === 3).flatMap(main => {
    const name = Metadata.text(main.name);
    if (!name) return [];
    const subs = tags.filter(tag => tag && Number(tag.pid) === Number(main.id)).map(tag => Metadata.text(tag.name)).filter(Boolean);
    return subs.length ? subs.map(sub => name + "-" + sub) : [name];
  }));
}

function enrichMetadata(songs, request, startedAt) {
  if (!Metadata.enabled(request)) return songs;
  const songKey = song => /^[1-9]\d*$/.test(song.id) ? song.id : "";
  const albumKey = song => {
    const id = String((song.internal || {}).albumId || "");
    return /^[1-9]\d*$/.test(id) ? id : "";
  };
  const ids = Metadata.select(songs, songKey, 5).filter(id => !Metadata.get("song." + id));
  const albums = Metadata.select(songs, albumKey, 3).filter(id => !Metadata.get("album." + id));
  if (ids.length) {
    Metadata.run(startedAt, options => {
      const data = metadataGateway("/kmr/v2/audio", {
        data: ids.map(id => ({ entity_id: Number(id) })), fields: "base,extra,tags"
      }, "238", options);
      const received = new Set();
      data.forEach(item => {
        const base = item && item.base;
        if (!base) return;
        const id = String(base.album_audio_id || "");
        if (!ids.includes(id)) return;
        const extra = item.extra || {};
        received.add(id);
        Metadata.set("song." + id, {
          lyricist: Metadata.people(extra.lyrics), composer: Metadata.people(extra.composer),
          track_number: Metadata.index(extra.sort), disc_number: Metadata.index(extra.disc),
          language: Metadata.text(base.language), genre: metadataGenres(item.tags)
        });
      });
      if (received.size !== ids.length) throw new Error("Kugou audio metadata response incomplete");
      return true;
    });
  }
  if (albums.length) {
    Metadata.run(startedAt, options => {
      const data = metadataGateway("/kmr/v2/albums", {
        data: albums.map(id => ({ album_id: id })), is_buy: 0,
        fields: "album_id,authors"
      }, "255", options);
      const received = new Set();
      data.forEach(album => {
        if (!album) return;
        const id = String(album.album_id || "");
        if (!albums.includes(id)) return;
        received.add(id);
        Metadata.set("album." + id, { album_artist: Metadata.names((Array.isArray(album.authors) ? album.authors : []).map(artist => artist && artist.author_name)) });
      });
      if (received.size !== albums.length) throw new Error("Kugou album metadata response incomplete");
      return true;
    });
  }
  songs.forEach(song => {
    Metadata.apply(song, Metadata.get("song." + songKey(song)), request.separator);
    Metadata.apply(song, Metadata.get("album." + albumKey(song)), request.separator);
  });
  return songs;
}
