import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../src/plugin-loader.js';
import { createRuntime } from '../src/runtime.js';
import { validateFunctionResult } from '../src/result-parser.js';

const root = fileURLToPath(new URL('../../../musixmatch/', import.meta.url));

const SEARCH_RESP = {
  message: {
    header: { status_code: 200 },
    body: {
      track_list: [
        { track: { track_id: 111, track_name: 'Sunny Day', artist_name: 'Jay Chou', album_name: 'Fantasy', track_length: 250, first_release_date: '2001-09-01', album_coverart_800x800: 'https://example.com/cov.jpg', has_lyrics: 1 } },
        { track: { track_id: 222, track_name: 'Other', artist_name: 'Someone', album_name: 'X', track_length: 200, first_release_date: '2020-01-01', album_coverart_100x100: 'http://example.com/nocover.png', has_lyrics: 1 } }
      ]
    }
  }
};

function macroResp({ lrc = '[00:01.00]故事的小黄花\n[00:03.00]从出生那年就飘着\n', rich = '', title = 'Sunny Day', artist = 'Jay Chou', album = 'Fantasy', date = '2001-09-01', hasRichsync = false } = {}) {
  return {
    message: {
      header: { status_code: 200 },
      body: {
        macro_calls: {
          'track.subtitles.get': { message: { header: { status_code: 200 }, body: { subtitle_list: lrc ? [{ subtitle: { subtitle_body: lrc } }] : [] } } },
          'matcher.track.get': { message: { header: { status_code: 200 }, body: { track: { commontrack_id: 'ct1', has_richsync: hasRichsync ? 1 : 0, track_name: title, artist_name: artist, album_name: album, first_release_date: date } } } },
          'track.richsync.get': { message: { header: { status_code: 200 }, body: { richsync: { richsync_body: rich } } } }
        }
      }
    }
  };
}

async function runtime() {
  const plugin = await loadPlugin(root);
  return { plugin, runtime: await createRuntime(plugin) };
}

function mockHttp(runtime, { search = SEARCH_RESP, macro } = {}) {
  const calls = { search: 0, macro: 0, token: 0, translation: 0 };
  runtime.context.Platform.http.getText = url => {
    const u = new URL(url);
    assert.equal(u.hostname, 'apic.musixmatch.com');
    const endpoint = u.pathname.split('/').pop();
    if (endpoint === 'token.get') { calls.token++; return JSON.stringify({ message: { header: { status_code: 200 }, body: { user_token: 'guest-token-abc' } } }); }
    if (endpoint === 'track.search') { calls.search++; return JSON.stringify(search); }
    if (endpoint === 'macro.subtitles.get') { calls.macro++; return JSON.stringify(macro !== undefined ? macro : macroResp()); }
    if (endpoint === 'track.translations.get') { calls.translation++; return JSON.stringify({ message: { header: { status_code: 200 }, body: { translation_list: [{ translation: { translation_body: '[00:01.00]翻译\n' } }] } } }); }
    throw new Error('Unexpected GET: ' + url);
  };
  return calls;
}

test('Musixmatch search uses configured usertoken (no token.get), maps fields & strips nocover', async () => {
  const { runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = JSON.parse((await r.call('searchSongs', { title: 'Sunny Day', artist: 'Jay Chou', pageSize: 5, config: { usertoken: 'user-token-xyz' } })).raw);
  assert.equal(calls.token, 0);
  assert.equal(calls.search, 1);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, '111');
  assert.equal(result[0].title, 'Sunny Day');
  assert.equal(result[0].artist, 'Jay Chou');
  assert.equal(result[0].album, 'Fantasy');
  assert.equal(result[0].duration, 250000);
  assert.equal(result[0].date, '2001-09-01');
  assert.equal(result[0].picUrl, 'https://example.com/cov.jpg');
  assert.equal(result[0].internal.track_id, '111');
  // nocover.png is filtered → empty picUrl
  assert.equal(result[1].picUrl, '');
});

