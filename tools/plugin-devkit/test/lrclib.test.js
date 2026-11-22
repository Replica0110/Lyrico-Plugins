import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../src/plugin-loader.js';
import { createRuntime } from '../src/runtime.js';
import { validateFunctionResult } from '../src/result-parser.js';

const root = fileURLToPath(new URL('../../../lrclib/', import.meta.url));

const ok = body => ({ code: 200, body: JSON.stringify(body) });

const SEARCH = [
  { id: 101, trackName: 'Sunny Day', artistName: 'Jay Chou', albumName: 'Fantasy', duration: 250, releaseDate: '2001-09-01', hasWordSync: false, instrumental: false, syncedLyrics: '[00:01.00]故事的小黄花\n[00:03.00]从出生那年就飘着\n', plainLyrics: '故事的小黄花\n从出生那年就飘着\n' },
  { id: 102, trackName: 'Other', artistName: 'Someone', albumName: 'X', duration: 200, releaseDate: '2010-01-01', hasWordSync: false, instrumental: true, syncedLyrics: '', plainLyrics: '' }
];

const SYNCED = '[00:01.00]故事的小黄花\n[00:03.00]从出生那年就飘着\n';

async function runtime() {
  const plugin = await loadPlugin(root);
  return { plugin, runtime: await createRuntime(plugin) };
}

function mockHttp(runtime, { search = SEARCH, byId } = {}) {
  const calls = { search: 0, get: 0 };
  runtime.context.Platform.http.get = url => {
    const u = new URL(url);
    assert.equal(u.hostname, 'lrclib.net');
    if (u.pathname === '/api/search') {
      calls.search++;
      return ok(search);
    }
    const m = u.pathname.match(/^\/api\/get\/(.+)$/);
    if (m) {
      calls.get++;
      if (byId !== undefined) return ok(byId);
      const id = decodeURIComponent(m[1]);
      const item = search.find(s => String(s.id) === id);
      return ok(item || { statusCode: 404, name: 'NotFound' });
    }
    throw new Error('Unexpected GET: ' + url);
  };
  return calls;
}

test('LRCLIB search maps fields and uses track_name/artist_name params', async () => {
  const { runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = JSON.parse((await r.call('searchSongs', { title: 'Sunny Day', artist: 'Jay Chou', pageSize: 5 })).raw);
  assert.equal(calls.search, 1);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, '101');
  assert.equal(result[0].title, 'Sunny Day');
  assert.equal(result[0].artist, 'Jay Chou');
  assert.equal(result[0].album, 'Fantasy');
  assert.equal(result[0].duration, 250000);
  assert.equal(result[0].date, '2001-09-01');
  assert.equal(result[0].internal.lrclib_id, '101');
  assert.equal(result[0].internal.instrumental, '');
  assert.equal(result[1].internal.instrumental, '1');
});

test('LRCLIB search uses q param for keyword and returns [] for empty results', async () => {
  const { runtime: r } = await runtime();
  const seen = [];
  r.context.Platform.http.get = url => {
    seen.push(new URL(url));
    return ok([]);
  };
  const res = JSON.parse((await r.call('searchSongs', { keyword: 'sunny jay' })).raw);
  assert.equal(res.length, 0);
  assert.equal(seen[0].searchParams.get('q'), 'sunny jay');
  assert.equal(seen[0].searchParams.get('track_name'), null);
});

