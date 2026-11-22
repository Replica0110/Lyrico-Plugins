import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../src/plugin-loader.js';
import { createRuntime } from '../src/runtime.js';
import { validateFunctionResult } from '../src/result-parser.js';

const root = fileURLToPath(new URL('../../../simpmusic/', import.meta.url));

const ok = body => ({ code: 200, body: JSON.stringify(body) });

const SEARCH = {
  data: [
    { videoId: 'vid1', songTitle: 'Sunny Day', artistName: 'Jay Chou', albumName: 'Fantasy', durationSeconds: 250 },
    { videoId: 'vid2', songTitle: 'Other', artistName: 'Someone', albumName: 'X', durationSeconds: 200 }
  ]
};

const ENTRIES = {
  success: true,
  data: [
    {
      videoId: 'vid1',
      // SimpMusic richSync is served as LRC with word-level <mm:ss.cc> tags;
      // fromText with wordTags:true parses them into structured word lines.
      richSyncLyrics: '[00:01.00]<00:01.000>你好<00:02.000>世界\n[00:03.00]<00:03.000>下一句\n',
      syncedLyrics: '[00:01.00]你好世界\n',
      plainLyric: '你好世界',
      vote: 5
    }
  ]
};

const LRC_ONLY_ENTRIES = {
  success: true,
  data: [{ videoId: 'vid2', richSyncLyrics: '', syncedLyrics: '[00:01.00]line one\n[00:03.00]line two\n', plainLyric: '', vote: 3 }]
};

async function runtime() {
  const plugin = await loadPlugin(root);
  return { plugin, runtime: await createRuntime(plugin) };
}

function mockHttp(runtime, { search = SEARCH, entries = ENTRIES } = {}) {
  const calls = { search: 0, entries: 0 };
  runtime.context.Platform.http.get = url => {
    const u = new URL(url);
    assert.equal(u.hostname, 'api-lyrics.simpmusic.org');
    if (u.pathname.endsWith('/search')) {
      calls.search++;
      return ok(search);
    }
    const m = u.pathname.match(/\/v1\/([^/?]+)$/);
    if (m) {
      calls.entries++;
      return ok(entries);
    }
    throw new Error('Unexpected GET: ' + url);
  };
  return calls;
}

test('SimpMusic search maps videoId/songTitle and converts duration to ms', async () => {
  const { runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = JSON.parse((await r.call('searchSongs', { title: 'Sunny Day', artist: 'Jay Chou', pageSize: 5 })).raw);
  assert.equal(calls.search, 1);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'vid1');
  assert.equal(result[0].title, 'Sunny Day');
  assert.equal(result[0].artist, 'Jay Chou');
  assert.equal(result[0].album, 'Fantasy');
  assert.equal(result[0].duration, 250000);
  assert.equal(result[0].internal.simpmusic_video_id, 'vid1');
});

test('SimpMusic search builds q from title+artist and returns [] for empty data', async () => {
  const { runtime: r } = await runtime();
  const seen = [];
  r.context.Platform.http.get = url => {
    seen.push(new URL(url));
    return ok({ data: [] });
  };
  const res = JSON.parse((await r.call('searchSongs', { title: 'Hello', artist: 'World' })).raw);
  assert.equal(res.length, 0);
  assert.equal(seen[0].searchParams.get('q'), 'Hello World');
  assert.equal(seen[0].searchParams.get('limit'), '10');
});

test('SimpMusic getLyrics uses internal videoId directly and returns structured word candidate', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = await r.call('getLyrics', {
    song: { id: 'vid1', title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {}, internal: { simpmusic_video_id: 'vid1' } }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(calls.entries, 1);
  assert.equal(calls.search, 0);
  const candidates = JSON.parse(result.raw);
  assert.ok(Array.isArray(candidates));
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.type, 'structured');
  // richSync word-level timing: ts=1.0 → 1000ms, offsets 0 and 1.0s
  assert.deepEqual(c.original[0], [1000, 3000, [[1000, 2000, '你好'], [2000, 3000, '世界']]]);
  assert.equal(c.tags.ti, 'Sunny Day');
  assert.equal(c.tags.ar, 'Jay Chou');
});

test('SimpMusic getLyrics prefers richSync over syncedLyrics and parses synced-only as rawPlainLrc', async () => {
  const { plugin, runtime: r } = await runtime();
  mockHttp(r, { entries: LRC_ONLY_ENTRIES });
  const result = await r.call('getLyrics', {
    song: { id: 'vid2', title: 'Other', artist: 'Someone', album: 'X', date: '2020', fields: {}, internal: { simpmusic_video_id: 'vid2' } }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  const candidates = JSON.parse(result.raw);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].type, 'rawPlainLrc');
  assert.ok(candidates[0].rawPlainLrc.includes('[00:01.00]line one'));
});

test('SimpMusic getLyrics searches then picks the best match when no internal id present', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {} }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.ok(calls.search >= 1);
  assert.ok(calls.entries >= 1);
  const candidates = JSON.parse(result.raw);
  assert.ok(candidates.length >= 1);
});

test('SimpMusic getLyrics returns empty array when fetch fails (success=false)', async () => {
  const { plugin, runtime: r } = await runtime();
  mockHttp(r, { entries: { success: false, data: [] } });
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {}, internal: { simpmusic_video_id: 'vid1' } }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(result.raw, '[]');
});
