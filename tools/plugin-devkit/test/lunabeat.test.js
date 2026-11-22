import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../src/plugin-loader.js';
import { createRuntime } from '../src/runtime.js';
import { validateFunctionResult } from '../src/result-parser.js';

const root = fileURLToPath(new URL('../../../lunabeat/', import.meta.url));

const bytesResp = text => ({ code: 200, bodyBase64: Buffer.from(text, 'utf8').toString('base64') });

const INDEX = {
  revision: 'r1',
  songs: [
    { id: 'lb1', title: 'Sunny Day', artists: ['Jay Chou'], album: 'Fantasy', path: 'songs/lb1.ttml' },
    { id: 'lb2', title: '晴天', artists: ['周杰伦'], album: '叶惠美', path: 'songs/lb2.ttml' }
  ]
};

const TTML = '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
  '<p begin="00:00:01.000" end="00:00:03.000">故事的小黄花</p>' +
  '<p begin="00:00:03.000" end="00:00:05.000">从出生那年就飘着</p>' +
  '</div></body></tt>';

async function runtime() {
  const plugin = await loadPlugin(root);
  return { plugin, runtime: await createRuntime(plugin) };
}

function mockHttp(runtime, { index = INDEX, ttml = TTML } = {}) {
  const calls = { index: 0, ttml: 0 };
  runtime.context.Platform.http.getBytes = url => {
    const u = new URL(url);
    assert.equal(u.hostname, '2755337087.github.io');
    if (u.pathname.endsWith('api/v1/songs.json')) {
      calls.index++;
      return bytesResp(JSON.stringify(index));
    }
    calls.ttml++;
    return bytesResp(ttml);
  };
  return calls;
}

test('LunaBeat loads the remote index, scores by title, and maps joined artists', async () => {
  const { runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = JSON.parse((await r.call('searchSongs', { title: 'Sunny Day', artist: 'Jay Chou', pageSize: 5 })).raw);
  assert.equal(calls.index, 1);
  assert.ok(result.length >= 1);
  // Sunny Day matches best (exact title + artist)
  assert.equal(result[0].id, 'lb1');
  assert.equal(result[0].title, 'Sunny Day');
  assert.equal(result[0].artist, 'Jay Chou');
  assert.equal(result[0].album, 'Fantasy');
  assert.equal(result[0].internal.lunabeat_id, 'lb1');
  assert.equal(result[0].internal.lunabeat_path, 'songs/lb1.ttml');
});

test('LunaBeat search ranks Chinese-script matches and returns [] for non-matching query', async () => {
  const { runtime: r } = await runtime();
  mockHttp(r);
  const hit = JSON.parse((await r.call('searchSongs', { title: '晴天', artist: '周杰伦' })).raw);
  assert.ok(hit.length >= 1);
  assert.equal(hit[0].id, 'lb2');

  const none = JSON.parse((await r.call('searchSongs', { keyword: 'nonexistent zzxxcc' })).raw);
  assert.equal(none.length, 0);
});

test('LunaBeat search does not crash when the index contains a song with an empty id (regression)', async () => {
  const { runtime: r } = await runtime();
  // 索引里一条 id 为空但 title 匹配的条目 —— 旧代码 map 引用未定义的 song.title
  // 会抛 ReferenceError，被 try/catch 吞掉导致整次搜索返回 []。
  mockHttp(r, {
    index: {
      revision: 'r1',
      songs: [
        { id: 'lb1', title: 'Sunny Day', artists: ['Jay Chou'], album: 'Fantasy', path: 'songs/lb1.ttml' },
        { id: '', title: 'Sunny Day', artists: ['Jay Chou'], album: 'Fantasy', path: '' }
      ]
    }
  });
  const result = JSON.parse((await r.call('searchSongs', { title: 'Sunny Day', artist: 'Jay Chou', pageSize: 5 })).raw);
  assert.ok(Array.isArray(result), 'search must not throw; must return an array');
  assert.ok(result.length >= 1, 'at least the valid indexed song should be returned');
  assert.equal(result[0].internal.lunabeat_id, 'lb1');
});

test('LunaBeat getLyrics fetches TTML by internal path and returns rawTtml candidate', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = await r.call('getLyrics', {
    song: { id: 'lb1', title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {}, internal: { lunabeat_id: 'lb1', lunabeat_path: 'songs/lb1.ttml' } }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(calls.ttml, 1);
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

test('LunaBeat getLyrics resolves path from index when song lacks internal path', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = await r.call('getLyrics', {
    song: { title: '晴天', artist: '周杰伦', album: '叶惠美', date: '2003', fields: {} }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  // index loaded once, search + find + ttml fetch
  assert.ok(calls.index >= 1);
  assert.ok(calls.ttml >= 1);
  const candidates = JSON.parse(result.raw);
  assert.ok(candidates.length >= 1);
  assert.equal(candidates[0].type, 'rawTtml');
});

test('LunaBeat getLyrics returns empty array when index is empty', async () => {
  const { plugin, runtime: r } = await runtime();
  mockHttp(r, { index: { revision: 'r2', songs: [] } });
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {} }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(result.raw, '[]');
});

test('LunaBeat getLyrics returns empty when TTML fetch yields empty', async () => {
  const { plugin, runtime: r } = await runtime();
  mockHttp(r, { ttml: '' });
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {}, internal: { lunabeat_id: 'lb1', lunabeat_path: 'songs/lb1.ttml' } }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(result.raw, '[]');
});
