#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ownRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const stringify = value => JSON.stringify(value, null, 2) + '\n';
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
function safePath(root, rel) {
  if (typeof rel !== 'string' || !rel.startsWith('./') || path.isAbsolute(rel) || rel.split('/').includes('..')) throw new Error('Vendor destination must be a ./ path inside the host');
  const result = path.resolve(root, rel);
  if (!result.startsWith(root + path.sep)) throw new Error('Vendor destination escapes the host');
  let cursor = root;
  for (const part of path.relative(root, result).split(path.sep)) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Symlink destination: ${cursor}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}
function digest(dir) {
  const out = [];
  function walk(p) {
    for (const name of fs.readdirSync(p).sort()) {
      const file = path.join(p, name), st = fs.lstatSync(file);
      if (st.isSymbolicLink()) throw new Error('Symlink in vendor copy');
      if (st.isDirectory()) walk(file);
      else out.push([path.relative(dir, file), st.mode & 0o777, fs.readFileSync(file).toString('base64')]);
    }
  }
  walk(dir); return crypto.createHash('sha256').update(JSON.stringify(out)).digest('hex');
}
function dottedKeys(input) {
  const keys = []; let offset = 0;
  while (offset < input.length) {
    const token = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*/y;
    token.lastIndex = offset; const match = token.exec(input);
    if (!match) throw new Error('Unsupported TOML key syntax; refusing configuration rewrite');
    const word = match[1];
    keys.push(word.startsWith('"') ? JSON.parse(word) : word.startsWith("'") ? word.slice(1, -1) : word);
    offset = token.lastIndex;
    if (offset < input.length) { if (input[offset] !== '.') throw new Error('Unsupported TOML key syntax'); offset++; }
  }
  return keys;
}
function pluginSection(text, id) {
  const lines = text.split('\n'), matches = []; let context = [];
  // Multiline strings can contain table-looking content; fail before any host writes.
  if (text.includes('"""') || text.includes("'".repeat(3))) throw new Error('Multiline TOML strings require an explicit configuration edit before vendoring');
  lines.forEach((line, index) => {
    if (/^\s*\[/.test(line)) {
      const header = /^\s*\[([^\n]*)\]\s*(?:#.*)?$/.exec(line);
      if (!header) throw new Error('Unsupported TOML table syntax; refusing configuration rewrite');
      context = dottedKeys(header[1].trim());
      if (context.length === 2 && context[0] === 'plugins' && context[1] === id) matches.push(index);
      return;
    }
    if (/^\s*(?:#|$)/.test(line)) return;
    const assignment = /^\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^=])+?)\s*=/.exec(line);
    if (assignment) {
      const keys = dottedKeys(assignment[1].trim());
      const full = [...context, ...keys];
      if (full[0] === 'plugins' && full[1] === id && context.length !== 2) throw new Error('Inline/dotted plugin registration requires an explicit configuration edit before vendoring');
    }
  });
  if (matches.length > 1) throw new Error(`Duplicate plugin table: ${id}`);
  if (!matches.length) return { lines, start: -1, end: -1, keys: [] };
  const start = matches[0]; let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const keys = [];
  for (let i = start + 1; i < end; i++) {
    const assignment = /^\s*(.*?)\s*=/.exec(lines[i]);
    if (assignment && dottedKeys(assignment[1].trim()).join('.') === 'enabled') keys.push(i);
  }
  if (keys.length > 1) throw new Error(`Duplicate enabled key: ${id}`);
  return { lines, start, end, keys };
}
export function pluginEnabled(text, id) {
  const { lines, keys } = pluginSection(text, id);
  if (!keys.length) return null;
  const key = /=\s*(true|false)\s*(?:#.*)?$/.exec(lines[keys[0]]);
  if (!key) throw new Error(`Unsupported enabled value: ${id}`);
  return key[1] === 'true';
}
export function enablePlugin(text, id, enabled = true) {
  const { lines, start, keys } = pluginSection(text, id);
  if (start < 0) return text + `\n[plugins."${id}"]\nenabled = ${enabled}\n`;
  if (keys.length) {
    pluginEnabled(text, id);
    lines[keys[0]] = lines[keys[0]].replace(/(=\s*)(true|false)/, `$1${enabled}`);
  } else lines.splice(start + 1, 0, `enabled = ${enabled}`);
  return lines.join('\n');
}
export function vendor({ host, source = ownRoot, dryRun = false, check = false, force = false }) {
  host = fs.realpathSync(host); source = fs.realpathSync(source);
  if (git(host, 'rev-parse', '--show-toplevel') !== host) throw new Error('Host must be a Git repository root');
  const manifest = read(path.join(source, 'plugin.json'));
  if (manifest.name !== 'builder' || !fs.existsSync(path.join(source, 'skills/builder/SKILL.md'))) throw new Error('Source is not Codex Builder');
  const catalogPath = safePath(host, './.agents/plugins/marketplace.json');
  const catalog = fs.existsSync(catalogPath) ? read(catalogPath) : { name: path.basename(host).toLowerCase().replace(/[^a-z0-9-]/g, '-') + '-local', plugins: [] };
  if (!Array.isArray(catalog.plugins) || typeof catalog.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(catalog.name)) throw new Error('Invalid host marketplace');
  if (catalog.name === 'builder-codex') throw new Error('Use a host marketplace name, distinct from builder-codex');
  const existing = catalog.plugins.find(p => p.name === 'builder');
  const rel = existing?.source?.source === 'local' ? existing.source.path : './plugins/builder-codex';
  const dest = safePath(host, rel);
  if (dest === source || source.startsWith(dest + path.sep) || dest.startsWith(source + path.sep)) throw new Error('Source and vendor destination overlap');
  const marker = path.join(dest, '.vendor.json');
  if (existing && (existing.source?.source !== 'local' || !fs.existsSync(marker))) throw new Error('Conflicting Builder registration is not an owned Codex vendor copy');
  let receipt;
  if (fs.existsSync(dest)) {
    if (!fs.existsSync(marker)) throw new Error('Existing destination is not an owned Codex vendor copy');
    receipt = read(marker);
    if (receipt.name !== 'builder' || receipt.kind !== 'codex-vendor') throw new Error('Invalid vendor ownership receipt');
  }
  const configPath = safePath(host, './.codex/config.toml');
  const beforeConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  // A vendored copy overrides this global Builder family only in this host.
  let config = enablePlugin(beforeConfig, `builder@${catalog.name}`);
  config = enablePlugin(config, 'builder@builder-codex', false);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-vendor-'));
  try {
    const skip = new Set(['scripts/sync.mjs', 'scripts/sync-version.mjs', 'scripts/release.mjs', 'scripts/update-local.mjs', 'scripts/vendor.mjs', 'skills/sync', 'skills/update-local']);
    function copy(relPath) {
      if (skip.has(relPath)) return;
      const input = path.join(source, relPath), output = path.join(temp, relPath), st = fs.lstatSync(input);
      if (st.isSymbolicLink()) throw new Error(`Symlink source: ${relPath}`);
      if (st.isDirectory()) { fs.mkdirSync(output, { recursive: true }); for (const name of fs.readdirSync(input)) copy(`${relPath}/${name}`); }
      else { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(input, output); fs.chmodSync(output, st.mode & 0o777); }
    }
    for (const relPath of ['skills', 'scripts', 'assets', 'LICENSE', 'LICENSE-THIRD-PARTY.md']) copy(relPath);
    fs.writeFileSync(path.join(temp, 'plugin.json'), stringify({ $schema: manifest.$schema, name: manifest.name, version: manifest.version, description: manifest.description, license: manifest.license, author: { name: catalog.name } }));
    const contentHash = digest(temp);
    fs.writeFileSync(path.join(temp, '.vendor.json'), stringify({ name: 'builder', kind: 'codex-vendor', version: manifest.version, contentHash }));
    const expected = digest(temp), actual = fs.existsSync(dest) ? digest(dest) : null;
    const nextCatalog = structuredClone(catalog);
    const entry = { name: 'builder', source: { source: 'local', path: rel }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' };
    nextCatalog.plugins = [...nextCatalog.plugins.filter(p => p.name !== 'builder'), entry];
    const catalogText = stringify(nextCatalog);
    const same = actual === expected && fs.existsSync(catalogPath) && fs.readFileSync(catalogPath, 'utf8') === catalogText && beforeConfig === config;
    if (check) {
      if (!same) throw new Error('Vendored package or host registration differs from source; update required');
      return { host, mode: 'vendor', version: manifest.version, status: 'verified', destination: dest };
    }
    if (!same && fs.existsSync(dest) && !force) {
      const dirty = git(host, 'status', '--porcelain', '--', rel.slice(2));
      const contents = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-vendor-check-'));
      try {
        fs.cpSync(dest, contents, { recursive: true }); fs.rmSync(path.join(contents, '.vendor.json'));
        if (dirty || digest(contents) !== receipt.contentHash) throw new Error('Skipped — uncommitted or locally modified vendor files; preserve edits before updating (explicit --force to overwrite)');
      } finally { fs.rmSync(contents, { recursive: true, force: true }); }
    }
    if (dryRun || same) return { host, mode: 'vendor', version: manifest.version, status: same ? 'already current' : 'would update (uncommitted)', destination: dest };
    // Stage whole tree first; rollback if host registration cannot be written.
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const backup = dest + `.backup-${process.pid}`;
    if (fs.existsSync(backup)) throw new Error('Vendor backup already exists');
    const hadCatalog = fs.existsSync(catalogPath), oldCatalog = hadCatalog ? fs.readFileSync(catalogPath) : null, hadConfig = fs.existsSync(configPath);
    if (fs.existsSync(dest)) fs.renameSync(dest, backup);
    try {
      fs.cpSync(temp, dest, { recursive: true });
      fs.mkdirSync(path.dirname(catalogPath), { recursive: true }); fs.writeFileSync(catalogPath, catalogText);
      fs.mkdirSync(path.dirname(configPath), { recursive: true }); fs.writeFileSync(configPath, config);
      if (digest(dest) !== expected) throw new Error('Vendor verification failed');
    } catch (error) {
      fs.rmSync(dest, { recursive: true, force: true }); if (fs.existsSync(backup)) fs.renameSync(backup, dest);
      if (hadCatalog) fs.writeFileSync(catalogPath, oldCatalog); else fs.rmSync(catalogPath, { force: true });
      if (hadConfig) fs.writeFileSync(configPath, beforeConfig); else fs.rmSync(configPath, { force: true });
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
    return { host, mode: 'vendor', version: manifest.version, status: 'updated, uncommitted', destination: dest };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), host = args.shift();
    if (!host || args.some(a => !['--dry-run', '--check', '--force'].includes(a))) throw new Error('Usage: vendor.mjs HOST [--dry-run|--check] [--force]');
    console.log(JSON.stringify(vendor({ host: path.resolve(host), dryRun: args.includes('--dry-run'), check: args.includes('--check'), force: args.includes('--force') }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
