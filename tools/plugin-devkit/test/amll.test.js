import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../src/plugin-loader.js';
import { createRuntime } from '../src/runtime.js';
import { validateFunctionResult } from '../src/result-parser.js';

const root = fileURLToPath(new URL('../../../amll/', import.meta.url));

const ok = body => ({ code: 200, body: JSON.stringify(body) });

const SEARCH_ITEMS = {
  data: {
    items: [
      { id: 101, musicNames: ['Sunny Day'], artistNames: ['Jay Chou'], albumNames: ['Fantasy'], isrcs: ['AAA'] },
      { id: 102, musicNames: ['Sunny Day', '晴天'], artistNames: ['周杰伦'], albumNames: ['叶惠美'], isrcs: ['BBB'] }
    ]
  }
};

const TTML = '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
  '<p begin="00:00:01.000" end="00:00:03.000">故事的小黄花</p>' +
  '<p begin="00:00:03.000" end="00:00:05.000">从出生那年就飘着</p>' +
  '</div></body></tt>';

function mockGet(runtime, { search = SEARCH_ITEMS, byId } = {}) {
  const calls = { search: 0, get: 0 };
  runtime.context.Platform.http.get = url => {
    const u = new URL(url);
    assert.equal(u.hostname, 'api.amll.dev');
    if (u.pathname === '/v1/lyrics/search') {
      calls.search++;
      return ok(search);
    }
    if (u.pathname === '/v1/lyrics/get') {
      calls.get++;
      const id = u.searchParams.get('id');
      if (byId !== undefined) return ok(byId);
      return ok({ data: { id: Number(id), lyrics: TTML, musicNames: ['Sunny Day'], artistNames: ['Jay Chou'], albumNames: ['Fantasy'] } });
    }
    throw new Error('Unexpected GET: ' + url);
  };
  return calls;
}

async function runtime() {
  const plugin = await loadPlugin(root);
  return { plugin, runtime: await createRuntime(plugin) };
}

test('AMLL search maps musicNames/artistNames/albumNames arrays and limits pageSize', async () => {
  const { runtime: r } = await runtime();
  const calls = mockGet(r);
  const result = JSON.parse((await r.call('searchSongs', { title: 'Sunny Day', artist: 'Jay Chou', pageSize: 1 })).raw);
  assert.equal(calls.search, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, '101');
  assert.equal(result[0].title, 'Sunny Day');
  assert.equal(result[0].artist, 'Jay Chou');
  assert.equal(result[0].album, 'Fantasy');
  assert.equal(result[0].internal.amll_id, '101');
  assert.equal(result[0].internal.isrc, 'AAA');

  // second result joins multiple names with " / "
  const all = JSON.parse((await r.call('searchSongs', { title: 'Sunny Day', pageSize: 5 })).raw);
  assert.equal(all[1].title, 'Sunny Day / 晴天');
  assert.equal(all[1].artist, '周杰伦');
});

test('AMLL search sends musicName/artistName for title requests and musicName for keyword', async () => {
  const { runtime: r } = await runtime();
  const seen = [];
  r.context.Platform.http.get = url => {
    seen.push(new URL(url));
    return ok(SEARCH_ITEMS);
  };
  await r.call('searchSongs', { title: 'Hello', artist: 'World' });
  assert.equal(seen[0].searchParams.get('musicName'), 'Hello');
  assert.equal(seen[0].searchParams.get('artistName'), 'World');
  seen.length = 0;
  await r.call('searchSongs', { keyword: 'Hello World' });
  assert.equal(seen[0].searchParams.get('musicName'), 'Hello World');
});

test('AMLL search does not crash when a result has an empty id (regression)', async () => {
  const { runtime: r } = await runtime();
  // 中间一条 id 为空 —— 旧代码 map 引用未定义的 song.title 抛 ReferenceError，
  // 被 try/catch 吞掉导致整次搜索返回 []。修复后空 id 结果被过滤，有效结果保留。
  mockGet(r, {
    search: {
      data: {
        items: [
          { id: 101, musicNames: ['Sunny Day'], artistNames: ['Jay Chou'], albumNames: ['Fantasy'], isrcs: ['AAA'] },
          { id: '', musicNames: ['Broken'], artistNames: ['X'], albumNames: ['Y'], isrcs: [] },
          { id: 103, musicNames: ['Other'], artistNames: ['Someone'], albumNames: ['Z'], isrcs: ['CCC'] }
        ]
      }
    }
  });
  const result = JSON.parse((await r.call('searchSongs', { title: 'Sunny Day', artist: 'Jay Chou', pageSize: 5 })).raw);
  assert.ok(Array.isArray(result), 'search must not throw; must return an array');
  assert.equal(result.length, 2, 'valid results with a real id should survive');
  assert.equal(result[0].internal.amll_id, '101');
  assert.equal(result[1].internal.amll_id, '103');
});

test('AMLL getLyrics fetches by internal.amll_id and returns a rawTtml candidate', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockGet(r);
  const result = await r.call('getLyrics', {
    song: { id: '101', title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {}, internal: { amll_id: '101' } }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(calls.get, 1);
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

test('AMLL getLyrics searches then fetches best candidate when no id is present', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockGet(r);
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {} }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.ok(calls.search >= 1);
  assert.ok(calls.get >= 1);
  const candidates = JSON.parse(result.raw);
  assert.ok(candidates.length >= 1);
  assert.equal(candidates[0].type, 'rawTtml');
});

test('AMLL getLyrics returns empty array when track has no lyrics', async () => {
  const { plugin, runtime: r } = await runtime();
  mockGet(r, { byId: { data: { id: 101, lyrics: '' } } });
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {}, internal: { amll_id: '101' } }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(result.raw, '[]');
});

test('AMLL getLyrics returns empty array when search yields nothing', async () => {
  const { plugin, runtime: r } = await runtime();
  mockGet(r, { search: { data: { items: [] } } });
  const result = await r.call('getLyrics', {
    song: { title: 'Unknown', artist: 'Nobody', album: 'X', date: '2020', fields: {} }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(result.raw, '[]');
});
