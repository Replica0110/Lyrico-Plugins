import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../src/plugin-loader.js';
import { createRuntime } from '../src/runtime.js';
import { validateFunctionResult } from '../src/result-parser.js';

const root = fileURLToPath(new URL('../../../lrcred/', import.meta.url));

const ok = body => ({ code: 200, body: JSON.stringify(body) });

const SEARCH_HITS = {
  hits: [
    { isrc: 'ISRC1', title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', duration: 250, year: '2001', cover: 'https://example.com/cover.jpg' },
    { isrc: 'ISRC2', title: 'Plain Text', artist: 'Artist B', album: 'Album B', duration: 180, year: '2020', cover: 'https://example.com/cover2.jpg' }
  ]
};

const STRUCTURED_DOC = {
  title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', year: '2001',
  lyrics: {
    lines: [
      { begin: 1.0, end: 3.0, text: '故事的小黄花', words: [[{ begin: 1.0, end: 1.6, text: '故事' }, { begin: 1.6, end: 3.0, text: '的小黄花' }]] },
      { begin: 3.0, end: 5.5, text: '从出生那年就飘着', words: [] }
    ]
  }
};

const TTML_DOC = {
  title: 'Plain Text', artist: 'Artist B', album: 'Album B', year: '2020',
  source: '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:00:01.000" end="00:00:03.000">line one</p></div></body></tt>'
};

async function runtime() {
  const plugin = await loadPlugin(root);
  return { plugin, runtime: await createRuntime(plugin) };
}

function mockHttp(runtime, { hits = SEARCH_HITS, songDoc } = {}) {
  const calls = { match: 0, search: 0, song: 0 };
  runtime.context.Platform.http.get = url => {
    const u = new URL(url);
    assert.equal(u.hostname, 'lrc.red');
    if (u.pathname === '/match.json') {
      calls.match++;
      return ok(hits);
    }
    if (u.pathname === '/search.json') {
      calls.search++;
      return ok(hits);
    }
    const m = u.pathname.match(/^\/s\/(.+)\.song\.json$/);
    if (m) {
      calls.song++;
      if (songDoc !== undefined) return ok(songDoc);
      return ok(STRUCTURED_DOC);
    }
    throw new Error('Unexpected GET: ' + url);
  };
  return calls;
}

test('lrc.red search uses match.json with title/artist and maps isrc/duration/date/cover', async () => {
  const { runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = JSON.parse((await r.call('searchSongs', { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', duration: 250000 })).raw);
  assert.equal(calls.match, 1);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'ISRC1');
  assert.equal(result[0].title, 'Sunny Day');
  assert.equal(result[0].artist, 'Jay Chou');
  assert.equal(result[0].album, 'Fantasy');
  assert.equal(result[0].duration, 250000);
  assert.equal(result[0].date, '2001');
  assert.equal(result[0].picUrl, 'https://example.com/cover.jpg');
  assert.equal(result[0].internal.lrcred_isrc, 'ISRC1');
});

test('lrc.red search uses search.json with q for keyword', async () => {
  const { runtime: r } = await runtime();
  const seen = [];
  r.context.Platform.http.get = url => {
    seen.push(new URL(url));
    return ok({ hits: [] });
  };
  const res = JSON.parse((await r.call('searchSongs', { keyword: 'hello world' })).raw);
  assert.equal(res.length, 0);
  assert.equal(seen[0].pathname, '/search.json');
  assert.equal(seen[0].searchParams.get('q'), 'hello world');
});

test('lrc.red getLyrics fetches song by isrc and returns structured candidate', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = await r.call('getLyrics', {
    song: { id: 'ISRC1', title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {}, internal: { lrcred_isrc: 'ISRC1' } }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(calls.song, 1);
  const candidates = JSON.parse(result.raw);
  assert.ok(Array.isArray(candidates));
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.type, 'structured');
  assert.deepEqual(c.original[0], [1000, 3000, [[1000, 1600, '故事'], [1600, 3000, '的小黄花']]]);
  // second line has empty words → falls back to whole-line text
  assert.deepEqual(c.original[1][2], [[3000, 5500, '从出生那年就飘着']]);
  assert.equal(c.tags.ti, 'Sunny Day');
  assert.equal(c.tags.ar, 'Jay Chou');
  assert.equal(c.tags.al, 'Fantasy');
  assert.equal(c.tags.date, '2001');
});

test('lrc.red getLyrics returns rawTtml candidate when doc.source contains TTML', async () => {
  const { plugin, runtime: r } = await runtime();
  mockHttp(r, { songDoc: TTML_DOC });
  const result = await r.call('getLyrics', {
    song: { id: 'ISRC2', title: 'Plain Text', artist: 'Artist B', album: 'Album B', date: '2020', fields: {}, internal: { lrcred_isrc: 'ISRC2' } }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  const candidates = JSON.parse(result.raw);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].type, 'rawTtml');
  assert.ok(candidates[0].rawTtml.includes('line one'));
});

test('lrc.red getLyrics returns empty when no doc found', async () => {
  const { plugin, runtime: r } = await runtime();
  mockHttp(r, { songDoc: null });
  const result = await r.call('getLyrics', {
    song: { title: 'Missing', artist: 'Nobody', album: 'X', date: '2020', fields: {} }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(result.raw, '[]');
});

test('lrc.red searchCovers requires cover and all metadata fields', async () => {
  const { runtime: r } = await runtime();
  const incomplete = { hits: [
    { isrc: 'A', title: 'T', artist: 'Ar', album: 'Al', year: '2020', cover: 'https://x/c.jpg', duration: 100 },
    { isrc: 'B', title: 'T2', artist: 'Ar2', album: 'Al2', year: '', cover: 'https://x/c2.jpg', duration: 100 }, // missing date
    { isrc: 'C', title: 'T3', artist: 'Ar3', album: 'Al3', year: '2021', cover: '', duration: 100 } // missing cover
  ] };
  mockHttp(r, { hits: incomplete });
  const covers = JSON.parse((await r.call('searchCovers', { keyword: 'test' })).raw);
  assert.equal(covers.length, 1);
  assert.equal(covers[0].id, 'lrcred:A');
  assert.equal(covers[0].picUrl, 'https://x/c.jpg');
  assert.equal(covers[0].date, '2020');
});
