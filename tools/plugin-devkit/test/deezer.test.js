import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../src/plugin-loader.js';
import { createRuntime } from '../src/runtime.js';
import { validateFunctionResult } from '../src/result-parser.js';

const root = fileURLToPath(new URL('../../../deezer/', import.meta.url));

// 真实 JWT 很长；fetchJwt 要求 length > 10，mock 必须满足
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoxfQ.fakesignature-very-long-string';

const ONE_TRACK_SEARCH = {
  data: [
    {
      id: 2602484932, title: 'Sunny Day (Live)', title_short: 'Sunny Day', duration: 250,
      explicit_lyrics: false, md5_image: 'aaa',
      album: { id: 905270172, title: 'Jay Chou Live', cover_medium: 'https://cdn-images.dzcdn.net/images/cover/aaa/250x250.jpg' },
      artist: { id: 69175, name: 'Jay Chou' }
    }
  ],
  total: 1
};

const THREE_TRACK_SEARCH = {
  data: [
    ONE_TRACK_SEARCH.data[0],
    { ...ONE_TRACK_SEARCH.data[0], id: 2602484933, title: 'Sunny Day (Studio)', explicit_lyrics: true },
    {
      id: 1111111, title: 'Other', title_short: 'Other', duration: 200, explicit_lyrics: false,
      album: { id: 2222222, title: 'Other Album', cover_medium: 'https://cdn-images.dzcdn.net/images/cover/ccc/250x250.jpg' },
      artist: { id: 1, name: 'Someone Else' }
    }
  ]
};

const ALBUM_DETAILS = {
  905270172: { id: 905270172, title: 'Jay Chou Live', release_date: '2019-11-01' },
  2222222: { id: 2222222, title: 'Other Album', release_date: '2018-05-20' }
};

const SYNCED_LYRICS = {
  data: {
    track: {
      id: '2602484932',
      lyrics: {
        id: 'lyr1', text: '故事的小黄花\n从出生那年就飘着\n', copyright: '© Deezer',
        synchronizedLines: [
          { lrcTimestamp: '[00:00.50]', line: '故事的小黄花', milliseconds: 500, duration: 2000 },
          { lrcTimestamp: '[00:02.50]', line: '从出生那年就飘着', milliseconds: 2500, duration: 2500 }
        ]
      }
    }
  }
};

async function runtime() {
  const plugin = await loadPlugin(root);
  return { plugin, runtime: await createRuntime(plugin) };
}

function mockHttp(runtime, { search = ONE_TRACK_SEARCH, pipeResponse, pipeExpireFirst = false } = {}) {
  let calls = { jwt: 0, pipe: 0, album: 0 };
  runtime.context.Platform.http.getText = url => {
    const u = new URL(url);
    assert.equal(u.hostname, 'api.deezer.com');
    if (u.pathname === '/search') return JSON.stringify(search);
    const m = u.pathname.match(/^\/album\/(\d+)$/);
    if (m) {
      calls.album++;
      return JSON.stringify(ALBUM_DETAILS[Number(m[1])] || null);
    }
    throw new Error('Unexpected GET: ' + url);
  };
  runtime.context.Platform.http.postText = (url, body) => {
    const u = new URL(url);
    if (u.hostname === 'auth.deezer.com') {
      calls.jwt++;
      assert.equal(body, '', 'auth body must be empty string');
      return JSON.stringify({ jwt: FAKE_JWT });
    }
    if (u.hostname === 'pipe.deezer.com') {
      calls.pipe++;
      const req = JSON.parse(body);
      assert.equal(req.operationName, 'SynchronizedTrackLyrics');
      if (pipeExpireFirst && calls.pipe === 1) {
        return JSON.stringify({ errors: [{ message: 'Jwt is expired' }] });
      }
      return JSON.stringify(pipeResponse !== undefined ? pipeResponse : SYNCED_LYRICS);
    }
    throw new Error('Unexpected POST: ' + url);
  };
  return calls;
}

