import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root ?? '.');
const devkit = path.resolve(args.devkit ?? '../Lyrico/tools/plugin-devkit/src/cli.js');
const outDir = path.resolve(args.out ?? 'dist/plugins');
const importableOutDir = args.importableOut
  ? path.resolve(args.importableOut)
  : null;
const keyword = String(args.keyword ?? process.env.LYRICO_PLUGIN_TEST_KEYWORD ?? '晴天');
const pageSize = String(args.pageSize ?? process.env.LYRICO_PLUGIN_TEST_PAGE_SIZE ?? '1');

await ensureFile(devkit, 'Plugin devkit CLI');
const plugins = await discoverPlugins(root);
if (plugins.length === 0) {
  throw new Error(`No plugin manifest found under ${root}`);
}

await fs.promises.mkdir(outDir, { recursive: true });
if (importableOutDir) {
  await fs.promises.rm(importableOutDir, { recursive: true, force: true });
  await fs.promises.mkdir(importableOutDir, { recursive: true });
}
for (const plugin of plugins) {
  const rel = path.relative(root, plugin.root) || '.';
  const output = path.join(outDir, `${plugin.manifest.id}-${plugin.manifest.versionName}.zip`);
  console.log(`\n== ${plugin.manifest.name} (${rel}) ==`);
  await run('node', [devkit, 'validate', plugin.root]);
  await run('node', [devkit, 'pack', plugin.root, '--out', output]);
  if (importableOutDir) {
    await copyDir(plugin.root, path.join(importableOutDir, rel));
  }
  await run('node', [
    devkit,
    'test',
    plugin.root,
    'searchSongs',
    '--keyword',
    keyword,
    '--page-size',
    pageSize
  ]);
}

console.log(`\nChecked and packed ${plugins.length} plugins into ${outDir}`);
if (importableOutDir) {
  console.log(`Prepared importable plugin artifact contents in ${importableOutDir}`);
}

async function discoverPlugins(searchRoot) {
  const manifestPaths = [];
  await walk(searchRoot, async (entry, fullPath) => {
    if (entry.isFile() && entry.name === 'manifest.json') manifestPaths.push(fullPath);
  });

  const plugins = [];
  const seenIds = new Map();
  for (const manifestPath of manifestPaths.sort()) {
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    const pluginRoot = path.dirname(manifestPath);
    if (seenIds.has(manifest.id)) {
      throw new Error(`Duplicate plugin id ${manifest.id}: ${seenIds.get(manifest.id)} and ${pluginRoot}`);
    }
    seenIds.set(manifest.id, pluginRoot);
    plugins.push({ root: pluginRoot, manifest });
  }
  return plugins;
}

async function walk(dir, onEntry) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (shouldSkip(entry.name)) continue;
    await onEntry(entry, fullPath);
    if (entry.isDirectory()) await walk(fullPath, onEntry);
  }
}

function shouldSkip(name) {
  return new Set(['.git', '.github', 'dist', '.release-staging', 'node_modules']).has(name);
}

async function copyDir(from, to) {
  await fs.promises.mkdir(to, { recursive: true });
  const entries = await fs.promises.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (shouldSkip(entry.name)) continue;
    if (entry.isDirectory()) await copyDir(source, target);
    else if (entry.isFile()) await fs.promises.copyFile(source, target);
  }
}

async function ensureFile(file, label) {
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new Error(`${label} not found: ${file}`);
}

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${commandArgs.join(' ')} exited with ${code}`));
    });
  });
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const next = rawArgs[i + 1];
    parsed[key] = next && !next.startsWith('--') ? next : true;
    if (parsed[key] === next) i++;
  }
  return parsed;
}
