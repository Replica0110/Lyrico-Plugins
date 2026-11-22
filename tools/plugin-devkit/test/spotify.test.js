import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../src/plugin-loader.js';
import { createRuntime } from '../src/runtime.js';
import { validateFunctionResult } from '../src/result-parser.js';

const root = fileURLToPath(new URL('../../../spotify/', import.meta.url));

const ok = body => ({ code: 200, body: typeof body === 'string' ? body : JSON.stringify(body) });
const bytes = text => ({ code: 200, bodyBase64: Buffer.from(text, 'utf8').toString('base64') });

// Real Spotify Partner API searchDesktop response shape (hash 75bbf6bf):
// data.search.tracks.items[].track.{ id, name, album.{name, coverArt.sources[]},
//   artists.items[].profile.name, duration.totalMilliseconds }
const SEARCH_GQL = {
  data: {
    search: {
      tracks: {
        items: [{ track: {
          id: 'trackabc',
          uri: 'spotify:track:trackabc',
          name: 'Sunny Day',
          artists: { items: [{ profile: { name: 'Jay Chou' } }] },
          album: {
            name: 'Fantasy',
            coverArt: { sources: [
              { url: 'https://i.scdn.co/img/small.jpg', width: 300 },
              { url: 'https://i.scdn.co/img/large.jpg', width: 640 }
            ] }
          },
          duration: { totalMilliseconds: 250000 }
        } }]
      }
    }
  }
};

// The other hash (0dff51c9) returns data.searchV2.tracks.items[].data with the
// same coverArt.sources field. Both paths must resolve a cover.
const SEARCH_V2_GQL = {
  data: {
    searchV2: {
      tracks: {
        items: [{ data: {
          id: 'trackv2',
          uri: 'spotify:track:trackv2',
          name: 'Sunny Day',
          artists: { items: [{ profile: { name: 'Jay Chou' } }] },
          album: {
            name: 'Fantasy',
            coverArt: { sources: [
              { url: 'https://i.scdn.co/img/v2.jpg', width: 300 }
            ] }
          },
          duration: { totalMilliseconds: 250000 }
        } }]
      }
    }
  }
};

const SYLLABLE_LYRICS = {
  lyrics: {
    syncType: 'SYLLABLE_SYNCED',
    lines: [
      { startTimeMs: 1000, words: '你好世界', syllables: [{ startTimeMs: 1000, endTimeMs: 1200, numChars: 2 }, { startTimeMs: 1200, endTimeMs: 1400, numChars: 2 }] },
      { startTimeMs: 3000, words: '下一句', syllables: [] }
    ]
  }
};

const LINE_LYRICS = {
  lyrics: {
    syncType: 'LINE_SYNCED',
    lines: [
      { startTimeMs: 1000, words: '故事的小黄花' },
      { startTimeMs: 3000, words: '从出生那年就飘着' }
    ]
  }
};

async function runtime() {
  const plugin = await loadPlugin(root);
  return { plugin, runtime: await createRuntime(plugin) };
}

function mockAll(runtime, { search = SEARCH_GQL, lyrics = SYLLABLE_LYRICS, tokenOk = true } = {}) {
  const calls = { secrets: 0, serverTime: 0, token: 0, clientToken: 0, graphql: 0, lyrics: 0 };
  runtime.context.Platform.http.get = url => {
    const u = new URL(url);
    if (u.hostname === 'raw.githubusercontent.com') {
      calls.secrets++;
      return ok(''); // force fallback secret
    }
    if (u.pathname === '/api/server-time') {
      calls.serverTime++;
      return ok({ serverTime: 1700000000 });
    }
    if (u.pathname === '/api/token') {
      calls.token++;
      return tokenOk ? ok({ accessToken: 'access-token', clientId: 'client-id', expiresIn: 3600 }) : { code: 401, body: '' };
    }
    throw new Error('Unexpected GET: ' + url);
  };
  runtime.context.Platform.http.post = url => {
    const u = new URL(url);
    if (u.hostname === 'clienttoken.spotify.com') {
      calls.clientToken++;
      return ok({ granted_token: { token: 'client-token', expires_after: 3600 } });
    }
    if (u.hostname === 'api-partner.spotify.com') {
      calls.graphql++;
      return ok(search);
    }
    throw new Error('Unexpected POST: ' + url);
  };
  runtime.context.Platform.http.getBytes = url => {
    const u = new URL(url);
    assert.equal(u.hostname, 'spclient.wg.spotify.com');
    calls.lyrics++;
    return bytes(JSON.stringify(lyrics));
  };
  return calls;
}

test('Spotify search returns [] when sp_dc is not configured (no HTTP calls)', async () => {
  const { runtime: r } = await runtime();
  r.context.Platform.http.get = () => { throw new Error('should not call'); };
  r.context.Platform.http.post = () => { throw new Error('should not call'); };
  const res = JSON.parse((await r.call('searchSongs', { title: 'x', config: {} })).raw);
  assert.equal(res.length, 0);
});

