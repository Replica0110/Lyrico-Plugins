import fs from 'node:fs';
import path from 'node:path';
import { collectFiles, normalizeRelativePath, toPosixPath } from './fs-utils.js';
import { loadManifest } from './manifest.js';

export async function loadPlugin(pluginRoot) {
  const root = path.resolve(pluginRoot);
  const manifest = await loadManifest(root);
  const scriptParts = [];
  const files = [];

  for (const includeDir of manifest.includeDirs ?? []) {
    const normalized = normalizeRelativePath(includeDir);
    if (!normalized) continue;
    const includeRoot = path.join(root, normalized);
    const includeFiles = (await collectFiles(includeRoot))
      .filter(file => file.endsWith('.js'))
      .sort((a, b) => toPosixPath(path.relative(includeRoot, a)).localeCompare(toPosixPath(path.relative(includeRoot, b))));

    for (const file of includeFiles) {
      const relative = toPosixPath(path.relative(root, file));
      files.push(relative);
      scriptParts.push(`\n//# sourceURL=${relative}\n`);
      scriptParts.push(await fs.promises.readFile(file, 'utf8'));
      scriptParts.push('\n');
    }
  }

  const entry = normalizeRelativePath(manifest.entry ?? 'source.js') ?? 'source.js';
  const entryPath = path.join(root, entry);
  files.push(entry);
  scriptParts.push(`\n//# sourceURL=${entry}\n`);
  scriptParts.push(await fs.promises.readFile(entryPath, 'utf8'));
  scriptParts.push('\n');

  return {
    root,
    manifest,
    script: scriptParts.join(''),
    files
  };
}
