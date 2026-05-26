import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root ?? '.');
const devkit = path.resolve(args.devkit ?? '../Lyrico/tools/plugin-devkit/src/cli.js');
const outDir = path.resolve(args.out ?? 'dist/release');
const stagingRoot = path.resolve(args.staging ?? '.release-staging/Lyrico-Plugins');

await ensureFile(devkit, 'Plugin devkit CLI');
const { writeZipFromDirectory } = await import(pathToFileURL(path.join(path.dirname(devkit), 'zip.js')));
const plugins = await discoverPlugins(root);
if (plugins.length === 0) {
  throw new Error(`No plugin manifest found under ${root}`);
}

await fs.promises.rm(outDir, { recursive: true, force: true });
await fs.promises.rm(path.dirname(stagingRoot), { recursive: true, force: true });
await fs.promises.mkdir(outDir, { recursive: true });
await fs.promises.mkdir(stagingRoot, { recursive: true });

const assets = [];
for (const plugin of plugins) {
  const rel = path.relative(root, plugin.root) || path.basename(plugin.root);
  const output = path.join(outDir, `${plugin.manifest.id}-${plugin.manifest.versionName}.zip`);
  console.log(`Packing ${plugin.manifest.name} from ${rel}`);
  await run('node', [devkit, 'pack', plugin.root, '--out', output]);
  await copyDir(plugin.root, path.join(stagingRoot, rel));
  assets.push(path.basename(output));
}

const allPluginsZip = path.join(outDir, 'Lyrico-Plugins.zip');
const result = await writeZipFromDirectory(stagingRoot, allPluginsZip);
assets.push(path.basename(allPluginsZip));

await fs.promises.writeFile(
  path.join(outDir, 'release-manifest.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    plugins: plugins.map(plugin => ({
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      versionCode: plugin.manifest.versionCode,
      versionName: plugin.manifest.versionName,
      root: path.relative(root, plugin.root).replaceAll(path.sep, '/')
    })),
    assets
  }, null, 2)
);

await fs.promises.rm(path.dirname(stagingRoot), { recursive: true, force: true });
console.log(`Packed ${plugins.length} plugin zips and ${result.entries} all-plugin entries into ${outDir}`);

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
