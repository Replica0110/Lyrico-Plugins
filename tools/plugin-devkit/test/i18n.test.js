import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, signature, loadStrings, localizeManifest } from '../src/i18n.js';
import { loadPlugin } from '../src/plugin-loader.js';
import { createRuntime } from '../src/runtime.js';

const appleRoot = fileURLToPath(new URL('../../../apple/', import.meta.url));

test('positional arguments can reorder, repeat, and contain literal percent signs', () => {
  assert.equal(format('%2$d / %1$s / %1$s / %%', ['50% music', 3]), '3 / 50% music / 50% music / %');
  assert.equal(format('%s', ['Apple']), 'Apple');
  assert.equal(format('%d', [-2]), '-2');
  for (const template of ['%s %d', '%1$s %d', '%0$s', '%2$s', '%1$s %1$d', '%f', '%1$%']) {
    assert.throws(() => signature(template), template);
  }
  for (const args of [[], ['3'], [1.2], [Infinity], [Number.MAX_SAFE_INTEGER + 1], [2, 3]]) {
    assert.throws(() => format('%d', args));
  }
  assert.throws(() => format('%s', [null]));
});

test('Apple resources match Chinese scripts, multiple preferences and default English', async () => {
  const plugin = await loadPlugin(appleRoot);
  for (const [preferences, expected, title] of [
    [['zh-CN'], 'zh-Hans', '内容语言'],
    [['zh-TW'], 'zh-Hant', '內容語言'],
    [['zh-HK'], 'zh-Hant', '內容語言'],
    [['ja-JP', 'zh-CN'], 'zh-Hans', '内容语言'],
    [['en-AU'], 'en', 'Content language'],
    [['de-DE'], 'en', 'Content language']
  ]) {
    const strings = await loadStrings(appleRoot, plugin.manifest, preferences);
    assert.equal(strings.getLocale(), expected);
    assert.equal(strings.text('@config.language.title'), title);
  }
  const en = await loadStrings(appleRoot, plugin.manifest, ['en']);
  const zh = await loadStrings(appleRoot, plugin.manifest, ['zh-CN']);
  assert.equal(en.t('status.lyricsCandidates', 'Test Song', 2), 'Found 2 lyrics candidates for Test Song.');
  assert.equal(zh.t('status.lyricsCandidates', '测试歌曲', 2), '为 测试歌曲 找到 2 个歌词候选。');
  assert.throws(() => zh.t('missing'));
});

test('actual Apple getLyrics uses translated multi-argument messages without network', async () => {
  const plugin = await loadPlugin(appleRoot);
  for (const locales of [['en'], ['zh-CN'], ['zh-TW']]) {
    const runtime = await createRuntime(plugin, { locales });
    runtime.context.getLyricsForSong = () => { throw new Error('offline fixture'); };
    const result = await runtime.call('getLyrics', {
      song: { id: '123', title: 'Test Song', artist: 'Artist', album: 'Album', date: '2026' }, config: {}
    });
    assert.equal(result.raw, '[]');
    const messages = JSON.stringify(result.logs);
    assert.match(messages, /offline fixture/);
    assert.match(messages, locales[0] === 'en' ? /Found 0 lyrics candidates/ : /0 個歌詞候選|0 个歌词候选/);
  }
});

