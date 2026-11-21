import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../src/plugin-loader.js';
import { createRuntime } from '../src/runtime.js';
import { validateFunctionResult } from '../src/result-parser.js';

const root = fileURLToPath(new URL('../../../qq/', import.meta.url));
const song = { id: '123', title: 'Song', artist: 'Artist', album: 'Album', date: '2026' };

async function getLyrics(data) {
  const plugin = await loadPlugin(root);
  const runtime = await createRuntime(plugin);
  runtime.context.Platform.http.postText = (url, body) => {
    const request = JSON.parse(body).req_0;
    assert.equal(request.method, 'GetPlayLyricInfo');
    assert.equal(request.param.roma, 1);
    return JSON.stringify({ req_0: { data: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString('base64')])
    ) } });
  };
  const result = await runtime.call('getLyrics', { song });
  const checked = validateFunctionResult('getLyrics', result.raw, plugin);
  assert.deepEqual(checked.errors, []);
  return { raw: JSON.parse(result.raw)[0], parsed: checked.parsed[0]?.lyrics };
}

test('QQ retains QRC romanization timing through line alignment and host parsing', async () => {
  const { raw, parsed } = await getLyrics({
    lyric: '[1000,1000]君(1100,200)へ(1450,250)\n[3000,500]次(3000,500)',
    trans: '[00:01.00]致你\n[00:03.00]下一句',
    roma: '[950,1000]ki(1100,100)mi(1201,200)(1401,100)e(1600,0)\n[3000,500]tsugi(3000,500)'
  });
  assert.deepEqual(raw.romanization[0], [1000, 2000, [
    [1100, 1200, 'ki'], [1201, 1401, 'mi'], [1401, 1501, ''], [1600, 1950, 'e']
  ]]);
  assert.deepEqual(raw.translated[0], [1000, 2000, '致你']);
  assert.deepEqual(parsed.romanization[0].words, [
    { start: 1100, end: 1200, text: 'ki' },
    { start: 1201, end: 1401, text: 'mi' },
    { start: 1600, end: 1950, text: 'e' }
  ]);
  assert.equal(parsed.romanization[1].isWordByWord, true);
});

test('QQ keeps actual line-timed tracks as strings and accepts word-timed translation', async () => {
  const { raw, parsed } = await getLyrics({
    lyric: '[1000,1000]原文',
    trans: '[1000,1000]trans(1100,200)lation(1500,300)',
    roma: '[00:01.00]genbun'
  });
  assert.equal(raw.original[0][2], '原文');
  assert.equal(raw.romanization[0][2], 'genbun');
  assert.deepEqual(raw.translated[0][2], [[1100, 1300, 'trans'], [1500, 1800, 'lation']]);
  assert.equal(parsed.original[0].isWordByWord, false);
  assert.equal(parsed.romanization[0].isWordByWord, false);
  assert.equal(parsed.translated[0].isWordByWord, true);
  assert.equal(parsed.isWordByWord, true);
});

test('QQ supports line LRC originals and leaves missing romanization absent', async () => {
  const { raw } = await getLyrics({ lyric: '[00:01.00]原文', trans: '', roma: '' });
  assert.equal(raw.original[0][2], '原文');
  assert.equal(raw.romanization, null);
  assert.equal(raw.translated, null);
});
