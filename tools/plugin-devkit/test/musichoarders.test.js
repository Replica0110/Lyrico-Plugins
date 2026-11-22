import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../src/plugin-loader.js';
import { createRuntime } from '../src/runtime.js';
import { validateFunctionResult } from '../src/result-parser.js';

const root = fileURLToPath(new URL('../../../musichoarders/', import.meta.url));

const ok = body => ({ code: 200, body: typeof body === 'string' ? body : JSON.stringify(body) });

// 与站点 /api/info 一致的结构（实测抓取）
const INFO = {
  sources: [
    { id: 'tidal', name: 'TIDAL', enabled: true, country: false, cors: false, note: '' },
    { id: 'qobuz', name: 'Qobuz', enabled: true, country: false, cors: false, note: '' },
    { id: 'bandcamp', name: 'Bandcamp', enabled: true, country: false, cors: false, note: '' },
    { id: 'spotify', name: 'Spotify', enabled: true, country: false, cors: false, note: '' },
    { id: 'deezer', name: 'Deezer', enabled: true, country: false, cors: false, note: '' }
  ],
  activeSourceLimit: 2, // 故意设小，触发分批
  countries: ['us', 'jp', 'kr', 'de']
};

// 真实 NDJSON 响应的一行（已核对线上结构：type=="cover" + bigCoverUrl + releaseInfo）
function coverLine(source, big, small, rel) {
  return JSON.stringify({
    type: 'cover',
    bigCoverUrl: big,
    smallCoverUrl: small,
    releaseInfo: rel,
    source,
    cache: true
  });
}

const SEARCH_BODY = [
  '{"type":"source","country":"us","source":"tidal","cache":true}',
  '{"type":"count","accuracy":"exact","releaseCount":2,"source":"tidal","cache":true}',
  coverLine('tidal', 'https://resources.tidal.com/images/aa/bb/original.jpg', 'https://resources.tidal.com/images/aa/bb/160x160.jpg',
    { title: 'OK Computer', artist: 'Radiohead', date: '1997-07-01', tracks: 12, barcode: '634904078164', url: 'https://tidal.com/album/1' }),
  coverLine('tidal', 'https://resources.tidal.com/images/cc/dd/original.jpg', '',
    { title: 'In Rainbows', artist: 'Radiohead', date: '2007-10-10', tracks: 10, url: 'https://tidal.com/album/2' })
].join('\n') + '\n' +
coverLine('bandcamp', 'https://f4.bcbits.com/img/ee.jpg', '',
  { title: 'OK Computer', artist: 'Radiohead', date: '1997', url: 'https://radiohead.bandcamp.com/album/ok-computer' });

const SECRET = 'yUzpZk3QDoq6ztdbTB9Zx9MwTB4SSwtj';
function expectedToken() {
  // 与插件内 covHmacSha256 等价：HMAC-SHA256(secret, Int32LE(floor(now/150)))
  const e = Math.floor(Math.floor(Date.now() / 1000) / 150);
  return crypto.createHmac('sha256', Buffer.from(SECRET, 'utf8'))
    .update(Buffer.from([e & 0xff, (e >>> 8) & 0xff, (e >>> 16) & 0xff, (e >>> 24) & 0xff]))
    .digest('base64');
}
function isTokenOk(header) {
  if (!header || !header.startsWith('Bearer ')) return false;
  const tok = header.slice('Bearer '.length);
  // 32 字节 sha256 → base64 44 字符（含末尾 =），允许跨 150s 边界的当前/上一窗口
  if (tok.length !== 44) return false;
  const e = Math.floor(Math.floor(Date.now() / 1000) / 150);
  for (const ee of [e, e - 1]) {
    const cand = crypto.createHmac('sha256', Buffer.from(SECRET, 'utf8'))
      .update(Buffer.from([ee & 0xff, (ee >>> 8) & 0xff, (ee >>> 16) & 0xff, (ee >>> 24) & 0xff]))
      .digest('base64');
    if (cand === tok) return true;
  }
  return false;
}

