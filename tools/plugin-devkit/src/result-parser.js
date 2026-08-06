import { STANDARD_FIELD_KEYS } from './spec.js';

export function parseSongResults(rawJson, plugin, { requireId = true } = {}) {
  const root = parseJson(rawJson);
  const items = Array.isArray(root)
    ? root
    : firstArray(root, ['items', 'results', 'songs', 'data']) ?? [];

  return items
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map((item, index) => {
      const picUrl = firstString(item, ['picUrl', 'coverUrl', 'cover_url', 'artworkUrl']) ?? '';
      const id = firstString(item, ['id', 'songId', 'trackId'])
        ?? (requireId ? null : picUrl || `${plugin.manifest.id}:cover:${index}`);
      if (!id) return null;
      const fieldResult = sanitizeFields(stringMap(firstObject(item, ['fields', 'metadata']) ?? {}));
      return {
        id,
        pluginId: plugin.manifest.id,
        pluginName: plugin.manifest.name,
        title: firstString(item, ['title', 'name', 'songName']) ?? '',
        artist: firstString(item, ['artist', 'artists', 'singer']) ?? '',
        album: firstString(item, ['album', 'albumName']) ?? '',
        duration: firstNumber(item, ['duration', 'durationMs', 'duration_ms']) ?? 0,
        date: firstString(item, ['year', 'date', 'releaseDate', 'release_date']) ?? '',
        trackNumber: firstString(item, ['trackNumber', 'trackerNumber', 'track_number']) ?? '',
        picUrl,
        fields: fieldResult.fields,
        internal: sanitizeInternal(stringMap(firstObject(item, ['internal']) ?? {})),
        ignoredFields: fieldResult.ignoredFields
      };
    })
    .filter(Boolean);
}

export function parseLyricsCandidates(rawJson, plugin) {
  const root = parseJson(rawJson);
  if (root == null) return [];
  const items = Array.isArray(root)
    ? root
    : firstArray(root, ['items', 'results', 'candidates']) ?? [root];

  return items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const lyrics = parseLyricsResult(JSON.stringify(item));
    if (!lyrics) return null;
    return {
      id: `${plugin.manifest.id}:lyrics:${index}`,
      title: lyrics.tags.ti ?? '',
      artist: lyrics.tags.ar ?? '',
      album: lyrics.tags.al ?? '',
      date: lyrics.tags.date ?? '',
      lyrics
    };
  }).filter(Boolean);
}

