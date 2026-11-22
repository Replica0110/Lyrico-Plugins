import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../src/plugin-loader.js';
import { createRuntime } from '../src/runtime.js';
import { validateFunctionResult } from '../src/result-parser.js';

const root = fileURLToPath(new URL('../../../streetvoice/', import.meta.url));

const SEARCH_RESULTS = {
  count: 2,
  offset: 0,
  limit: 20,
  next: null,
  previous: null,
  results: [
    {
      type: 'song',
      id: 373284,
      name: 'Hello Hello ',
      image: 'https://akstatic.streetvoice.com/song_covers/ho/ll/hollyloutaiwan/abc.JPG?x-oss-process=image/resize,m_fill,h_200,w_200',
      length: 187,
      lyrics_is_lrc: false,
      publish_at: '2016-08-02T10:40:27+0800',
      created_at: '2016-08-02T10:40:27+0800',
      user: { type: 'user', id: 922122, username: 'hollyloutaiwan' }
    },
    {
      type: 'song',
      id: 792461,
      name: 'JAY CHOU 周杰倫',
      image: 'https://akstatic.streetvoice.com/song_covers/si/mon/simon/def.JPG?x-oss-process=image/resize,m_fill,h_200,w_200',
      length: 200,
      lyrics_is_lrc: true,
      publish_at: '2021-06-12T10:00:00+0800',
      created_at: '2021-06-12T10:00:00+0800',
      user: { type: 'user', id: 123, username: 'simonfromlantown' }
    }
  ]
};

const PLAIN_LYRICS = '【Hello Hello】\n離開了 熟悉的\n沒有了 安全感\n';
const LRC_LYRICS = '[00:04.78]we like\n[00:07.38]we like\n[00:10.45]my vibe my style\n';

function detailFor(id) {
  const item = SEARCH_RESULTS.results.find(r => r.id === id);
  if (!item) return JSON.stringify({ error: { message: '未找到資料' } });
  return JSON.stringify({ ...item, lyrics: id === 792461 ? LRC_LYRICS : PLAIN_LYRICS });
}

async function runtime() {
  const plugin = await loadPlugin(root);
  return { plugin, runtime: await createRuntime(plugin) };
}

test('StreetVoice search maps fields and strips OSS resize params from cover URL', async () => {
  const { runtime: r } = await runtime();
  r.context.Platform.http.getText = url => {
    const u = new URL(url);
    assert.equal(u.hostname, 'streetvoice.com');
    assert.ok(u.pathname.endsWith('/api/v4/search/'), 'search path must end with trailing slash: ' + u.pathname);
    return JSON.stringify(SEARCH_RESULTS);
  };
  const result = JSON.parse((await r.call('searchSongs', { keyword: 'hello', page: 1, pageSize: 20 })).raw);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, '373284');
  assert.equal(result[0].title, 'Hello Hello ');
  assert.equal(result[0].artist, 'hollyloutaiwan');
  assert.equal(result[0].duration, 187000);
  assert.equal(result[0].date, '2016-08-02');
  // cover must be full-size (no ?x-oss-process query)
  assert.equal(result[0].picUrl, 'https://akstatic.streetvoice.com/song_covers/ho/ll/hollyloutaiwan/abc.JPG');
  assert.ok(!result[0].picUrl.includes('?'));
  assert.deepEqual(result[0].internal, { songId: 373284, lrcFlag: false });
  assert.deepEqual(result[1].internal, { songId: 792461, lrcFlag: true });
});

test('StreetVoice song detail URL uses trailing slash', async () => {
  const { runtime: r } = await runtime();
  r.context.Platform.http.getText = url => {
    const u = new URL(url);
    assert.equal(u.hostname, 'streetvoice.com');
    if (u.pathname.startsWith('/api/v4/song/')) {
      assert.ok(u.pathname.endsWith('/'), 'song path must end with trailing slash: ' + u.pathname);
      const id = Number(u.pathname.split('/').filter(Boolean).pop());
      return detailFor(id);
    }
    return JSON.stringify(SEARCH_RESULTS);
  };
  const result = await r.call('getLyrics', {
    song: { id: '373284', title: 'Hello Hello ', artist: 'hollyloutaiwan', album: 'Single', date: '2016-08-02', internal: { songId: 373284 } }
  });
  // song has internal.songId → uses it directly, must hit detail endpoint and return a candidate
  const candidates = JSON.parse(result.raw);
  assert.ok(Array.isArray(candidates));
  assert.ok(candidates.length >= 1);
});