async function runtime() {
  const plugin = await loadPlugin(root);
  return { plugin, runtime: await createRuntime(plugin) };
}

/** 记录所有 HTTP 调用，/api/info 返回 INFO，/api/search 可控 */
function mockHttp(runtime, { search = SEARCH_BODY, searchCode = 200, infoFail = false } = {}) {
  const calls = { info: 0, search: 0, postBodies: [], postHeaders: [], searchUrls: [] };
  runtime.context.Platform.http.get = (url, options) => {
    const u = new URL(url);
    if (u.pathname === '/api/info') {
      calls.info++;
      if (infoFail) return { code: 500, body: '' };
      // info 必须带浏览器 UA 才能过 Cloudflare
      assert.ok(/Chrome|Safari|Firefox/.test(options.headers['User-Agent']), 'info request must use a browser UA');
      return ok(INFO);
    }
    throw new Error('Unexpected GET: ' + url);
  };
  runtime.context.Platform.http.post = (url, body, options) => {
    const u = new URL(url);
    assert.equal(u.pathname, '/api/search');
    calls.search++;
    calls.searchUrls.push(u.pathname);
    calls.postBodies.push(JSON.parse(body));
    calls.postHeaders.push(options.headers);
    if (searchCode !== 200) return { code: searchCode, body: '' };
    return ok(typeof search === 'function' ? search(calls.search - 1) : search);
  };
  return calls;
}

test('COV plugin loads and validates manifest/i18n', async () => {
  const { plugin } = await runtime();
  assert.equal(plugin.manifest.id, 'com.musichoarders.cov.source');
  assert.deepEqual(plugin.manifest.capabilities, ['searchCovers']);
});

test('COV default searchCovers skips /api/info, sends a single batch, browser UA + valid HMAC', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockHttp(r, { search: SEARCH_BODY });
  const result = JSON.parse((await r.call('searchCovers', {
    title: 'OK Computer', artist: 'Radiohead', config: { country: 'us' }, pageSize: 20
  })).raw);

  // 默认路径：不查 /api/info（省掉 2.6s，避免宿主超时），只发 1 次 search POST
  assert.equal(calls.info, 0, 'default path must not fetch /api/info');
  assert.equal(calls.search, 1, 'default path must issue exactly one search batch');

  // 鉴权头校验
  const h = calls.postHeaders[0];
  assert.ok(isTokenOk(h['Authorization']), `Authorization must be a valid HMAC bearer token, got: ${h['Authorization']}`);
  assert.ok(/Chrome|Safari|Firefox/.test(h['User-Agent']), 'search must use a browser UA to pass Cloudflare');
  assert.match(h['X-Session'], /^[0-9a-f]{32}$/, 'X-Session must be a 32-hex uuid');
  assert.equal(h['Referer'], 'https://covers.musichoarders.xyz/');
  assert.equal(h['Origin'], 'https://covers.musichoarders.xyz');

  // 请求体：album 主键、artist 辅助、country、默认 9 源 = 单批
  const b = calls.postBodies[0];
  assert.equal(b.album, 'OK Computer');
  assert.equal(b.artist, 'Radiohead');
  assert.equal(b.country, 'us');
  assert.ok(Array.isArray(b.sources));
  assert.equal(b.sources.length, 9, 'default batch is the 9 curated sources');
  // 默认源必须全部在服务端有效源集合里（否则会 400）
  const KNOWN = ['amazonmusic','applemusic','bandcamp','beatport','booth','bugs','deezer','discogs','fanarttv','flo','gaana','itunes','kugou','lastfm','linemusic','melon','musicbrainz','netease','ototoy','qobuz','soulseek','soundcloud','spotify','thwiki','tidal'];
  for (const s of b.sources) assert.ok(KNOWN.includes(s), `default source ${s} must be server-valid`);

  // 结果：每条都通过宿主 searchCovers 契约校验
  const checked = validateFunctionResult('searchCovers', JSON.stringify(result), plugin);
  assert.deepEqual(checked.errors, [], JSON.stringify(checked.errors));
  assert.ok(result.length >= 2, `should return covers, got ${result.length}`);
  const tidal = result.find(x => x.internal.cov_source === 'tidal');
  assert.ok(tidal, 'tidal cover present');
  assert.equal(tidal.picUrl, 'https://resources.tidal.com/images/aa/bb/original.jpg');
  assert.equal(tidal.album, 'OK Computer');
  assert.equal(tidal.artist, 'Radiohead');
  assert.equal(tidal.date, '1997-07-01');
  assert.equal(tidal.internal.cov_barcode, '634904078164');
});