test('LRCLIB search skips results with an empty id without crashing (regression)', async () => {
  const { runtime: r } = await runtime();
  // 一条 id 为空 —— 旧代码 map 引用未定义的 song.title 会抛 ReferenceError。
  // lrclib 在 map 前已跳过空 id，此测确保该行为稳定（不崩 + 有效结果保留）。
  mockHttp(r, {
    search: [
      { id: 101, trackName: 'Sunny Day', artistName: 'Jay Chou', albumName: 'Fantasy', duration: 250, releaseDate: '2001-09-01', hasWordSync: false, instrumental: false, syncedLyrics: '[00:01.00]a\n', plainLyrics: 'a' },
      { id: '', trackName: 'Broken', artistName: 'X', albumName: 'Y', duration: 100, releaseDate: '', hasWordSync: false, instrumental: false, syncedLyrics: '', plainLyrics: '' },
      { id: 103, trackName: 'Other', artistName: 'Someone', albumName: 'Z', duration: 200, releaseDate: '2010-01-01', hasWordSync: false, instrumental: false, syncedLyrics: '', plainLyrics: 'b' }
    ]
  });
  const result = JSON.parse((await r.call('searchSongs', { title: 'Sunny Day', artist: 'Jay Chou', pageSize: 5 })).raw);
  assert.ok(Array.isArray(result), 'search must not throw; must return an array');
  assert.equal(result.length, 2, 'valid results with a real id should survive');
  assert.equal(result[0].internal.lrclib_id, '101');
  assert.equal(result[1].internal.lrclib_id, '103');
});

test('LRCLIB getLyrics fetches by internal.lrclib_id and returns rawPlainLrc candidate', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = await r.call('getLyrics', {
    song: { id: '101', title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001-09-01', fields: {}, internal: { lrclib_id: '101' } }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(calls.get, 1);
  assert.equal(calls.search, 0);
  const candidates = JSON.parse(result.raw);
  assert.ok(Array.isArray(candidates));
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.type, 'rawPlainLrc');
  assert.ok(c.rawPlainLrc.includes('[00:01.00]故事的小黄花'));
  assert.ok(c.rawPlainLrc.includes('[00:03.00]从出生那年就飘着'));
  assert.equal(c.tags.ti, 'Sunny Day');
  assert.equal(c.tags.ar, 'Jay Chou');
  assert.equal(c.tags.al, 'Fantasy');
  assert.equal(c.tags.date, '2001-09-01');
});

test('LRCLIB getLyrics searches then fetches best candidate when no id present', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001-09-01', fields: {} }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.ok(calls.search >= 1);
  assert.ok(calls.get >= 1);
  const candidates = JSON.parse(result.raw);
  assert.ok(candidates.length >= 1);
});

test('LRCLIB getLyrics skips instrumental tracks', async () => {
  const { plugin, runtime: r } = await runtime();
  mockHttp(r, { search: [SEARCH[1]], byId: SEARCH[1] });
  const result = await r.call('getLyrics', {
    song: { title: 'Other', artist: 'Someone', album: 'X', date: '2010-01-01', fields: {}, internal: { lrclib_id: '102' } }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(result.raw, '[]');
});

test('LRCLIB getLyrics falls back to plainLyrics and returns empty when none available', async () => {
  const { plugin, runtime: r } = await runtime();
  const plain = { id: 202, trackName: 'Plain', artistName: 'A', albumName: 'B', duration: 100, releaseDate: '2020-01-01', syncedLyrics: '', plainLyrics: 'just words\nno timing\n' };
  const empty = { id: 203, trackName: 'Empty', artistName: 'A', albumName: 'B', releaseDate: '2020-01-01', syncedLyrics: '', plainLyrics: '' };
  mockHttp(r, { byId: plain });
  const res1 = await r.call('getLyrics', {
    song: { title: 'Plain', artist: 'A', album: 'B', date: '2020-01-01', fields: {}, internal: { lrclib_id: '202' } }
  });
  const checked1 = validateFunctionResult('getLyrics', res1.raw, plugin);
  assert.deepEqual(checked1.errors, []);
  const cands1 = JSON.parse(res1.raw);
  assert.equal(cands1.length, 1);
  assert.equal(cands1[0].type, 'rawPlainLrc');
  assert.ok(cands1[0].rawPlainLrc.includes('just words'));

  mockHttp(r, { byId: empty });
  const res2 = await r.call('getLyrics', {
    song: { title: 'Empty', artist: 'A', album: 'B', date: '2020-01-01', fields: {}, internal: { lrclib_id: '203' } }
  });
  const checked2 = validateFunctionResult('getLyrics', res2.raw, plugin);
  assert.deepEqual(checked2.errors, []);
  assert.equal(res2.raw, '[]');
});