test('missing translations fall back by key and malformed resources are rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lyrico-i18n-'));
  const manifest = { i18n: { defaultLocale: 'en', resources: { en: 'en.json', 'zh-Hans': 'zh.json' } } };
  try {
    await fs.writeFile(path.join(root, 'en.json'), JSON.stringify({ title: 'English', count: '%1$s: %2$d' }));
    await fs.writeFile(path.join(root, 'zh.json'), JSON.stringify({ title: '中文' }));
    const strings = await loadStrings(root, manifest, ['zh-CN']);
    assert.equal(strings.t('count', 'Apple', 3), 'Apple: 3');
    assert.equal(strings.text('fallback'), 'fallback');
    await fs.writeFile(path.join(root, 'zh.json'), JSON.stringify({ count: '%1$s: %2$s' }));
    await assert.rejects(loadStrings(root, manifest), /incompatible/);
    await fs.writeFile(path.join(root, 'zh.json'), '{}');
    await assert.rejects(loadStrings(root, { ...manifest, minHostApiVersion: 4, name: '@missing' }), /default UI/);
    await assert.rejects(loadStrings(root, { i18n: { defaultLocale: 'en', resources: { en: '../escape.json' } } }), /Unsafe/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('all seven plugins resolve their display fields in three languages without changing business data', async () => {
  for (const name of ['apple', 'kugou', 'lrcshare', 'musicbrainz', 'netease', 'qq', 'soda']) {
    const root = path.resolve(appleRoot, '..', name);
    const plugin = await loadPlugin(root);
    const before = JSON.stringify(plugin.manifest);
    assert.doesNotMatch(before, /"(?:nameKey|descriptionKey|titleKey|summaryKey|groupTitleKey|labelKey|contentKey)"/);
    for (const tag of ['en', 'zh-CN', 'zh-TW']) {
      const strings = await loadStrings(root, plugin.manifest, [tag]);
      const localized = localizeManifest(plugin.manifest, strings);
      assert.ok(!localized.name.startsWith('@'), name);
      assert.ok(!localized.description.startsWith('@'), name);
      for (const [index, field] of localized.configFields.entries()) {
        const original = plugin.manifest.configFields[index];
        for (const key of ['key', 'type', 'required', 'dependency', 'group']) assert.deepEqual(field[key], original[key]);
        if (field.type !== 'markdown') assert.equal(field.defaultValue, original.defaultValue);
        else assert.ok(!field.defaultValue.startsWith('@'), name);
        assert.ok(!field.title.startsWith('@'), name);
        assert.ok(!field.summary?.startsWith('@'), name);
        assert.ok(!field.groupTitle.startsWith('@'), name);
        for (const [i, option] of (field.options ?? []).entries()) {
          assert.equal(option.value, original.options[i].value);
          assert.ok(!option.label.startsWith('@'), name);
        }
      }
    }
    assert.equal(JSON.stringify(plugin.manifest), before);
  }
});

test('single @ references, @@ escapes, literal percentages and stable groups', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lyrico-at-'));
  const manifest = {
    name: '@title', description: '@@literal', minHostApiVersion: 4,
    i18n: { defaultLocale: 'en', resources: { en: 'en.json' } },
    configFields: [
      { key: '@business', type: 'text', title: '@title', group: '@group', defaultValue: '@raw', dependency: { match: { key: '@key', value: '@value' } }, options: [{ value: '@option', label: '@@label' }] },
      { key: 'md', type: 'markdown', title: 'Literal @title', group: 'Same title', defaultValue: '@body' }
    ]
  };
  try {
    await fs.writeFile(path.join(root, 'en.json'), JSON.stringify({ title: '100% https://example.test/a%20b %s', group: 'Same title', body: '@not.recursive' }));
    const strings = await loadStrings(root, manifest);
    const display = localizeManifest(manifest, strings);
    assert.equal(display.name, '100% https://example.test/a%20b %s');
    assert.equal(display.description, '@literal');
    assert.equal(display.configFields[0].defaultValue, '@raw');
    assert.equal(display.configFields[0].options[0].value, '@option');
    assert.equal(display.configFields[0].options[0].label, '@label');
    assert.deepEqual(display.configFields[0].dependency, manifest.configFields[0].dependency);
    assert.equal(display.configFields[1].defaultValue, '@not.recursive');
    assert.equal(display.configFields[1].title, 'Literal @title');
    assert.equal(new Set(display.configFields.map(f => f.group)).size, 2);
    assert.equal(new Set(display.configFields.map(f => f.groupTitle)).size, 1);
    assert.equal(strings.t('body'), '@not.recursive');
    assert.throws(() => strings.text('@missing'));
    await assert.rejects(loadStrings(root, { ...manifest, i18n: undefined }), /require i18n/);
    await assert.rejects(loadStrings(root, { ...manifest, name: '@' }), /Empty/);
    await assert.rejects(loadStrings(root, { ...manifest, minHostApiVersion: 3 }), /minHostApiVersion/);
    const legacy = { name: 'Legacy', description: '@@mention', configFields: [] };
    assert.equal(localizeManifest(legacy, await loadStrings(root, legacy)).description, '@mention');
  } finally {
    // root is the exact directory returned by mkdtemp, with no user-supplied path components.
    await fs.rm(root, { recursive: true, force: true });
  }
});
