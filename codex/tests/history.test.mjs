import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendLanding, readHistory } from '../scripts/history.mjs';
const m = { phase: 'merged', name: 'feature', mergedHead: 'abc', targetBranch: 'develop', profile: 'standard' };
test('history preserves actual measurements, target and profile and records a landing once', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-history-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'archive.jsonl');
  const row = appendLanding(file, m, { tasks: 4, metrics: { tokens: { input: 100, output: 50 }, cost: 0.2, lanes: { build: 1000 } } });
  assert.equal(row.target, 'develop'); assert.equal(row.profile, 'standard'); assert.equal(row.cost, 0.2);
  appendLanding(file, m, { tasks: 4 }); assert.equal(readHistory(file).length, 1);
});
test('missing metrics remain unknown and malformed or unlanded records are refused', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-history-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'archive.jsonl');
  assert.throws(() => appendLanding(file, { ...m, phase: 'built' }, { tasks: 1 }), /landed/);
  assert.throws(() => appendLanding(file, m, { tasks: 1, metrics: { cost: -1 } }), /measured/);
  const row = appendLanding(file, m, { tasks: 1 }); assert.equal(row.tokens, null); assert.equal(row.cost, null);
  fs.appendFileSync(file, 'broken\n'); assert.throws(() => readHistory(file), /row 2/);
});

test('record reads plan size from landed commit after cleanup on another checkout branch', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-history-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, 'seed'), 'seed'); git('add', '.'); git('commit', '-m', 'seed'); git('branch', 'other');
  fs.mkdirSync(path.join(root, 'docs/features/feature'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/features/feature/PLAN.md'), '### Task 1\nA\n### Task 2\nB\n');
  git('add', '.'); git('commit', '-m', 'land'); const mergedHead = git('rev-parse', 'HEAD'); git('checkout', 'other');
  const metadataDir = path.join(root, '.git/builder-codex/features'); fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(path.join(metadataDir, 'feature.json'), JSON.stringify({ ...m, mergedHead, originRoot: root, registry: 'docs/features', cleaned: true }));
  const output = execFileSync(process.execPath, [new URL('../scripts/history.mjs', import.meta.url).pathname, 'record', 'feature', '--root', root], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).size.tasks, 2); assert.equal(git('branch', '--show-current'), 'other');
});
