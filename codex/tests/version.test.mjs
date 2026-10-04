import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions, versionReport } from '../scripts/version.mjs';
function plugin(root, version) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills/builder'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ name: 'builder', version }));
  fs.writeFileSync(path.join(root, 'scripts/lifecycle.mjs'), '');
  fs.writeFileSync(path.join(root, 'skills/builder/SKILL.md'), '');
}
test('semantic ordering includes numeric prereleases and releases', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.10'), 1);
  assert.equal(compareVersions('1.0.0+build', '1.0.0'), 0);
  assert.throws(() => compareVersions('unknown', '1.0.0'));
});
test('preserves loaded identity and distinguishes cached and source versions without writing', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-version-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const configDir = path.join(base, 'config');
  const loadedRoot = path.join(configDir, 'plugins/cache/builder-codex/builder/0.1.0');
  plugin(loadedRoot, '0.1.0');
  plugin(path.join(configDir, 'plugins/cache/builder-codex/builder/0.2.0'), '0.2.0');
  plugin(path.join(configDir, 'plugins/cache/unrelated/builder/99.0.0'), '99.0.0');
  const source = path.join(base, 'source'); plugin(source, '0.3.0');
  const before = fs.readFileSync(path.join(loadedRoot, 'plugin.json'), 'utf8');
  const report = versionReport({ loadedRoot, configDir, knownRoots: [source, path.join(base, 'missing')] });
  assert.equal(report.loaded, '0.1.0'); assert.equal(report.installed, '0.2.0'); assert.equal(report.known, '0.3.0');
  assert.equal(report.loadedRoot, loadedRoot);
  assert.equal(fs.readFileSync(path.join(loadedRoot, 'plugin.json'), 'utf8'), before);
});
test('rejects invalid loaded copies and does not invent remote knowledge', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-version-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  assert.throws(() => versionReport({ loadedRoot: base, configDir: base }));
  plugin(base, '0.2.0');
  const report = versionReport({ loadedRoot: base, configDir: path.join(base, 'missing') });
  assert.equal(report.installed, null); assert.equal(report.known, '0.2.0');
  assert.match(report.text, /Remote release status.*not checked/);
});