test('COV batches custom sources when they exceed activeSourceLimit and dedups by picUrl', async () => {
  const { runtime: r } = await runtime();
  // 自定义 3 个有效源 + info activeSourceLimit=2 → 分 2 批
  const calls = mockHttp(r, {
    search: (batchIdx) => {
      if (batchIdx === 0) {
        return [coverLine('tidal', 'https://dup.example/a.jpg', '', { title: 'A', artist: 'B', date: '2020' })].join('\n');
      }
      return [
        coverLine('tidal', 'https://dup.example/a.jpg', '', { title: 'A', artist: 'B', date: '2020' }), // 与 batch0 重复
        coverLine('qobuz', 'https://uniq.example/b.jpg', '', { title: 'A', artist: 'B', date: '2020' })
      ].join('\n');
    }
  });
  const result = JSON.parse((await r.call('searchCovers', {
    title: 'A', artist: 'B', config: { country: 'us', sources: 'tidal,qobuz,bandcamp' }, pageSize: 20
  })).raw);
  assert.ok(calls.info >= 1, 'custom sources trigger /api/info for exact validation');
  assert.ok(calls.search >= 2, '3 sources with limit 2 must issue 2 batches');
  // 去重后只有 2 张不同图
  const urls = result.map(x => x.picUrl);
  assert.deepEqual([...new Set(urls)].length, urls.length, 'no duplicate picUrl');
  assert.ok(urls.includes('https://dup.example/a.jpg'));
  assert.ok(urls.includes('https://uniq.example/b.jpg'));
});

test('COV info is cached: custom-sources calls fetch /api/info only once', async () => {
  const { runtime: r } = await runtime();
  const calls = mockHttp(r, { search: SEARCH_BODY });
  // 自定义源会触发 /api/info；第二次应走缓存
  await r.call('searchCovers', { title: 'OK Computer', artist: 'Radiohead', config: { country: 'us', sources: 'tidal,qobuz' } });
  await r.call('searchCovers', { title: 'In Rainbows', artist: 'Radiohead', config: { country: 'us', sources: 'tidal,qobuz' } });
  assert.equal(calls.info, 1, '/api/info should be served from cache on the second call');
});

test('COV default path never fetches /api/info (avoids host timeout)', async () => {
  const { runtime: r } = await runtime();
  const calls = mockHttp(r, { search: SEARCH_BODY });
  await r.call('searchCovers', { title: 'OK Computer', artist: 'Radiohead', config: { country: 'us' } });
  await r.call('searchCovers', { title: 'In Rainbows', config: { country: 'us' } });
  assert.equal(calls.info, 0, 'default path must not hit /api/info at all');
});

test('COV falls back to US and default sources when info is unavailable', async () => {
  const { runtime: r } = await runtime();
  const calls = mockHttp(r, { search: SEARCH_BODY, infoFail: true });
  const result = JSON.parse((await r.call('searchCovers', {
    title: 'OK Computer', artist: 'Radiohead', config: { country: 'zz' }, pageSize: 5
  })).raw);
  // info 失败 → 不过滤源（用默认 18 源），按 fallback limit 9 分批；country 不在已知列表 → us
  const b = calls.postBodies[0];
  assert.equal(b.country, 'us', 'unknown country should fall back to us');
  assert.ok(b.sources.length <= 9, 'fallback batch cap is 9');
  assert.ok(result.length >= 1);
});