test('Musixmatch search auto-fetches guest token when usertoken is absent', async () => {
  const { runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = JSON.parse((await r.call('searchSongs', { keyword: 'hello', config: {} })).raw);
  assert.equal(calls.token, 1);
  assert.equal(calls.search, 1);
  assert.ok(result.length >= 1);
});

test('Musixmatch search returns [] when no token available (token.get fails)', async () => {
  const { runtime: r } = await runtime();
  r.context.Platform.http.getText = () => JSON.stringify({ message: { header: { status_code: 401 } } });
  const res = JSON.parse((await r.call('searchSongs', { keyword: 'x', config: {} })).raw);
  assert.equal(res.length, 0);
});

test('Musixmatch getLyrics parses LRC subtitle into structured and validates no errors', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = await r.call('getLyrics', {
    song: { id: '111', title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001-09-01', fields: {}, internal: { track_id: '111' } },
    config: { usertoken: 'user-token-xyz', lyrics_mode: 'line' }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(calls.macro, 1);
  const candidates = JSON.parse(result.raw);
  assert.ok(Array.isArray(candidates));
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.type, 'structured');
  // line mode: each line merged to plain text (not word arrays)
  assert.equal(c.original[0][2], '故事的小黄花');
  assert.equal(c.original[1][2], '从出生那年就飘着');
  assert.equal(c.tags.ti, 'Sunny Day');
  assert.equal(c.tags.ar, 'Jay Chou');
  assert.equal(c.tags.al, 'Fantasy');
  assert.equal(c.tags.date, '2001-09-01');
});

test('Musixmatch getLyrics parses richsync into word-timed structured (word mode)', async () => {
  const { plugin, runtime: r } = await runtime();
  const rich = '[{"ts":1.0,"l":[{"c":"你好","o":0},{"c":"世界","o":1.0}]},{"ts":3.0,"l":[{"c":"下","o":0},{"c":"一句","o":0.5}]}]';
  mockHttp(r, { macro: macroResp({ rich, lrc: '', hasRichsync: true }) });
  const result = await r.call('getLyrics', {
    song: { id: '111', title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001-09-01', fields: {}, internal: { track_id: '111' } },
    config: { usertoken: 'user-token-xyz', lyrics_mode: 'word' }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  const candidates = JSON.parse(result.raw);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.type, 'structured');
  // first line: ts=1.0 → 1000ms; word offsets 0 and 1.0s; next line starts at 3000
  assert.deepEqual(c.original[0], [1000, 3000, [[1000, 2000, '你好'], [2000, 3000, '世界']]]);
  assert.equal(checked.parsed[0].lyrics.original[0].isWordByWord, true);
});

test('Musixmatch getLyrics fetches translation when translation_language is set', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockHttp(r);
  const result = await r.call('getLyrics', {
    song: { id: '111', title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001-09-01', fields: {}, internal: { track_id: '111' } },
    config: { usertoken: 'user-token-xyz', translation_language: '14' }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(calls.translation, 1);
  const candidates = JSON.parse(result.raw);
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].translated);
  assert.ok(candidates[0].translated.length >= 1);
});

test('Musixmatch getLyrics returns empty array when no lyrics in macro response', async () => {
  const { plugin, runtime: r } = await runtime();
  mockHttp(r, { macro: macroResp({ lrc: '', rich: '', hasRichsync: false }) });
  const result = await r.call('getLyrics', {
    song: { id: '111', title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001-09-01', fields: {}, internal: { track_id: '111' } },
    config: { usertoken: 'user-token-xyz' }
  });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(result.raw, '[]');
});

test('Musixmatch searchCovers filters out tracks missing cover or metadata', async () => {
  const { runtime: r } = await runtime();
  mockHttp(r);
  const covers = JSON.parse((await r.call('searchCovers', { keyword: 'sunny', config: { usertoken: 'user-token-xyz' } })).raw);
  // result[0] has cover + all metadata; result[1] has empty picUrl (nocover) → filtered
  assert.equal(covers.length, 1);
  assert.equal(covers[0].id, '111');
  assert.equal(covers[0].picUrl, 'https://example.com/cov.jpg');
});
