import fs from 'node:fs';
import path from 'node:path';

const TOKEN = /%(?:([1-9][0-9]*)\$)?([sd%])/g;
export function signature(text) {
  if (typeof text !== 'string') throw new Error('Resource values must be strings');
  const result = {};
  let offset = 0, implicit = 0, hasImplicit = false, hasExplicit = false;
  while (true) {
    const start = text.indexOf('%', offset);
    if (start < 0) break;
    TOKEN.lastIndex = start;
    const match = TOKEN.exec(text);
    if (!match || match.index !== start) throw new Error(`Unsupported format at ${start}: ${text}`);
    offset = TOKEN.lastIndex;
    const [, position, type] = match;
    if (type === '%') {
      if (position) throw new Error('Use %% for a literal percent');
      continue;
    }
    const index = position ? (hasExplicit = true, Number(position)) : (hasImplicit = true, ++implicit);
    if (index > 64 || (result[index] && result[index] !== type)) throw new Error('Invalid argument index/type');
    result[index] = type;
  }
  if ((hasExplicit && hasImplicit) || implicit > 1) throw new Error('Multiple arguments require positional placeholders');
  if (Object.keys(result).some((key, i) => Number(key) !== i + 1)) throw new Error('Argument indexes must be contiguous');
  return result;
}

export function format(text, args) {
  const spec = signature(text);
  if (args.length !== Object.keys(spec).length) throw new Error('Incorrect argument count');
  for (const [index, type] of Object.entries(spec)) {
    const value = args[Number(index) - 1];
    if (type === 's' ? typeof value !== 'string' : !Number.isSafeInteger(value)) throw new Error(`Invalid argument ${index} for %${type}`);
  }
  let implicit = 0;
  return text.replace(TOKEN, (_, position, type) => type === '%' ? '%' : String(args[position ? Number(position) - 1 : implicit++]));
}

function script(locale) { return locale.script || locale.maximize().script || ''; }

function displayValues(manifest) {
  return [manifest.name, manifest.description, ...(manifest.configFields ?? []).flatMap(field => [
    field.title, field.summary, field.group,
    ...(field.type === 'markdown' ? [field.defaultValue] : []),
    ...(field.options ?? []).flatMap(option => [option.label, option.summary])
  ])].filter(value => value != null);
}

export function localizeManifest(manifest, strings) {
  return {
    ...manifest,
    name: strings.text(manifest.name),
    description: strings.text(manifest.description ?? ''),
    configFields: (manifest.configFields ?? []).map(field => ({
      ...field,
      title: strings.text(field.title),
      ...(field.summary != null ? { summary: strings.text(field.summary) } : {}),
      groupTitle: strings.text(field.group ?? ''),
      ...(field.type === 'markdown' ? { defaultValue: strings.text(field.defaultValue || field.summary || '') } : {}),
      ...(field.options ? { options: field.options.map(option => ({
        ...option, label: strings.text(option.label),
        ...(option.summary != null ? { summary: strings.text(option.summary) } : {})
      })) } : {})
    }))
  };
}

export async function loadStrings(root, manifest, preferences = ['en']) {
  const references = new Set(displayValues(manifest).filter(value => typeof value === 'string' && value.startsWith('@') && !value.startsWith('@@')).map(value => value.slice(1)));
  if ([...references].some(key => !key.trim())) throw new Error('Empty plugin string reference');
  const spec = manifest.i18n;
  if (!spec) {
    if (references.size) throw new Error('String references require i18n resources');
    return { getLocale: () => 'und', text: value => value.startsWith('@@') ? value.slice(1) : value, t: key => { throw new Error(`Unknown plugin string: ${key}`); } };
  }
  if (references.size && !(manifest.minHostApiVersion >= 4)) throw new Error('String references require minHostApiVersion >= 4');
  const entries = Object.entries(spec.resources ?? {});
  if (!entries.length || entries.length > 64 || !Object.hasOwn(spec.resources, spec.defaultLocale)) throw new Error('Default locale resource is missing or invalid');
  const canonicalRoot = await fs.promises.realpath(root);
  const catalogs = {};
  for (const [tag, relative] of entries) {
    if (new Intl.Locale(tag).toString() !== tag || tag === 'und') throw new Error(`Use a canonical BCP 47 locale: ${tag}`);
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => p === '..' || !p)) throw new Error('Unsafe locale path');
    const file = await fs.promises.realpath(path.resolve(root, relative));
    const inside = path.relative(canonicalRoot, file);
    if (inside.startsWith('..') || path.isAbsolute(inside) || !file.endsWith('.json')) throw new Error('Invalid locale resource');
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > 512 * 1024) throw new Error('Locale resource exceeds 512 KiB or is not a file');
    const values = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    if (!values || Array.isArray(values) || typeof values !== 'object') throw new Error('Expected string dictionary');
    for (const [key, value] of Object.entries(values)) {
      if (!key.trim()) throw new Error('Empty resource key');
      if (typeof value !== 'string') throw new Error('Resource values must be strings');
    }
    catalogs[tag] = values;
  }
  const defaults = catalogs[spec.defaultLocale];
  const formattedKeys = new Set(Object.values(catalogs).flatMap(values => Object.entries(values)
    .filter(([key, value]) => !references.has(key) && /%(?:[1-9][0-9]*\$)?[sd]/.test(value)).map(([key]) => key)));
  for (const [tag, values] of Object.entries(catalogs)) {
    for (const [key, value] of Object.entries(values)) {
      if (!Object.hasOwn(defaults, key) || (formattedKeys.has(key) && JSON.stringify(signature(value)) !== JSON.stringify(signature(defaults[key])))) throw new Error(`${tag}/${key} has missing default or incompatible placeholders`);
    }
  }
  for (const key of references) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`Missing default UI string: ${key}`);
  }
  const available = Object.keys(catalogs).sort();
  let selected;
  for (const preference of preferences) {
    const wanted = new Intl.Locale(preference);
    selected = available.find(tag => tag === wanted.toString()) ?? available.filter(tag => {
      const candidate = new Intl.Locale(tag);
      return candidate.language === wanted.language && script(candidate) === script(wanted);
    }).sort((a, b) => Number(!!new Intl.Locale(a).region) - Number(!!new Intl.Locale(b).region) || (a < b ? -1 : a > b ? 1 : 0))[0];
    if (selected) break;
  }
  selected ??= spec.defaultLocale;
  const locale = new Intl.Locale(selected);
  const parents = [];
  if (locale.region) parents.push([locale.language, locale.script].filter(Boolean).join('-'));
  if (script(new Intl.Locale(locale.language)) === script(locale)) parents.push(locale.language);
  const chain = [...new Set([selected, ...parents, spec.defaultLocale])].map(tag => catalogs[tag]).filter(Boolean);
  const find = key => chain.find(c => Object.hasOwn(c, key))?.[key];
  const lookup = key => {
    const value = find(key);
    if (value === undefined) throw new Error(`Unknown plugin string: ${key}`);
    return value;
  };
  return {
    getLocale: () => selected,
    text: value => value.startsWith('@@') ? value.slice(1) : value.startsWith('@') ? lookup(value.slice(1)) : value,
    t(key, ...args) {
      const text = lookup(key);
      return args.length ? format(text, args) : text;
    }
  };
}