test('Spotify search completes the auth flow and maps the first GraphQL hit', async () => {
  const { runtime: r } = await runtime();
  const calls = mockAll(r);
  const result = JSON.parse((await r.call('searchSongs', { title: 'Sunny Day', artist: 'Jay Chou', config: { sp_dc: 'cookie' } })).raw);
  assert.equal(calls.token, 1);
  assert.equal(calls.clientToken, 1);
  assert.equal(calls.graphql, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'trackabc');
  assert.equal(result[0].title, 'Sunny Day');
  assert.equal(result[0].artist, 'Jay Chou');
  assert.equal(result[0].album, 'Fantasy');
  assert.equal(result[0].duration, 250000);
  // largest image (width 640) is picked from coverArt.sources[]
  assert.equal(result[0].picUrl, 'https://i.scdn.co/img/large.jpg');
  assert.equal(result[0].internal.spotify_id, 'trackabc');
});

test('Spotify search resolves a cover from the searchV2 response path (hash 0dff51c9)', async () => {
  const { runtime: r } = await runtime();
  mockAll(r, { search: SEARCH_V2_GQL });
  const result = JSON.parse((await r.call('searchSongs', { title: 'Sunny Day', artist: 'Jay Chou', config: { sp_dc: 'cookie' } })).raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'trackv2');
  assert.equal(result[0].picUrl, 'https://i.scdn.co/img/v2.jpg');
  assert.equal(result[0].album, 'Fantasy');
});

test('Spotify getLyrics uses internal.spotify_id directly and returns structured syllable candidate', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockAll(r);
  const result = await r.call('getLyrics', {
    song: { id: 'trackabc', title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {}, internal: { spotify_id: 'trackabc' } },
    config: { sp_dc: 'cookie' }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  // no search needed because trackId is in internal
  assert.equal(calls.graphql, 0);
  assert.equal(calls.lyrics, 1);
  const candidates = JSON.parse(result.raw);
  assert.ok(Array.isArray(candidates));
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.type, 'structured');
  // syllable line: 你好(1000-1200), 世界(1200-1400); line end clamped to next line start 3000
  assert.deepEqual(c.original[0], [1000, 3000, [[1000, 1200, '你好'], [1200, 1400, '世界']]]);
  assert.equal(c.tags.ti, 'Sunny Day');
  assert.equal(c.tags.ar, 'Jay Chou');
  assert.equal(c.tags.al, 'Fantasy');
  assert.equal(c.tags.date, '2001');
});

test('Spotify getLyrics searches for track id when internal.spotify_id is absent', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockAll(r);
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {} },
    config: { sp_dc: 'cookie' }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(calls.graphql, 1);
  assert.equal(calls.lyrics, 1);
  const candidates = JSON.parse(result.raw);
  assert.ok(candidates.length >= 1);
});

test('Spotify getLyrics parses LINE_SYNCED lines as plain-text structured lines', async () => {
  const { plugin, runtime: r } = await runtime();
  mockAll(r, { lyrics: LINE_LYRICS });
  const result = await r.call('getLyrics', {
    song: { id: 'trackabc', title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {}, internal: { spotify_id: 'trackabc' } },
    config: { sp_dc: 'cookie' }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  const c = JSON.parse(result.raw)[0];
  assert.equal(c.original[0][2], '故事的小黄花');
  assert.equal(c.original[1][2], '从出生那年就飘着');
  assert.equal(checked.parsed[0].lyrics.original[0].isWordByWord, false);
});

test('Spotify getLyrics returns [] when sp_dc is missing', async () => {
  const { plugin, runtime: r } = await runtime();
  r.context.Platform.http.get = () => { throw new Error('should not call'); };
  r.context.Platform.http.post = () => { throw new Error('should not call'); };
  r.context.Platform.http.getBytes = () => { throw new Error('should not call'); };
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {} },
    config: {}
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(result.raw, '[]');
});

test('Spotify getLyrics returns [] when token fetch fails', async () => {
  const { plugin, runtime: r } = await runtime();
  mockAll(r, { tokenOk: false });
  const result = await r.call('getLyrics', {
    song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {}, internal: { spotify_id: 'trackabc' } },
    config: { sp_dc: 'cookie' }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(result.raw, '[]');
});

test('Spotify searchCovers requires a cover on the search hit', async () => {
  const { runtime: r } = await runtime();
  const noCover = { data: { search: { tracks: { items: [{ track: { id: 't1', name: 'NoCover', artists: { items: [{ profile: { name: 'A' } }] }, album: { name: 'Al', coverArt: { sources: [] } } } }] } } } };
  mockAll(r, { search: noCover });
  const covers = JSON.parse((await r.call('searchCovers', { keyword: 'x', config: { sp_dc: 'cookie' } })).raw);
  assert.equal(covers.length, 0);

  mockAll(r, { search: SEARCH_GQL });
  const covers2 = JSON.parse((await r.call('searchCovers', { keyword: 'x', config: { sp_dc: 'cookie' } })).raw);
  assert.equal(covers2.length, 1);
  assert.equal(covers2[0].picUrl, 'https://i.scdn.co/img/large.jpg');
});
