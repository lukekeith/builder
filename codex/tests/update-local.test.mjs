import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { vendor, enablePlugin, pluginEnabled } from '../scripts/vendor.mjs';
import { updateLocal } from '../scripts/update-local.mjs';
const put = (root, name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-vendor-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), host = path.join(root, 'host'); fs.mkdirSync(host);
  const git = (...args) => execFileSync('git', ['-C', host, ...args], { encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  put(source, 'plugin.json', { name: 'builder', version: '1.0.0', author: { name: 'Publisher' }, homepage: 'https://publisher.example' });
  for (const name of ['skills/builder/SKILL.md', 'scripts/run.mjs', 'assets/PROJECT.template.md', 'LICENSE', 'LICENSE-THIRD-PARTY.md']) put(source, name, 'runtime\n');
  put(source, 'scripts/vendor.mjs', 'runtime vendor'); put(source, 'skills/sync/SKILL.md', 'maintainer'); put(source, 'scripts/release.mjs', 'maintainer');
  put(host, '.codex/config.toml', 'model = "custom"\n[plugins."other@tools"]\nenabled = true\n');
  put(host, '.codex/builder.md', 'project facts\n'); git('add', '.'); git('commit', '-m', 'host');
  return { root, source, host, git };
}
test('vendor registers runtime, preserves host settings, excludes maintainer metadata, and deletes removed files', t => {
  const { source, host, git } = fixture(t);
  assert.equal(vendor({ host, source, dryRun: true }).status, 'would update (uncommitted)');
  assert.equal(fs.existsSync(path.join(host, 'plugins')), false);
  const result = vendor({ host, source }); assert.equal(result.status, 'updated, uncommitted');
  const dest = result.destination;
  assert.equal(fs.existsSync(path.join(dest, 'skills/sync')), false); assert.equal(fs.existsSync(path.join(dest, 'scripts/release.mjs')), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'plugin.json'))); assert.equal(manifest.homepage, undefined); assert.notEqual(manifest.author.name, 'Publisher');
  const config = fs.readFileSync(path.join(host, '.codex/config.toml'), 'utf8'); assert.match(config, /model = "custom"/); assert.match(config, /other@tools/); assert.match(config, /builder@builder-codex"\]\nenabled = false/);
  assert.equal(fs.readFileSync(path.join(host, '.codex/builder.md'), 'utf8'), 'project facts\n');
  assert.equal(vendor({ host, source, check: true }).status, 'verified');
  git('add', '.'); git('commit', '-m', 'vendor');
  fs.rmSync(path.join(source, 'scripts/run.mjs')); put(source, 'plugin.json', { name: 'builder', version: '1.1.0' });
  vendor({ host, source }); assert.equal(fs.existsSync(path.join(dest, 'scripts/run.mjs')), false);
});
test('vendor refuses local edits, unrelated destinations, traversal and symlinks', t => {
  const { source, host, root, git } = fixture(t), { destination } = vendor({ host, source });
  git('add', '.'); git('commit', '-m', 'vendor');
  put(destination, 'scripts/run.mjs', 'local edits'); put(source, 'scripts/run.mjs', 'new source');
  assert.throws(() => vendor({ host, source }), /locally modified/); assert.equal(fs.readFileSync(path.join(destination, 'scripts/run.mjs'), 'utf8'), 'local edits');
  vendor({ host, source, force: true });
  put(host, '.agents/plugins/marketplace.json', { name: 'host', plugins: [{ name: 'builder', source: { source: 'local', path: './../outside' } }] });
  assert.throws(() => vendor({ host, source }), /inside/);
  put(host, '.agents/plugins/marketplace.json', { name: 'host', plugins: [{ name: 'builder', source: { source: 'local', path: './link' } }] }); fs.symlinkSync(root, path.join(host, 'link'));
  assert.throws(() => vendor({ host, source }), /Symlink/);
  put(host, '.agents/plugins/marketplace.json', { name: 'host', plugins: [{ name: 'builder', source: { source: 'local', path: './unrelated' } }] }); put(host, 'unrelated/notes.txt', 'user work');
  assert.throws(() => vendor({ host, source }), /not an owned|not an owned Codex/);
});
test('TOML edits are idempotent and preserve adjacent sections', () => {
  const before = '[plugins."builder@host"]\n# keep\nenabled = false\n\n[other]\nvalue = 3\n';
  const after = enablePlugin(before, 'builder@host'); assert.match(after, /# keep\nenabled = true/); assert.match(after, /\[other\]\nvalue = 3/); assert.equal(enablePlugin(after, 'builder@host'), after);
});
test('rollout dry run has no CLI mutations; actual install verifies version and stops on refresh failure', t => {
  const { source, host } = fixture(t), calls = [], repos = [{ name: 'host', path: host, mode: 'plugin' }];
  const execute = (cmd, args) => { calls.push(args); return args.includes('add') ? JSON.stringify({ installedPath: source }) : JSON.stringify({ installed: [{ pluginId: 'builder@builder-codex', installed: true, enabled: true, version: '1.0.0' }] }); };
  const opts = { repos, packageRoot: source, execute };
  assert.equal(updateLocal({ ...opts, dryRun: true }).ok, true); assert.deepEqual(calls, [['plugin', 'list', '--json']]); calls.length = 0;
  assert.equal(updateLocal(opts).ok, true); assert.equal(calls.length, 4);
  const stale = () => JSON.stringify({ installed: [{ pluginId: 'builder@builder-codex', installed: true, enabled: true, version: '0.9.0' }] });
  assert.throws(() => updateLocal({ ...opts, execute: stale }), /older than/);
  let ran = 0; assert.throws(() => updateLocal({ ...opts, execute: () => { ran++; throw new Error('refresh failure'); } }), /refresh failure/); assert.equal(ran, 1);
});

test('valid TOML comments and indentation remain valid and disable checks see them', () => {
  const text = '[plugins."builder@builder-codex"] # explanation\n  enabled = false # keep this\n[other]\nvalue = 3\n';
  assert.equal(pluginEnabled(text, 'builder@builder-codex'), false);
  const changed = enablePlugin(text, 'builder@builder-codex');
  assert.match(changed, /  enabled = true # keep this/); assert.equal(changed.split('[plugins.').length, 2);
  assert.equal(enablePlugin(changed, 'builder@builder-codex', false), text);
});
test('dangling host symlinks and remote Builder registrations are rejected without external writes', t => {
  const { source, host, root } = fixture(t), outside = path.join(root, 'outside.toml');
  fs.rmSync(path.join(host, '.codex/config.toml')); fs.symlinkSync(outside, path.join(host, '.codex/config.toml'));
  assert.throws(() => vendor({ host, source }), /Symlink/); assert.equal(fs.existsSync(outside), false);
  fs.rmSync(path.join(host, '.codex/config.toml'));
  put(host, '.agents/plugins/marketplace.json', { name: 'host', plugins: [{ name: 'builder', source: { source: 'remote', id: 'another-builder' } }] });
  assert.throws(() => vendor({ host, source }), /Conflicting Builder/);
});
test('rollout resolves the new installed runtime, never an old session fallback', t => {
  const { root, source, host } = fixture(t), fresh = path.join(root, 'fresh'); fs.cpSync(source, fresh, { recursive: true });
  put(fresh, 'plugin.json', { name: 'builder', version: '1.1.0' }); put(fresh, 'scripts/run.mjs', 'new runtime');
  const execute = (cmd, args) => args.includes('add') ? JSON.stringify({ installedPath: fresh }) : JSON.stringify({ installed: [{ pluginId: 'builder@builder-codex', installed: true, enabled: true, version: '1.1.0', source: { source: 'remote' } }] });
  const result = updateLocal({ repos: [{ name: 'host', path: host, mode: 'vendor' }], execute, packageRoot: source });
  assert.equal(result.ok, true); assert.equal(result.rows[0].version, '1.1.0');
  assert.equal(fs.readFileSync(path.join(result.rows[0].destination, 'scripts/run.mjs'), 'utf8'), 'new runtime');
  assert.throws(() => updateLocal({ repos: [], packageRoot: source, execute: () => JSON.stringify({ installed: [{ pluginId: 'builder@builder-codex', installed: true, enabled: true, version: '1.1.0' }] }) }), /refusing stale/);
});
test('same version with differing selected-source contents cannot install silently', t => {
  const { root, source, host } = fixture(t), market = path.join(root, 'market'), other = path.join(root, 'other');
  fs.mkdirSync(market); fs.cpSync(source, path.join(market, 'codex'), { recursive: true }); fs.cpSync(source, other, { recursive: true }); put(other, 'scripts/run.mjs', 'different runtime');
  put(market, '.agents/plugins/marketplace.json', { name: 'builder-codex', plugins: [{ name: 'builder', source: { source: 'local', path: './codex' } }] });
  const execute = (cmd, args) => args.includes('add') ? JSON.stringify({ installedPath: other }) : JSON.stringify({ installed: [{ pluginId: 'builder@builder-codex', installed: true, enabled: true, version: '1.0.0' }] });
  assert.throws(() => updateLocal({ repos: [{ name: 'host', path: host, mode: 'vendor' }], source: market, packageRoot: source, execute }), /differs from explicitly/);
  assert.equal(fs.existsSync(path.join(host, 'plugins')), false);
});
test('old local marketplace transitions to the published source and restores on failed registration', t => {
  const { source } = fixture(t), calls = []; let adds = 0;
  const execute = (cmd, args) => {
    calls.push(args);
    if (args[1] === 'marketplace' && args[2] === 'add') {
      adds++; if (adds === 1) throw new Error("marketplace 'builder-codex' is already added from a different source");
    }
    if (args[1] === 'marketplace' && args[2] === 'list') return JSON.stringify({ marketplaces: [{ name: 'builder-codex', marketplaceSource: { sourceType: 'local', source: '/old/local/source' } }] });
    if (args[1] === 'add') return JSON.stringify({ installedPath: source });
    return JSON.stringify({ installed: [{ pluginId: 'builder@builder-codex', installed: true, enabled: true, version: '1.0.0' }] });
  };
  assert.equal(updateLocal({ repos: [], packageRoot: source, execute }).ok, true);
  assert.equal(calls.some(a => a.join(' ') === 'plugin marketplace remove builder-codex'), true);
  calls.length = 0; adds = 0;
  const failing = (cmd, args) => {
    if (args[1] === 'marketplace' && args[2] === 'add' && args[3] === 'lukekeith/builder' && adds === 1) { adds++; throw new Error('network unavailable'); }
    return execute(cmd, args);
  };
  assert.throws(() => updateLocal({ repos: [], packageRoot: source, execute: failing }), /previous source restored/);
  assert.equal(calls.some(a => a[2] === 'add' && a[3] === '/old/local/source'), true);
});
test('equivalent quoted TOML forms preserve tables and keys; inline registrations fail closed', () => {
  for (const header of ['["plugins"."builder@host"]', '[plugins . "builder@host"]', "['plugins'.'builder@host']"]) {
    const text = `${header} # keep\n  "enabled" = false # keep\n`;
    const after = enablePlugin(text, 'builder@host');
    assert.equal(after.split('\n').length, text.split('\n').length);
    assert.match(after, /"enabled" = true # keep/);
    assert.equal(enablePlugin(after, 'builder@host', false), text);
  }
  assert.throws(() => enablePlugin('[plugins]\n"builder@host" = { enabled = false }\n', 'builder@host'), /Inline\/dotted/);
});
test('old loaded session check uses the newer installed runtime read-only', t => {
  const { root, source, host, git } = fixture(t), fresh = path.join(root, 'fresh'); fs.cpSync(source, fresh, { recursive: true });
  put(fresh, 'plugin.json', { name: 'builder', version: '1.1.0' }); put(fresh, 'scripts/run.mjs', 'new runtime');
  vendor({ host, source: fresh }); git('add', '.'); git('commit', '-m', 'new vendor');
  const calls = [], execute = (cmd, args) => { calls.push(args); return JSON.stringify({ installed: [{ pluginId: 'builder@builder-codex', installed: true, enabled: true, version: '1.1.0', source: { source: 'local', path: fresh } }] }); };
  const result = updateLocal({ repos: [{ name: 'host', path: host, mode: 'vendor' }], execute, packageRoot: source, check: true });
  assert.equal(result.ok, true); assert.equal(result.rows[0].version, '1.1.0'); assert.deepEqual(calls, [['plugin', 'list', '--json']]);
});