test('Deezer search maps fields and fills dates from album details', async () => {
  const { runtime: r } = await runtime();
  const calls = mockHttp(r, { search: THREE_TRACK_SEARCH });
  const result = JSON.parse((await r.call('searchSongs', { keyword: 'jay chou sunny', page: 1, pageSize: 20 })).raw);
  assert.equal(result.length, 3);
  assert.equal(result[0].id, '2602484932');
  assert.equal(result[0].title, 'Sunny Day (Live)');
  assert.equal(result[0].artist, 'Jay Chou');
  assert.equal(result[0].album, 'Jay Chou Live');
  assert.equal(result[0].duration, 250000);
  assert.equal(result[0].date, '2019-11-01'); // filled from album detail
  assert.equal(result[0].explicit, false);
  assert.equal(result[1].explicit, true);
  // 3 tracks but only 2 distinct albums → album detail fetched twice (not 3x)
  assert.equal(calls.album, 2);
  assert.equal(result[2].date, '2018-05-20');
});

test('Deezer getLyrics returns empty array when no arl configured', async () => {
  const { plugin, runtime: r } = await runtime();
  r.context.Platform.http.getText = () => { throw new Error('should not call'); };
  r.context.Platform.http.postText = () => { throw new Error('should not call'); };
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Jay Chou Live', date: '2019-11-01', fields: {} },
    config: {}
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(result.raw, '[]');
});

test('Deezer getLyrics exchanges arl for JWT, calls GraphQL, returns synced candidate array', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Jay Chou Live', date: '2019-11-01', fields: {} },
    config: { arl: 'test-arl-cookie' }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(calls.jwt, 1);
  assert.equal(calls.pipe, 1);
  const candidates = JSON.parse(result.raw);
  assert.ok(Array.isArray(candidates), 'getLyrics must return an array');
  assert.ok(candidates.length >= 1);
  const c = candidates[0];
  assert.equal(c.tags.ti, 'Sunny Day (Live)');
  assert.equal(c.tags.ar, 'Jay Chou');
  assert.equal(c.type, 'rawPlainLrc');
  assert.ok(c.rawPlainLrc.includes('[00:00.50]故事的小黄花'));
  assert.ok(c.rawPlainLrc.includes('[00:02.50]从出生那年就飘着'));
});

test('Deezer getLyrics retries JWT once when pipe reports token expired', async () => {
  const { runtime: r } = await runtime();
  const calls = mockHttp(r, { pipeExpireFirst: true });
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Jay Chou Live', date: '2019-11-01', fields: {} },
    config: { arl: 'test-arl-cookie' }
  });
  const candidates = JSON.parse(result.raw);
  assert.ok(candidates.length >= 1);
  assert.equal(calls.jwt, 2); // initial + re-auth after expiry
  assert.equal(calls.pipe, 2); // expired + success
});

test('Deezer getLyrics returns empty array when track has no lyrics', async () => {
  const { plugin, runtime: r } = await runtime();
  mockHttp(r, { pipeResponse: { data: { track: { id: '1', lyrics: null } } } });
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Jay Chou Live', date: '2019-11-01', fields: {} },
    config: { arl: 'test-arl-cookie' }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(result.raw, '[]');
});

test('Deezer getLyrics iterates multiple search candidates and returns each with lyrics', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockHttp(r, { search: THREE_TRACK_SEARCH });
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Jay Chou Live', date: '2019-11-01', fields: {} },
    config: { arl: 'test-arl-cookie' }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  const candidates = JSON.parse(result.raw);
  // 3 search hits → 3 pipe calls (one per track), each with lyrics → 3 candidates
  assert.equal(candidates.length, 3);
  assert.equal(calls.pipe, 3);
  // all share the same JWT (cached, not re-fetched per track)
  assert.equal(calls.jwt, 1);
});

test('Deezer searchCovers only returns songs with a cover URL', async () => {
  const { runtime: r } = await runtime();
  r.context.Platform.http.getText = () => JSON.stringify({
    data: [
      ONE_TRACK_SEARCH.data[0],
      { ...ONE_TRACK_SEARCH.data[0], id: 999, album: { id: 9, title: 'No Cover', cover_medium: '' } }
    ]
  });
  const covers = JSON.parse((await r.call('searchCovers', { keyword: 'jay' })).raw);
  assert.equal(covers.length, 1);
  assert.equal(covers[0].id, '2602484932');
});
