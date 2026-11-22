import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../src/plugin-loader.js';
import { createRuntime } from '../src/runtime.js';
import { validateFunctionResult } from '../src/result-parser.js';

const root = fileURLToPath(new URL('../../../unison/', import.meta.url));

const ok = body => ({ code: 200, body: JSON.stringify(body) });

const SEARCH = {
  data: [
    { videoId: 'abc123', id: 1, song: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', duration: 250 },
    { videoId: 'def456', id: 2, song: 'Other', artist: 'Someone', album: 'X', duration: 200 }
  ]
};

const LYRICS_RESP = {
  success: true,
  data: {
    song: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy',
    lyrics: '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
      '<p begin="00:00:01.000" end="00:00:03.000">故事的小黄花</p>' +
      '<p begin="00:00:03.000" end="00:00:05.000">从出生那年就飘着</p>' +
      '</div></body></tt>'
  }
};

async function runtime() {
  const plugin = await loadPlugin(root);
  return { plugin, runtime: await createRuntime(plugin) };
}

function mockHttp(runtime, { search = SEARCH, video = LYRICS_RESP, direct } = {}) {
  const calls = { search: 0, video: 0, direct: 0 };
  runtime.context.Platform.http.get = url => {
    const u = new URL(url);
    assert.equal(u.hostname, 'unison.betterlyrics.org');
    if (u.pathname === '/lyrics/search') {
      calls.search++;
      return ok(search);
    }
    if (u.pathname === '/lyrics') {
      if (u.searchParams.get('v')) {
        calls.video++;
        return ok(video);
      }
      calls.direct++;
      return ok(direct !== undefined ? direct : video);
    }
    throw new Error('Unexpected GET: ' + url);
  };
  return calls;
}

test('Unison search maps song/artist/album/duration and sends q/limit', async () => {
  const { runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = JSON.parse((await r.call('searchSongs', { title: 'Sunny Day', artist: 'Jay Chou', pageSize: 5 })).raw);
  assert.equal(calls.search, 1);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'abc123');
  assert.equal(result[0].title, 'Sunny Day');
  assert.equal(result[0].artist, 'Jay Chou');
  assert.equal(result[0].album, 'Fantasy');
  assert.equal(result[0].duration, 250000);
  assert.equal(result[0].internal.unison_video_id, 'abc123');
  assert.equal(result[0].internal.unison_id, '1');
});

test('Unison search returns [] when data is missing or empty', async () => {
  const { runtime: r } = await runtime();
  r.context.Platform.http.get = () => ok({ data: null });
  const res = JSON.parse((await r.call('searchSongs', { keyword: 'x' })).raw);
  assert.equal(res.length, 0);
});

test('Unison search does not crash when a result has an empty videoId (regression)', async () => {
  const { runtime: r } = await runtime();
  // 中间一条 videoId 为空字符串 —— 旧代码引用未定义的 song.title 会抛 ReferenceError，
  // 被 try/catch 吞掉导致整次搜索返回 []。修复后不再崩溃，有效结果保留。
  mockHttp(r, {
    search: {
      data: [
        { videoId: 'abc123', id: 1, song: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', duration: 250 },
        { videoId: '', id: 2, song: 'Broken', artist: 'X', album: 'Y', duration: 200 },
        { videoId: 'def456', id: 3, song: 'Other', artist: 'Someone', album: 'Z', duration: 180 }
      ]
    }
  });
  const result = JSON.parse((await r.call('searchSongs', { title: 'Sunny Day', artist: 'Jay Chou', pageSize: 5 })).raw);
  assert.ok(Array.isArray(result), 'search must not throw; must return an array');
  assert.ok(result.length >= 1, 'pre-fix bug collapsed the whole search to []; valid results must survive');
  // the two results with real videoIds map through cleanly
  const ids = result.map(s => s.internal.unison_video_id);
  assert.ok(ids.includes('abc123'));
  assert.ok(ids.includes('def456'));
});

test('Unison getLyrics fetches /lyrics?v= by internal videoId and returns rawTtml candidate', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = await r.call('getLyrics', {
    song: { id: 'abc123', title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {}, internal: { unison_video_id: 'abc123' } }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(calls.video, 1);
  assert.equal(calls.search, 0);
  const candidates = JSON.parse(result.raw);
  assert.ok(Array.isArray(candidates));
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.type, 'rawTtml');
  assert.ok(c.rawTtml.includes('故事的小黄花'));
  assert.equal(c.tags.ti, 'Sunny Day');
  assert.equal(c.tags.ar, 'Jay Chou');
  assert.equal(c.tags.al, 'Fantasy');
  assert.equal(c.tags.date, '2001');
});

test('Unison getLyrics searches, then fetches by videoId when no internal id present', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {} }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.ok(calls.search >= 1);
  assert.ok(calls.video >= 1);
  const candidates = JSON.parse(result.raw);
  assert.ok(candidates.length >= 1);
  assert.equal(candidates[0].type, 'rawTtml');
});

test('Unison getLyrics falls back to direct /lyrics?song= when videoId fetch returns no lyrics', async () => {
  const { plugin, runtime: r } = await runtime();
  // search result has a videoId but the /lyrics?v= fetch fails → falls back to direct
  const calls = mockHttp(r, { video: { success: false, data: null }, direct: LYRICS_RESP });
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {} }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.ok(calls.search >= 1);
  assert.ok(calls.video >= 1);
  assert.ok(calls.direct >= 1);
  const candidates = JSON.parse(result.raw);
  assert.ok(candidates.length >= 1);
});

test('Unison getLyrics returns empty array when response has no lyrics', async () => {
  const { plugin, runtime: r } = await runtime();
  mockHttp(r, { video: { success: true, data: { lyrics: '' } } });
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {}, internal: { unison_video_id: 'abc123' } }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(result.raw, '[]');
});
