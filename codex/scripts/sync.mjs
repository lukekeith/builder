#!/usr/bin/env node
// Source changes are evidence for adaptation, never an automatic prose translation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareVersions } from './version.mjs';
export const repository = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const sourcePaths = ['.claude-plugin', 'skills', 'scripts', 'PROJECT.template.md', 'CHANGELOG.md', 'LICENSE', 'LICENSE-THIRD-PARTY.md'];
export const shared = ['manifest.mjs', 'impact.mjs', 'registry.mjs', 'task-brief', 'review-package'];
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const write = (p, value) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n'); };
export const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function packageHash(root) {
  const entries = [];
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), rel = path.relative(root, file).split(path.sep).join('/');
      if (rel === 'upstream.json') continue;
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink()) throw new Error(`Symlink in package: ${rel}`);
      if (st.isDirectory()) visit(file);
      else entries.push([rel, st.mode & 0o777, hash(fs.readFileSync(file))]);
    }
  }
  visit(root); return hash(JSON.stringify(entries));
}
export function planSync(root = repository, ref = 'main') {
  const state = json(path.join(root, 'codex/upstream.json'));
  const target = git(root, 'rev-parse', '--verify', `${ref}^{commit}`);
  const base = git(root, 'rev-parse', '--verify', `${state.commit}^{commit}`);
  git(root, 'merge-base', '--is-ancestor', state.commit, target);
  const upstream = JSON.parse(git(root, 'show', `${target}:.claude-plugin/plugin.json`));
  if (compareVersions(upstream.version, state.version) < 0) throw new Error('Upstream version would downgrade Codex');
  const files = git(root, 'diff', '--name-only', state.commit, target, '--', ...sourcePaths).split('\n').filter(Boolean);
  return { base, target, version: upstream.version, files };
}
export function writePlan(root = repository, ref = 'main') {
  const plan = planSync(root, ref), dir = path.join(root, '.builder/codex-sync', plan.base, plan.target);
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, 'plan.json'), plan);
  const decisions = plan.files.map(file => ({ file, disposition: '', reason: '', evidence: [] }));
  const decisionPath = path.join(dir, 'decisions.json');
  if (!fs.existsSync(decisionPath)) write(decisionPath, { ...plan, decisions });
  fs.writeFileSync(path.join(dir, 'upstream.diff'), git(root, 'diff', plan.base, plan.target, '--', ...sourcePaths) + '\n');
  return { ...plan, directory: dir, decisions: decisionPath };
}
export function copyShared(root = repository, ref = 'main') {
  const plan = planSync(root, ref), updates = [];
  for (const name of shared) {
    const file = `scripts/${name}`;
    if (!plan.files.includes(file)) continue;
    const dest = path.join(root, 'codex', file);
    const before = execFileSync('git', ['-C', root, 'show', `${plan.base}:${file}`]);
    const after = execFileSync('git', ['-C', root, 'show', `${plan.target}:${file}`]);
    const current = fs.readFileSync(dest);
    if (!current.equals(before) && !current.equals(after)) throw new Error(`Shared file has Codex edits: ${file}; adapt explicitly`);
    updates.push({ dest, after, file });
  }
  // Check every conflict before any write.
  for (const item of updates) fs.writeFileSync(item.dest, item.after);
  return updates.map(item => item.file);
}
export function verifySync(root = repository, ref = 'main') {
  const state = json(path.join(root, 'codex/upstream.json'));
  const plan = planSync(root, ref);
  const manifest = json(path.join(root, 'codex/plugin.json'));
  if (plan.files.length || state.version !== plan.version || manifest.version !== plan.version) throw new Error('Codex has not completed adaptation of the selected Claude release; run $sync');
  if (state.packageHash !== packageHash(path.join(root, 'codex'))) throw new Error('Codex package changed since sync verification; rerun sync finish');
  return state;
}
export function finishSync(root = repository, ref = 'main', reportPath) {
  const plan = planSync(root, ref);
  const report = json(reportPath);
  if (report.base !== plan.base || report.target !== plan.target || report.version !== plan.version) throw new Error('Stale sync report: regenerate against the current baseline and source');
  if (!Array.isArray(report.decisions) || report.decisions.length !== plan.files.length) throw new Error('Every upstream file requires one disposition');
  const seen = new Set();
  for (const row of report.decisions) {
    if (!plan.files.includes(row.file) || seen.has(row.file)) throw new Error(`Unexpected/duplicate disposition: ${row.file}`);
    seen.add(row.file);
    if (!['adapted', 'equivalent', 'claude-only'].includes(row.disposition) || typeof row.reason !== 'string' || !row.reason.trim()) throw new Error(`Missing disposition/reason: ${row.file}`);
    if (row.disposition !== 'claude-only') {
      if (!Array.isArray(row.evidence) || !row.evidence.length) throw new Error(`Missing Codex evidence: ${row.file}`);
      for (const evidence of row.evidence) {
        if (typeof evidence !== 'string' || !evidence.startsWith('codex/') || evidence.split('/').includes('..') || !fs.statSync(path.join(root, evidence)).isFile()) throw new Error(`Invalid evidence: ${evidence}`);
      }
    }
  }
  const manifestPath = path.join(root, 'codex/plugin.json');
  const manifest = json(manifestPath), original = fs.readFileSync(manifestPath);
  manifest.version = plan.version; write(manifestPath, manifest);
  try {
    const tests = fs.readdirSync(path.join(root, 'codex/tests')).filter(f => f.endsWith('.test.mjs')).sort().map(f => path.join(root, 'codex/tests', f));
    if (!tests.length) throw new Error('No Codex verification tests found');
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    execFileSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit', env });
    const previous = json(path.join(root, 'codex/upstream.json'));
    const state = { commit: plan.target, version: plan.version, packageHash: packageHash(path.join(root, 'codex')), decisions: plan.files.length ? report.decisions : previous.decisions, verification: 'node --test codex/tests/*.test.mjs' };
    write(path.join(root, 'codex/upstream.json'), state); return state;
  } catch (error) { fs.writeFileSync(manifestPath, original); throw error; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), command = args.shift(); let root = repository, ref = 'main', report;
    while (args.length) {
      const key = args.shift(), val = args.shift();
      if (!val || !['--root', '--ref', '--report'].includes(key)) throw new Error(`Invalid option: ${key}`);
      if (key === '--root') root = path.resolve(val); else if (key === '--ref') ref = val; else report = val;
    }
    const result = command === 'plan' ? writePlan(root, ref) : command === 'copy-shared' ? copyShared(root, ref) : command === 'check' ? verifySync(root, ref) : command === 'finish' && report ? finishSync(root, ref, report) : null;
    if (!result) throw new Error('Usage: sync.mjs plan|copy-shared|check|finish [--root REPO] [--ref main] [--report decisions.json]');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
