#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z.-]+))?(?:\+[\da-zA-Z.-]+)?$/;
export function compareVersions(a, b) {
  const x = semver.exec(a), y = semver.exec(b);
  if (!x || !y) throw new Error('Invalid semantic version');
  for (let i = 1; i <= 3; i++) {
    const delta = BigInt(x[i]) - BigInt(y[i]);
    if (delta) return delta > 0n ? 1 : -1;
  }
  if (!x[4] || !y[4]) return x[4] === y[4] ? 0 : x[4] ? -1 : 1;
  const xs = x[4].split('.'), ys = y[4].split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined || ys[i] === undefined) return xs[i] === undefined ? -1 : 1;
    if (xs[i] === ys[i]) continue;
    const xn = /^\d+$/.test(xs[i]), yn = /^\d+$/.test(ys[i]);
    if (xn && yn) return BigInt(xs[i]) > BigInt(ys[i]) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return xs[i] > ys[i] ? 1 : -1;
  }
  return 0;
}
function versionAt(root) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
    return manifest.name === 'builder' && semver.test(manifest.version) && fs.existsSync(path.join(root, 'scripts/lifecycle.mjs')) && fs.existsSync(path.join(root, 'skills/builder/SKILL.md')) ? manifest.version : null;
  } catch { return null; }
}
export function versionReport({ loadedRoot, configDir = path.join(homedir(), '.codex'), knownRoots = [] }) {
  const root = path.resolve(loadedRoot);
  const loaded = versionAt(root);
  if (!loaded) throw new Error('Loaded root is not a valid Codex Builder plugin');
  const family = path.join(path.resolve(configDir), 'plugins/cache/builder-codex/builder');
  let entries = [];
  try { entries = fs.readdirSync(family).map(name => path.join(family, name)); } catch {}
  const installedCopies = entries.map(root => ({ root, version: versionAt(root) })).filter(x => x.version);
  const knownCopies = knownRoots.map(root => ({ root: path.resolve(root), version: versionAt(root) })).filter(x => x.version);
  const newest = copies => copies.map(x => x.version).sort(compareVersions).at(-1) || null;
  const installed = newest(installedCopies);
  const known = newest([...installedCopies, ...knownCopies, { version: loaded }]);
  const lines = [`builder ${loaded} — session-loaded copy: ${root}`, `newest cached Codex Builder: ${installed || 'none found'}`, `newest known local copy: ${known}`];
  if (installed && compareVersions(installed, loaded) > 0) lines.push('A newer copy is cached. Check the enabled installation and start a new Codex session after updating.');
  else if (compareVersions(known, loaded) > 0) lines.push('A newer source copy is available. Update the local Builder plugin installation, then start a new Codex session.');
  else lines.push('No newer local copy found. Remote release status and the enabled installation were not checked.');
  return { loaded, loadedRoot: root, installed, known, installedCopies, knownCopies, text: lines.join('\n') + '\n' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = { knownRoots: [] };
    if (args.includes('--help')) console.log('version.mjs --root LOADED_PLUGIN [--config-dir CODEX_HOME] [--known-root SOURCE_PLUGIN]');
    else {
      while (args.length) {
        const key = args.shift(), value = args.shift();
        if (!value || !['--root', '--config-dir', '--known-root'].includes(key)) throw new Error(`Invalid option: ${key}`);
        if (key === '--known-root') options.knownRoots.push(value);
        else options[key === '--root' ? 'loadedRoot' : 'configDir'] = value;
      }
      if (!options.loadedRoot) throw new Error('--root must name the plugin copy loaded by this session');
      process.stdout.write(versionReport(options).text);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