export function parseLyricsResult(rawJson) {
  const root = parseJson(rawJson);
  if (root == null) return null;
  if (typeof root === 'string') {
    return root.trim() ? { rawPlainLrc: root, original: [], translated: null, romanization: null, tags: {}, isWordByWord: false } : null;
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  if (root.notFound === true) return null;

  const tags = stringMap(root.tags ?? {});
  const type = normalizeLyricsType(root.type);
  const rawPlainLrc = firstString(root, ['rawPlainLrc', 'raw_plain_lrc', 'plainLrc', 'plain_lrc', 'lrc', 'originalLrc', 'original_lrc']) ?? firstPrimitiveString(root, ['original']) ?? '';
  const rawVerbatimLrc = firstString(root, ['rawVerbatimLrc', 'raw_verbatim_lrc']) ?? '';
  const rawEnhancedLrc = firstString(root, ['rawEnhancedLrc', 'raw_enhanced_lrc']) ?? '';
  const rawTtml = firstString(root, ['rawTtml', 'raw_ttml']) ?? '';
  const rawMultiPersonEnhancedLrc = firstString(root, ['rawMultiPersonEnhancedLrc', 'raw_multi_person_enhanced_lrc']) ?? '';

  if (type !== 'structured') {
    const declaredRaw = {
      rawPlainLrc,
      rawVerbatimLrc,
      rawEnhancedLrc,
      rawTtml,
      rawMultiPersonEnhancedLrc
    }[type];
    if (!declaredRaw) return null;

    return {
      tags,
      original: [],
      translated: null,
      romanization: null,
      type,
      isWordByWord: false,
      rawPlainLrc,
      rawVerbatimLrc,
      rawEnhancedLrc,
      rawTtml,
      rawMultiPersonEnhancedLrc
    };
  }

  const original = parseCompactWordLines(firstArray(root, ['original', 'lines']) ?? []);
  const translated = parseCompactTextLines(firstArray(root, ['translated', 'translation', 'translations']) ?? []);
  const romanization = parseCompactTextLines(firstArray(root, ['romanization', 'romanized', 'roma']) ?? []);
  if (!original.length) return null;

  const result = {
    tags,
    original,
    translated: translated.length ? translated : null,
    romanization: romanization.length ? romanization : null,
    type,
    isWordByWord: original.some(line => line.words.length > 1),
  };

  return result;
}

function normalizeLyricsType(value) {
  switch (String(value ?? 'structured').trim()) {
    case 'rawPlainLrc':
    case 'raw_plain_lrc':
    case 'plainLrc':
    case 'plain_lrc':
    case 'lrc':
      return 'rawPlainLrc';
    case 'rawVerbatimLrc':
    case 'raw_verbatim_lrc':
      return 'rawVerbatimLrc';
    case 'rawEnhancedLrc':
    case 'raw_enhanced_lrc':
      return 'rawEnhancedLrc';
    case 'rawTtml':
    case 'raw_ttml':
    case 'ttml':
      return 'rawTtml';
    case 'rawMultiPersonEnhancedLrc':
    case 'raw_multi_person_enhanced_lrc':
      return 'rawMultiPersonEnhancedLrc';
    case 'structured':
    default:
      return 'structured';
  }
}

export function validateFunctionResult(functionName, rawJson, plugin) {
  const warnings = [];
  const errors = [];
  let parsed = null;

  if (rawJson == null) {
    if (functionName === 'getLyrics') return { parsed: null, warnings, errors };
    errors.push(`${functionName} returned null`);
    return { parsed: null, warnings, errors };
  }

  try {
    const root = parseJson(rawJson);
    if (isDoubleSerializedJson(root)) {
      errors.push(
        `${functionName} returned JSON.stringify(...) instead of a JavaScript value; ` +
        'return the object, array, string, or null directly because the Lyrico host serializes the result'
      );
      return { parsed: null, warnings, errors };
    }
    if (functionName === 'getLyrics') {
      if (plugin.manifest.apiVersion >= 4) {
        parsed = parseLyricsCandidates(rawJson, plugin);
        if (parsed.length === 0) warnings.push('getLyrics returned no usable lyrics candidates');
        validateApi4JudgementFields(parsed, 'lyrics candidate', errors);
      } else {
        parsed = parseLyricsResult(rawJson);
        if (parsed == null) warnings.push('getLyrics returned no usable lyrics');
      }
    } else {
      parsed = parseSongResults(rawJson, plugin, { requireId: functionName === 'searchSongs' });
      if (parsed.length === 0) warnings.push(`${functionName} returned no parseable results`);
      for (const [index, item] of parsed.entries()) {
        if (!item.title) warnings.push(`result[${index}] has empty title`);
        if (!item.artist && functionName === 'searchSongs') warnings.push(`result[${index}] has empty artist`);
        for (const key of Object.keys(item.ignoredFields ?? {})) {
          warnings.push(`result[${index}] ignored unknown fields key "${key}"; platform-private values belong in internal`);
        }
      }
      if (functionName === 'searchCovers' && plugin.manifest.apiVersion >= 4) {
        validateApi4JudgementFields(parsed, 'cover result', errors);
        parsed.forEach((item, index) => {
          if (!item.picUrl) errors.push(`cover result[${index}] is missing cover URL`);
        });
      }
    }
  } catch (error) {
    errors.push(error.message);
  }

  return { parsed, warnings, errors };
}

function isDoubleSerializedJson(root) {
  if (typeof root !== 'string') return false;
  try {
    const nested = JSON.parse(root);
    return nested !== null && typeof nested === 'object';
  } catch {
    return false;
  }
}

function validateApi4JudgementFields(items, label, errors) {
  for (const [index, item] of items.entries()) {
    for (const field of ['title', 'artist', 'album', 'date']) {
      if (!item[field]) errors.push(`${label}[${index}] is missing ${field}`);
    }
  }
}

function sanitizeFields(fields) {
  const accepted = {};
  const ignored = {};
  for (const [key, value] of Object.entries(fields)) {
    if (STANDARD_FIELD_KEYS.has(key) && value.trim()) {
      accepted[key] = value;
    } else if (value.trim()) {
      ignored[key] = value;
    }
  }
  return { fields: accepted, ignoredFields: ignored };
}

function sanitizeInternal(internal) {
  const accepted = {};
  let count = 0;
  for (const [key, value] of Object.entries(internal)) {
    if (!key || key.length > 64 || value.length > 4096 || count >= 64) continue;
    accepted[key] = value;
    count += 1;
  }
  return accepted;
}

function parseJson(rawJson) {
  try {
    return JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`Returned value is not valid JSON: ${error.message}`);
  }
}

function firstArray(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (Array.isArray(obj[key])) return obj[key];
  }
  return null;
}

function firstObject(obj, keys) {
  for (const key of keys) {
    if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) return obj[key];
  }
  return null;
}

function firstString(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      const joined = value.map(item => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') return item.name ?? item.title ?? item.value ?? '';
        return '';
      }).filter(Boolean).join('/');
      if (joined) return joined;
    }
  }
  return null;
}

function firstPrimitiveString(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function firstNumber(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function stringMap(obj) {
  const result = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return result;
  for (const [key, value] of Object.entries(obj)) {
    if (value == null) continue;
    result[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return result;
}

function parseCompactWordLines(lines) {
  return lines
    .filter(Array.isArray)
    .map(line => {
      const start = Number(line[0]);
      const end = Number(line[1]);
      if (!Number.isFinite(start)) return null;
      const wordsValue = line[2];
      const words = Array.isArray(wordsValue)
        ? wordsValue.filter(Array.isArray).map(word => ({
          start: Number.isFinite(Number(word[0])) ? Number(word[0]) : start,
          end: Number.isFinite(Number(word[1])) ? Number(word[1]) : (Number.isFinite(end) ? end : start),
          text: String(word[2] ?? '')
        })).filter(word => word.text)
        : [{ start, end: Number.isFinite(end) ? end : start, text: String(wordsValue ?? '') }].filter(word => word.text);
      return words.length ? { start, end: Number.isFinite(end) ? end : start, words } : null;
    })
    .filter(Boolean);
}

function parseCompactTextLines(lines) {
  return lines
    .filter(Array.isArray)
    .map(line => {
      const start = Number(line[0]);
      const end = Number(line[1]);
      const text = String(line[2] ?? '');
      if (!Number.isFinite(start) || !text) return null;
      return {
        start,
        end: Number.isFinite(end) ? end : start,
        words: [{ start, end: Number.isFinite(end) ? end : start, text }]
      };
    })
    .filter(Boolean);
}
