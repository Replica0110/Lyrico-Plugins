import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../src/plugin-loader.js';
import { createRuntime } from '../src/runtime.js';
import { validateFunctionResult } from '../src/result-parser.js';

const root = fileURLToPath(new URL('../../../petitlyrics/', import.meta.url));

const ok = text => ({ code: 200, body: text });

const WSY_XML = '<?xml version="1.0" encoding="UTF-8"?><wsy>' +
  '<line><linestring>你好世界</linestring>' +
    '<word><wordstring>你好</wordstring><starttime>1000</starttime><endtime>1200</endtime></word>' +
    '<word><wordstring>世界</wordstring><starttime>1200</starttime><endtime>1400</endtime></word>' +
  '</line>' +
  '<line><linestring>下一句</linestring>' +
    '<word><wordstring>下一句</wordstring><starttime>3000</starttime><endtime>3300</endtime></word>' +
  '</line>' +
  '</wsy>';

const PLAIN_TEXT = '故事的小黄花\n从出生那年就飘着\n';

function wrap(songsXml) { return `<root><status>00000000</status>${songsXml}</root>`; }
function song(dataB64, extra = '') {
  return `<song><lyricsId>1</lyricsId><title>Sunny Day</title><artist>Jay Chou</artist><album>Fantasy</album><duration>250000</duration><writer>W</writer><composer>C</composer><lyricsData>${dataB64}</lyricsData>${extra}</song>`;
}
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

async function runtime() {
  const plugin = await loadPlugin(root);
  return { plugin, runtime: await createRuntime(plugin) };
}

function mockHttp(runtime, { tier3, tier2, tier1 } = {}) {
  const calls = { type3: 0, type2: 0, type1: 0 };
  runtime.context.Platform.http.post = (url, body) => {
    assert.equal(new URL(url).hostname, 'p0.petitlyrics.com');
    const params = new URLSearchParams(body);
    const lt = params.get('lyricsType');
    if (lt === '3') { calls.type3++; return ok(tier3 !== undefined ? tier3 : wrap(song(b64(WSY_XML)))); }
    if (lt === '2') { calls.type2++; return ok(tier2 !== undefined ? tier2 : wrap('')); }
    if (lt === '1') { calls.type1++; return ok(tier1 !== undefined ? tier1 : wrap(song(b64(PLAIN_TEXT)))); }
    throw new Error('Unexpected lyricsType: ' + lt);
  };
  return calls;
}

test('PetitLyrics sends clientAppId/terminalType/key_title and parses tier-3 WSY into word-timed structured', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockHttp(r);
  let posted;
  r.context.Platform.http.post = (url, body) => {
    posted = new URLSearchParams(body);
    return ok(wrap(song(b64(WSY_XML))));
  };
  const result = await r.call('getLyrics', { song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {} } });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(posted.get('clientAppId'), 'p1110417');
  assert.equal(posted.get('terminalType'), '10');
  assert.equal(posted.get('lyricsType'), '3');
  assert.equal(posted.get('key_title'), 'Sunny Day');
  const candidates = JSON.parse(result.raw);
  assert.ok(Array.isArray(candidates));
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.type, 'structured');
  assert.deepEqual(c.original[0], [1000, 1400, [[1000, 1200, '你好'], [1200, 1400, '世界']]]);
  assert.deepEqual(c.original[1], [3000, 3300, [[3000, 3300, '下一句']]]);
  assert.equal(checked.parsed[0].lyrics.original[0].isWordByWord, true);
  assert.equal(c.tags.ti, 'Sunny Day');
  assert.equal(c.tags.ar, 'Jay Chou');
  assert.equal(c.tags.al, 'Fantasy');
  assert.equal(c.tags.date, '2001');
});

test('PetitLyrics falls back to tier-1 plain text when tiers 3 and 2 are empty', async () => {
  const { plugin, runtime: r } = await runtime();
  const calls = mockHttp(r, { tier3: wrap(''), tier2: wrap('') });
  const result = await r.call('getLyrics', { song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {} } });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(calls.type3, 1);
  assert.equal(calls.type2, 1);
  assert.equal(calls.type1, 1);
  const candidates = JSON.parse(result.raw);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.type, 'rawPlainLrc');
  assert.ok(c.rawPlainLrc.includes('故事的小黄花'));
  assert.ok(c.rawPlainLrc.includes('从出生那年就飘着'));
});

test('PetitLyrics returns empty array when status is not 00000000', async () => {
  const { plugin, runtime: r } = await runtime();
  r.context.Platform.http.post = () => ok('<root><status>99999999</status></root>');
  const result = await r.call('getLyrics', { song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {} } });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(result.raw, '[]');
});

test('PetitLyrics returns empty array when every tier has no usable lyrics', async () => {
  const { plugin, runtime: r } = await runtime();
  mockHttp(r, { tier3: wrap(''), tier2: wrap(''), tier1: wrap('') });
  const result = await r.call('getLyrics', { song: { title: 'Sunny Day', artist: 'Jay Chou', album: 'Fantasy', date: '2001', fields: {} } });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(result.raw, '[]');
});

test('PetitLyrics returns empty array when the song has no title (host contract requires request.song)', async () => {
  const { plugin, runtime: r } = await runtime();
  r.context.Platform.http.post = () => { throw new Error('should not call'); };
  const result = await r.call('getLyrics', { song: { artist: 'Jay Chou', fields: {} } });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  assert.equal(result.raw, '[]');
});