test('COV uses custom comma-separated sources from config', async () => {
  const { runtime: r } = await runtime();
  const calls = mockHttp(r, { search: SEARCH_BODY });
  await r.call('searchCovers', {
    title: 'X', config: { country: 'us', sources: 'tidal, qobuz' }
  });
  // 只有自定义源（且都在 info.enabled 里）
  const allSources = calls.postBodies.flatMap(b => b.sources);
  assert.deepEqual([...new Set(allSources)].sort(), ['qobuz', 'tidal']);
});

test('COV filters out sources not declared enabled in /api/info', async () => {
  const { runtime: r } = await runtime();
  const calls = mockHttp(r, { search: SEARCH_BODY });
  await r.call('searchCovers', {
    title: 'X', config: { country: 'us', sources: 'tidal,nonexistent_src' }
  });
  const allSources = calls.postBodies.flatMap(b => b.sources);
  assert.ok(!allSources.includes('nonexistent_src'), 'unknown source id should be filtered out');
  assert.ok(allSources.includes('tidal'));
});

test('COV returns [] with no HTTP when album/title/keyword is missing', async () => {
  const { runtime: r } = await runtime();
  const calls = mockHttp(r);
  const res = JSON.parse((await r.call('searchCovers', { config: {} })).raw);
  assert.deepEqual(res, []);
  assert.equal(calls.info, 0);
  assert.equal(calls.search, 0);
});

test('COV returns [] when search yields no cover lines', async () => {
  const { runtime: r } = await runtime();
  mockHttp(r, { search: '{"type":"count","releaseCount":0,"source":"tidal"}\n' });
  const res = JSON.parse((await r.call('searchCovers', { keyword: 'zzz no match' })).raw);
  assert.deepEqual(res, []);
});

test('COV returns [] when the API returns a non-200 status', async () => {
  const { runtime: r } = await runtime();
  mockHttp(r, { searchCode: 401 });
  const res = JSON.parse((await r.call('searchCovers', { title: 'X' })).raw);
  assert.deepEqual(res, []);
});

test('COV maps song-provided album/artist/date when releaseInfo is sparse', async () => {
  const { plugin, runtime: r } = await runtime();
  // releaseInfo 完全缺失 → 用 request.song 的字段兜底，宿主校验必须通过
  const sparse = coverLine('bandcamp', 'https://bc.example/x.jpg', '', {});
  mockHttp(r, { search: sparse });
  const song = { title: 'My Song', artist: 'My Artist', album: 'My Album', date: '2021-03-04' };
  const raw = (await r.call('searchCovers', { song, config: { country: 'us' } })).raw;
  const checked = validateFunctionResult('searchCovers', raw, plugin);
  assert.deepEqual(checked.errors, [], JSON.stringify(checked.errors));
  const result = JSON.parse(raw);
  assert.equal(result[0].picUrl, 'https://bc.example/x.jpg');
  assert.equal(result[0].title, 'My Song');
  assert.equal(result[0].artist, 'My Artist');
  assert.equal(result[0].album, 'My Album');
  assert.equal(result[0].date, '2021-03-04');
});

test('COV token generated by pure-JS matches node crypto (regression for HMAC correctness)', async () => {
  const { runtime: r } = await runtime();
  let seen = null;
  r.context.Platform.http.get = () => ok(INFO);
  r.context.Platform.http.post = (url, body, options) => {
    seen = options.headers['Authorization'];
    return ok(coverLine('tidal', 'https://x/y.jpg', '', { title: 't', artist: 'a', date: '2020' }));
  };
  await r.call('searchCovers', { title: 't', artist: 'a' });
  assert.ok(seen, 'Authorization header captured');
  // 断言插件的纯 JS HMAC 与 node:crypto 在当前/上一窗口完全一致
  assert.ok(isTokenOk(seen), `plugin HMAC token must match node crypto, got ${seen}`);
  assert.equal(seen.slice('Bearer '.length), expectedToken(), 'token must equal node-crypto value in current window');
});
