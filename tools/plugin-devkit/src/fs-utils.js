import fs from 'node:fs';
import path from 'node:path';

export async function pathExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath) {
  const text = await fs.promises.readFile(filePath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeRelativePath(input) {
  if (typeof input !== 'string') return null;
  if (!input || input.includes('\0') || input.includes('\\')) return null;
  if (input.startsWith('/') || input.startsWith('\\')) return null;
  const parts = input.split('/');
  if (parts.some(part => part === '' || part === '..')) return null;
  return parts.join('/');
}

export function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function collectFiles(root, options = {}) {
  const excluded = options.excluded ?? new Set();
  const files = [];

  async function walk(current) {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (excluded.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  await walk(root);
  return files;
}

export async function directorySize(root) {
  const files = await collectFiles(root);
  let size = 0;
  for (const file of files) {
    size += (await fs.promises.stat(file)).size;
  }
  return size;
}

export function toPosixPath(value) {
  return value.split(path.sep).join('/');
}
