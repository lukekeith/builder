#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { vendor, pluginEnabled } from './vendor.mjs';
import { packageHash } from './sync.mjs';
import { compareVersions } from './version.mjs';
const ownRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export function defaultRepos(home = os.homedir()) {
  return [['d2m', 'd2m', 'plugin'], ['truesheet', 'fai-cd', 'plugin'], ['finpro', 'finpro', 'vendor'], ['makeready', 'makeready', 'plugin'], ['FAI ERP', 'fai-erp', 'plugin']].map(([name, dir, mode]) => ({ name, path: path.join(home, 'www', dir), mode }));
}
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
export function updateLocal({ repos = defaultRepos(), source = 'lukekeith/builder', dryRun = false, check = false, force = false, execute = run, packageRoot = ownRoot } = {}) {
  for (const repo of repos) if (!repo || typeof repo.name !== 'string' || typeof repo.path !== 'string' || !path.isAbsolute(repo.path) || !['plugin', 'vendor'].includes(repo.mode)) throw new Error('Repos require name, absolute path and plugin/vendor mode');
  let expected = JSON.parse(fs.readFileSync(path.join(packageRoot, 'plugin.json'), 'utf8')).version;
  let catalogRoot = null;
  if (fs.existsSync(source)) {
    catalogRoot = fs.realpathSync(source);
    const catalog = JSON.parse(fs.readFileSync(path.join(catalogRoot, '.agents/plugins/marketplace.json'), 'utf8'));
    const item = catalog.plugins?.find(p => p.name === 'builder');
    if (catalog.name !== 'builder-codex' || item?.source?.path !== './codex') throw new Error('Source must be the Builder Codex marketplace root');
    expected = JSON.parse(fs.readFileSync(path.join(catalogRoot, 'codex/plugin.json'), 'utf8')).version;
  }
  let installResult;
  if (!dryRun && !check) {
    const addArgs = ['plugin', 'marketplace', 'add', source, ...(catalogRoot ? [] : ['--ref', 'main'])];
    try { execute('codex', addArgs); }
    catch (error) {
      if (!String(error.stderr || error.message).includes("marketplace 'builder-codex' is already added from a different source")) throw error;
      const prior = JSON.parse(execute('codex', ['plugin', 'marketplace', 'list', '--json'])).marketplaces?.find(m => m.name === 'builder-codex')?.marketplaceSource;
      if (!prior?.source || prior.sourceType !== 'local') throw new Error('Conflicting marketplace source; remove builder-codex explicitly before switching (automatic rollback requires a known local source)');
      execute('codex', ['plugin', 'marketplace', 'remove', 'builder-codex']);
      try { execute('codex', addArgs); }
      catch (switchError) {
        try { execute('codex', ['plugin', 'marketplace', 'add', prior.source]); }
        catch (restoreError) { throw new Error(`Marketplace switch failed and restoration failed: ${switchError.message}; ${restoreError.message}`); }
        throw new Error(`Marketplace switch failed; previous source restored: ${switchError.message}`);
      }
    }
    if (!catalogRoot) execute('codex', ['plugin', 'marketplace', 'upgrade', 'builder-codex']);
    installResult = JSON.parse(execute('codex', ['plugin', 'add', 'builder@builder-codex', '--json']));
  }
  const installed = JSON.parse(execute('codex', ['plugin', 'list', '--json'])).installed?.find(p => p.pluginId === 'builder@builder-codex' && p.installed);
  let runtimeSource = catalogRoot ? path.join(catalogRoot, 'codex') : packageRoot;
  if (!dryRun && !check) {
    if (!installed?.enabled || compareVersions(installed.version, expected) < 0) throw new Error(`Installed Builder is missing, disabled, or older than expected ${expected}`);
    if (catalogRoot && installed.version !== expected) throw new Error(`Requested ${expected}, installed ${installed.version}`);
    const actual = installResult?.installedPath;
    if (typeof actual !== 'string' || !fs.existsSync(path.join(actual, 'scripts/vendor.mjs'))) throw new Error('Installer did not return a usable runtime package; refusing stale session fallback');
    const actualManifest = JSON.parse(fs.readFileSync(path.join(actual, 'plugin.json'), 'utf8'));
    if (actualManifest.name !== 'builder' || actualManifest.version !== installed.version) throw new Error('Installed runtime identity does not match plugin list');
    if (catalogRoot && packageHash(actual) !== packageHash(path.join(catalogRoot, 'codex'))) throw new Error('Installed runtime differs from explicitly requested source');
    runtimeSource = actual;
  }
  if ((dryRun || check) && !catalogRoot && repos.some(repo => repo.mode === 'vendor')) {
    const cacheRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'plugins/cache/builder-codex/builder', installed?.version || '_missing');
    const choices = [cacheRoot, installed?.source?.source === 'local' ? installed.source.path : null].filter(Boolean);
    const selected = choices.find(candidate => {
      try { const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'plugin.json'), 'utf8')); return manifest.name === 'builder' && manifest.version === installed?.version && fs.existsSync(path.join(candidate, 'scripts/vendor.mjs')); } catch { return false; }
    });
    if (!selected) throw new Error('Installed runtime identity unavailable for read-only vendor check; refusing stale session fallback. Select --source explicitly.');
    runtimeSource = selected;
  }
  const rows = [];
  for (const repo of repos) {
    try {
      if (!fs.existsSync(repo.path)) throw new Error('Repository not found');
      if (repo.mode === 'vendor') {
        const result = vendor({ host: repo.path, source: runtimeSource, dryRun, check, force });
        rows.push({ name: repo.name, ...result });
      } else {
        const catalogPath = path.join(repo.path, '.agents/plugins/marketplace.json');
        const local = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, 'utf8')).plugins?.some(p => p.name === 'builder') : false;
        const configPath = path.join(repo.path, '.codex/config.toml');
        const disabled = fs.existsSync(configPath) && pluginEnabled(fs.readFileSync(configPath, 'utf8'), 'builder@builder-codex') === false;
        const ready = installed?.enabled && compareVersions(installed.version, expected) >= 0 && !disabled;
        rows.push({ name: repo.name, mode: repo.mode, version: installed?.version || 'not installed', status: disabled ? 'global Builder disabled in project config' : local ? 'project Builder marketplace may shadow global install; inspect before use' : ready ? 'uses enabled user install' : `would install/update global Builder to >= ${expected}`, error: Boolean(disabled || (check && (!ready || local))) });
      }
    } catch (error) { rows.push({ name: repo.name, mode: repo.mode, version: '?', status: error.message, error: true }); }
  }
  return { expected, installed: installed?.version || null, source: installed?.source?.path || source, dryRun, check, rows, ok: rows.every(row => !row.error) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    const config = path.join(os.homedir(), '.codex/builder-local.json');
    if (fs.existsSync(config)) options.repos = JSON.parse(fs.readFileSync(config, 'utf8')).repos;
    while (args.length) {
      const key = args.shift();
      if (['--dry-run', '--check', '--force'].includes(key)) options[key === '--dry-run' ? 'dryRun' : key.slice(2)] = true;
      else if (['--source', '--repos'].includes(key) && args.length) {
        const val = args.shift();
        if (key === '--source') options.source = val; else options.repos = JSON.parse(fs.readFileSync(val, 'utf8')).repos;
      } else throw new Error('Usage: update-local.mjs [--dry-run|--check] [--source MARKETPLACE] [--repos JSON] [--force]');
    }
    const result = updateLocal(options);
    console.log(`Builder Codex: ${result.installed || 'not installed'}; requested >= ${result.expected}; ${result.source}`);
    console.table(result.rows.map(({ name, mode, version, status }) => ({ repo: name, mode, version, status })));
    console.log('Open Codex sessions retain their loaded skills; start a new session after updating. Vendor changes remain uncommitted.');
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
