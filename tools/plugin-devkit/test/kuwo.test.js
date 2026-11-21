import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../src/plugin-loader.js';
import { createRuntime } from '../src/runtime.js';
import { validateFunctionResult } from '../src/result-parser.js';

const root = fileURLToPath(new URL('../../../kuwo/', import.meta.url));
const song = { id: '228908', title: 'Song', artist: 'Artist', album: 'Album', date: '2026' };
async function runtime() {
  const plugin = await loadPlugin(root);
  return { plugin, runtime: await createRuntime(plugin) };
}

function encryptedResponse(plain) {
  const key = Buffer.from('yeelion');
  const encrypted = Buffer.from(plain).map((value, index) => value ^ key[index % key.length]);
  const body = Buffer.concat([Buffer.from('tp=content\r\n\r\n'), deflateSync(Buffer.from(encrypted.toString('base64')))]);
  return { code: 200, bodyBase64: body.toString('base64') };
}

test('Kuwo searches with zero-based pages and maps artist cover and cached album details', async () => {
  const { runtime: r } = await runtime();
  let albums = 0;
  r.context.Platform.http.getText = url => {
    const u = new URL(url);
    assert.equal(u.hostname, 'search.kuwo.cn');
    if (u.searchParams.get('ft') === 'album') {
      albums++;
      return JSON.stringify({ albumlist: [{ albumid: '42', pub: '2026-01-02', artist: 'Album Artist' }] });
    }
    assert.equal(u.searchParams.get('pn'), '1');
    assert.equal(u.searchParams.get('rn'), '2');
    return JSON.stringify({ abslist: [1, 2].map(id => ({ DC_TARGETID: String(id),
      SONGNAME: 'Song', ARTIST: 'A&B', ALBUM: 'Album', ALBUMID: '42',
      DURATION: '120', web_albumpic_short: '120/path.jpg' })) });
  };
  const result = JSON.parse((await r.call('searchSongs', {
    keyword: 'Song', page: 2, pageSize: 2, separator: ' / ', config: { cover_size: '1200' }
  })).raw);
  assert.equal(result.length, 2);
  assert.equal(albums, 1);
  assert.equal(result[0].artist, 'A / B');
  assert.equal(result[0].duration, 120000);
  assert.equal(result[0].date, '2026-01-02');
  assert.equal(result[0].fields.album_artist, 'Album Artist');
  assert.match(result[0].picUrl, /\/1200\/path\.jpg$/);
});

test('Kuwo decrypts binary lyrics and preserves GBK text and word timing in host payloads', async () => {
  const { plugin, runtime: r } = await runtime();
  const plain = Buffer.concat([Buffer.from('[kuwo:13]\n[00:01.000]<200,0>ab<600,0>cd\n[00:01.000]<0,0>'),
    Buffer.from([0xc4, 0xe3, 0xba, 0xc3])]);
  r.context.Platform.http.postBytesResponse = url => {
    assert.match(url, /^https:\/\/newlyric\.kuwo\.cn\/newlyric\.lrc\?/);
    return encryptedResponse(plain);
  };
  r.context.Platform.http.getText = () => { throw new Error('Unexpected fallback'); };
  const result = await r.call('getLyrics', { song });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  const payload = JSON.parse(result.raw)[0];
  assert.deepEqual(payload.original, [[1000, 1600, [[1100, 1200, 'ab'], [1300, 1600, 'cd']]]]);
  assert.deepEqual(payload.translated, [[1000, 1600, '你好']]);
  assert.equal(payload.tags.kuwo, undefined);
  assert.equal(checked.parsed[0].lyrics.original[0].isWordByWord, true);
  assert.equal(checked.parsed[0].lyrics.translated[0].isWordByWord, false);
});

test('Kuwo cover search still fills required dates when optional metadata is disabled', async () => {
  const { runtime: r } = await runtime();
  r.context.Platform.http.getText = url => {
    const u = new URL(url);
    return JSON.stringify(u.searchParams.get('ft') === 'album'
      ? { albumlist: [{ albumid: '42', pub: '2026-01-02', artist: 'Artist' }] }
      : { abslist: [{ DC_TARGETID: '1', SONGNAME: 'Song', ARTIST: 'Artist', ALBUM: 'Album',
        ALBUMID: '42', web_albumpic_short: '120/path.jpg' }] });
  };
  const config = { metadata_details: false };
  const covers = JSON.parse((await r.call('searchCovers', { keyword: 'Song', config })).raw);
  assert.equal(covers.length, 1);
  assert.equal(covers[0].date, '2026-01-02');
  assert.equal(config.metadata_details, false);
});

test('Kuwo falls back to line strings after corrupt encrypted lyrics and leaves empty results absent', async () => {
  const { runtime: r } = await runtime();
  r.context.Platform.http.postBytesResponse = () => ({ code: 200,
    bodyBase64: Buffer.from('tp=content\r\n\r\ncorrupt').toString('base64') });
  r.context.Platform.http.getText = url => {
    assert.match(url, /songinfoandlrc\?musicId=228908/);
    return JSON.stringify({ data: { lrclist: [
      { time: '1.25', lineLyric: 'one' }, { time: '2.5', lineLyric: 'two' }
    ] } });
  };
  const payload = JSON.parse((await r.call('getLyrics', { song })).raw)[0];
  assert.deepEqual(payload.original, [[1250, 2500, 'one'], [2500, 6500, 'two']]);
  r.context.Platform.http.getText = () => JSON.stringify({ data: { lrclist: [] } });
  assert.equal((await r.call('getLyrics', { song })).raw, '[]');
});