test('StreetVoice getLyrics returns an array of candidates for plain-text lyrics', async () => {
  const { plugin, runtime: r } = await runtime();
  r.context.Platform.http.getText = url => {
    const u = new URL(url);
    if (u.pathname.startsWith('/api/v4/song/')) return detailFor(373284);
    return JSON.stringify(SEARCH_RESULTS);
  };
  const result = await r.call('getLyrics', {
    song: { title: 'Hello Hello ', artist: 'hollyloutaiwan', album: 'Single', date: '2016-08-02', fields: {} }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  const candidates = JSON.parse(result.raw);
  assert.ok(Array.isArray(candidates), 'getLyrics must return an array');
  assert.ok(candidates.length >= 1);
  const c = candidates[0];
  assert.equal(c.tags.ar, 'hollyloutaiwan');
  assert.equal(c.type, 'rawPlainLrc');
  assert.ok(c.rawPlainLrc.includes('離開了'));
  // host trims the title tag
  assert.equal(c.tags.ti, 'Hello Hello');
});

test('StreetVoice getLyrics parses LRC (line-level) into rawPlainLrc preserving timing', async () => {
  const { plugin, runtime: r } = await runtime();
  r.context.Platform.http.getText = url => {
    const u = new URL(url);
    if (u.pathname.startsWith('/api/v4/song/')) return detailFor(792461);
    return JSON.stringify({ count: 1, results: [SEARCH_RESULTS.results[1]] });
  };
  const result = await r.call('getLyrics', {
    song: { title: 'JAY CHOU', artist: 'simonfromlantown', album: 'Demo', date: '2021-06-12', fields: {} }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  const candidates = JSON.parse(result.raw);
  assert.ok(candidates.length >= 1);
  const c = candidates[0];
  // line-level LRC without word tags → rawPlainLrc (timing preserved in the raw LRC string)
  assert.equal(c.type, 'rawPlainLrc');
  assert.ok(c.rawPlainLrc.includes('[00:04.78]we like'));
  assert.ok(c.rawPlainLrc.includes('[00:07.38]we like'));
  assert.ok(c.rawPlainLrc.includes('[00:10.45]my vibe my style'));
});

test('StreetVoice getLyrics returns empty array when detail has no lyrics', async () => {
  const { plugin, runtime: r } = await runtime();
  r.context.Platform.http.getText = () => JSON.stringify({ ...SEARCH_RESULTS.results[0], lyrics: '' });
  const result = await r.call('getLyrics', {
    song: { title: 'Hello Hello ', artist: 'hollyloutaiwan', album: 'Single', date: '2016-08-02', fields: {} }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(result.raw, '[]');
});

test('StreetVoice searchCovers only returns songs with a cover URL', async () => {
  const { runtime: r } = await runtime();
  r.context.Platform.http.getText = () => JSON.stringify({
    count: 2, results: [
      SEARCH_RESULTS.results[0],
      { ...SEARCH_RESULTS.results[0], id: 999, image: '' } // no cover
    ]
  });
  const covers = JSON.parse((await r.call('searchCovers', { keyword: 'hello' })).raw);
  assert.equal(covers.length, 1);
  assert.equal(covers[0].id, '373284');
});

const COVER_IMG = SEARCH_RESULTS.results[0].image;
const COVER_BASE = COVER_IMG.split('?')[0];

test('StreetVoice cover_size default (original) strips all OSS params', async () => {
  const { runtime: r } = await runtime();
  r.context.Platform.http.getText = () => JSON.stringify(SEARCH_RESULTS);
  const result = JSON.parse((await r.call('searchSongs', { keyword: 'hello' })).raw);
  assert.equal(result[0].picUrl, COVER_BASE, 'default config.cover_size must return original with no query string');
  assert.ok(!result[0].picUrl.includes('?'));
});

test('StreetVoice cover_size=sv keeps StreetVoice default 200x200 crop', async () => {
  const { runtime: r } = await runtime();
  r.context.Platform.http.getText = () => JSON.stringify(SEARCH_RESULTS);
  const result = JSON.parse((await r.call('searchSongs', { keyword: 'hello', config: { cover_size: 'sv' } })).raw);
  assert.equal(result[0].picUrl, COVER_BASE + '?x-oss-process=image/resize,m_fill,h_200,w_200,limit_0/interlace,1/quality,q_95/format,jpg');
});

test('StreetVoice cover_size=500 produces a 500x500 square crop URL', async () => {
  const { runtime: r } = await runtime();
  r.context.Platform.http.getText = () => JSON.stringify(SEARCH_RESULTS);
  const result = JSON.parse((await r.call('searchSongs', { keyword: 'hello', config: { cover_size: '500' } })).raw);
  assert.equal(result[0].picUrl, COVER_BASE + '?x-oss-process=image/resize,m_fill,h_500,w_500');
});

test('StreetVoice cover_size=1000 produces a 1000x1000 square crop URL', async () => {
  const { runtime: r } = await runtime();
  r.context.Platform.http.getText = () => JSON.stringify(SEARCH_RESULTS);
  const result = JSON.parse((await r.call('searchSongs', { keyword: 'hello', config: { cover_size: '1000' } })).raw);
  assert.equal(result[0].picUrl, COVER_BASE + '?x-oss-process=image/resize,m_fill,h_1000,w_1000');
});

test('StreetVoice cover_size invalid value falls back to original', async () => {
  const { runtime: r } = await runtime();
  r.context.Platform.http.getText = () => JSON.stringify(SEARCH_RESULTS);
  const result = JSON.parse((await r.call('searchSongs', { keyword: 'hello', config: { cover_size: 'bogus' } })).raw);
  assert.equal(result[0].picUrl, COVER_BASE);
});
