import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLyricsResult, validateFunctionResult } from '../src/result-parser.js';

test('structured TTML fields match the Android host payload', () => {
  const parsed = parseLyricsResult(JSON.stringify({
    type: 'structured',
    original: [[0, 1000, [[0, 500, '你'], [500, 1000, '好']], {
      'ttm:agent': 'v1',
      'itunes:song-part': 'Verse',
      divBegin: 0,
      'custom:value': 'ignored'
    }]],
    romanization: [[0, 1000, [[0, 500, 'ni'], [500, 1000, 'hao']]]],
    agents: [{ id: 'v1', type: 'person', name: 'Singer' }],
    metadata: [{
      name: 'songwriters',
      children: [{ name: 'songwriter', text: 'Writer' }]
    }],
    timing: 'Word',
    language: 'zh-Hans',
    translated_lang: 'en',
    romanization_lang: 'zh-Latn-pinyin'
  }));

  assert.deepEqual(parsed.original[0].extensions, {
    'ttm:agent': 'v1',
    'itunes:song-part': 'Verse',
    divBegin: '0'
  });
  assert.equal(parsed.romanization[0].words.length, 2);
  assert.deepEqual(parsed.agents, [{ id: 'v1', type: 'person', name: 'Singer' }]);
  assert.equal(parsed.metadata[0].children[0].text, 'Writer');
  assert.equal(parsed.timing, 'Word');
  assert.equal(parsed.language, 'zh-Hans');
  assert.equal(parsed.translatedLang, 'en');
  assert.equal(parsed.romanizationLang, 'zh-Latn-pinyin');
});

test('invalid and duplicate metadata is ignored with warnings', () => {
  const plugin = { manifest: { id: 'test', name: 'Test', apiVersion: 3 } };
  const checked = validateFunctionResult('getLyrics', JSON.stringify({
    type: 'structured',
    original: [[0, 1000, 'line']],
    metadata: [
      { name: 'songwriters', children: [{ name: 'writer', text: 'Wrong element' }] },
      { name: 'translations' },
      { name: 'custom:item', text: 'Missing namespace' },
      { name: 'custom:item', namespace: 'https://example.com/custom', text: 'Kept' }
    ]
  }), plugin);

  assert.equal(checked.errors.length, 0);
  assert.equal(checked.warnings.length, 3);
  assert.deepEqual(checked.parsed.metadata.map(node => node.text), ['Kept']);
});
