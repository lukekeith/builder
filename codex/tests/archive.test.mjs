// $builder archive (codex/scripts/archive.mjs) — Claude 5.4's /builder:archive adapted to Codex:
// a feature landed through the merge queue (`Merge builder feature <name>`) is shipped; one merged
// by hand is closed, never called shipped; a live Codex feature record is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withHeader } from '../scripts/archive.mjs';
import { archivedOutcome } from '../scripts/registry.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'archive.mjs');
const REG = 'docs/features';
const DAY = 86400000;

const git = (root, args, env = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const archive = (root, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, BUILDER_TODAY: '2026-10-27' } });
const text = (root, p) => readFileSync(join(root, p), 'utf8');
const SPEC = n => `# ${n} — spec\n> md · no ticket\n\n## Idea\nx\n`;

function commit(root, files, daysAgo, msg) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, REG, p)), { recursive: true });
    writeFileSync(join(root, REG, p), body);
  }
  const when = new Date(Date.now() - daysAgo * DAY).toISOString();
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', msg], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
}

function repo(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-arch-')));
  t.after(() => execFileSync('rm', ['-rf', root]));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  mkdirSync(join(root, '.codex'));
  writeFileSync(join(root, '.codex/builder.md'), '---\nproject: t\nregistry: docs/features\nbase_branch: main\napps:\n  - name: app\n    path: app/\n    role: app\n---\n');
  writeFileSync(join(root, '.gitignore'), '.builder/\n');
  return root;
}

/** A feature landed the way lifecycle.mjs deliver lands it: a --no-ff merge commit `Merge builder feature <name>`. */
function landed(root, name, daysAgo) {
  const when = new Date(Date.now() - daysAgo * DAY).toISOString();
  const env = { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  git(root, ['switch', '-q', '-c', `builder/${name}`]);
  commit(root, { [`${name}/MANIFEST.md`]: 'size: md\nphase: signed-off\nstate: signed-off\nnext: "Deliver"\n', [`${name}/SPEC.md`]: SPEC(name), [`${name}/PLAN.md`]: 'plan\n', [`${name}/ledger.md`]: 'ledger\n', [`${name}/continue.md`]: 'c\n' }, daysAgo, `feat(${name}): built`);
  git(root, ['switch', '-q', 'main']);
  git(root, ['merge', '-q', '--no-ff', '-m', `Merge builder feature ${name}`, `builder/${name}`], env);
  git(root, ['branch', '-q', '-D', `builder/${name}`]);
}

function fixture(t) {
  const root = repo(t);
  commit(root, {
    's/MANIFEST.md': 'size: md\nstate: shipped\n',
    's/SPEC.md': SPEC('s'),
    's/PLAN.md': 'plan\n',
    'm/MANIFEST.md': 'size: md\nstate: built\n',
    'm/SPEC.md': SPEC('m'),
    'm/PLAN.md': 'plan\n',
    'a/MANIFEST.md': 'size: md\nstate: planned\n',
    'a/SPEC.md': SPEC('a'),
    'a/PLAN.md': 'plan\n',
    'l/01-notes.md': 'notes\n',
    '_archive/old/SPEC.md': '# old — spec\n> ✅ SHIPPED 2026-09-01 — merged abc\n',
    '_archive/old/PLAN.md': 'left behind\n',
  }, 100, 'old work');
  landed(root, 'q', 2);
  commit(root, { 'r/MANIFEST.md': 'size: md\nstate: built\n', 'r/SPEC.md': SPEC('r'), 'f/MANIFEST.md': 'size: md\nstate: building\n', 'f/SPEC.md': SPEC('f') }, 1, 'recent work');
  for (const n of ['old', 'f']) mkdirSync(join(root, '.builder', n), { recursive: true });
  // The archived record is newer than nothing in .builder/old: written after it.
  writeFileSync(join(root, REG, '_archive/old/SPEC.md'), text(root, `${REG}/_archive/old/SPEC.md`));
  return root;
}

test('plan: landed and shipped are finished, a hand merge is closed, abandoned and legacy only on request, in-flight left alone', t => {
  const root = fixture(t);
  const r = archive(root, 'plan', '--json');
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.deepEqual(Object.fromEntries(p.items.map(i => [i.path, `${i.tier}/${i.action}`])), {
    [`${REG}/a`]: 'old/drop',
    [`${REG}/l`]: 'old/move',
    [`${REG}/m`]: 'finished/close',
    [`${REG}/q`]: 'finished/ship',
    [`${REG}/s`]: 'finished/archive',
    [`${REG}/_archive/old`]: 'finished/trim',
    '.builder/old': 'finished/workspace',
  });
  assert.match(p.items.find(i => i.name === 'q').why, /landed on main through the merge queue/);
  const left = Object.fromEntries(p.left.map(l => [l.name, l.why]));
  assert.match(left.r, /built, last moved .* still in hand/);
  assert.match(left.f, /building — in flight/);
  const md = archive(root, 'plan');
  assert.match(md.stdout, /\*\*Finished\*\* — archived on your go-ahead/);
  assert.match(md.stdout, /\| docs\/features\/m \| Merged, never verified — close as is: built and in main with no landing of record; never verified \| CLOSED — merged [0-9a-f]+, not walked \|/);
  assert.equal(archive(root, 'plan', '--summary').stdout.trim(), 'registry: 5 finished · 2 old to archive → $builder archive');
});

test('apply: one commit — each keeps only its SPEC under its header in _archive; a landed feature is SHIPPED with its merge sha', t => {
  const root = fixture(t);
  const before = Number(git(root, ['rev-list', '--count', 'HEAD']));
  const merge = git(root, ['log', '-1', '--format=%h', '--grep=Merge builder feature q']);
  const r = archive(root, 'apply', 'q', `${REG}/s`, 'm', 'old', '.builder/old');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(Number(git(root, ['rev-list', '--count', 'HEAD'])), before + 1, 'one commit');
  assert.match(git(root, ['log', '-1', '--format=%s']), /^docs\(archive\): 4 folders — q, s, m, old$/);
  assert.equal(git(root, ['status', '--porcelain']), '');
  assert.deepEqual(git(root, ['ls-files', `${REG}/_archive`]).split('\n').sort(), [`${REG}/_archive/m/SPEC.md`, `${REG}/_archive/old/SPEC.md`, `${REG}/_archive/q/SPEC.md`, `${REG}/_archive/s/SPEC.md`]);
  assert.deepEqual(text(root, `${REG}/_archive/q/SPEC.md`).split('\n').slice(0, 3), ['# q — spec', `> ✅ SHIPPED 2026-10-27 — merged ${merge}`, '> md · no ticket']);
  assert.match(text(root, `${REG}/_archive/m/SPEC.md`).split('\n')[1], /^> ✅ CLOSED 2026-10-27 — merged [0-9a-f]+, not walked$/);
  assert.match(text(root, `${REG}/_archive/s/SPEC.md`).split('\n')[1], /^> ✅ SHIPPED 2026-10-27 — merged [0-9a-f]+$/);
  assert.equal(existsSync(join(root, '.builder/old')), false);
  assert.ok(existsSync(join(root, '.builder/f')), 'an in-flight workspace stays');
  assert.equal(archive(root, 'plan', '--summary').stdout.trim(), 'registry: 2 old to archive → $builder archive');
});

test('apply the old tier: abandoned gets DROPPED, no SPEC moves whole; --drop name=reason drops an in-flight one in the same commit', t => {
  const root = fixture(t);
  const before = Number(git(root, ['rev-list', '--count', 'HEAD']));
  const r = archive(root, 'apply', 'a', 'l', 'f', '--drop', 'f=superseded by g');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(Number(git(root, ['rev-list', '--count', 'HEAD'])), before + 1);
  assert.match(text(root, `${REG}/_archive/a/SPEC.md`).split('\n')[1], /^> ✖ DROPPED 2026-10-27 — no activity since \d{4}-\d\d-\d\d$/);
  assert.equal(existsSync(join(root, REG, '_archive/a/PLAN.md')), false);
  assert.ok(existsSync(join(root, REG, '_archive/l/01-notes.md')));
  assert.match(text(root, `${REG}/_archive/f/SPEC.md`).split('\n')[1], /^> ✖ DROPPED 2026-10-27 — superseded by g$/);
  assert.equal(existsSync(join(root, '.builder/f')), false);
});

test('apply refuses off the target, with registry changes uncommitted, and a name it left alone; nothing is touched', t => {
  const root = fixture(t);
  writeFileSync(join(root, REG, 'f/SPEC.md'), 'edited\n');
  const dirty = archive(root, 'apply', 's');
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /uncommitted changes under docs\/features — commit them or set them aside first\. Nothing was changed\./);
  git(root, ['checkout', '--', REG]);
  git(root, ['switch', '-q', '-c', 'other']);
  const off = archive(root, 'apply', 's');
  assert.equal(off.status, 1);
  assert.match(off.stdout, /archive runs on main/);
  git(root, ['switch', '-q', 'main']);
  const r = archive(root, 'apply', 'r', 's');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /✗ r — left alone: built, last moved/);
  assert.match(r.stdout, /✓ s — archived/);
  assert.ok(existsSync(join(root, REG, 'r/MANIFEST.md')));
});

test('a feature with a live Codex runtime record is never touched, even when asked to drop it', t => {
  const root = fixture(t);
  const wt = join(root, '..', `${root.split('/').pop()}-wt`);
  git(root, ['worktree', 'add', '-q', '-b', 'builder/a', wt]);
  t.after(() => execFileSync('rm', ['-rf', wt]));
  const features = join(root, '.git', 'builder-codex', 'features');
  mkdirSync(features, { recursive: true });
  writeFileSync(join(features, 'a.json'), JSON.stringify({ name: 'a', phase: 'planned', worktree: wt }));
  const p = JSON.parse(archive(root, 'plan', '--json').stdout);
  assert.equal(p.items.find(i => i.name === 'a'), undefined);
  assert.match(p.left.find(l => l.name === 'a').why, /a live feature \(planned, worktree .*\) — resume it, or clean it up first/);
  const r = archive(root, 'apply', 'a', '--drop', 'a=gone');
  assert.equal(r.status, 1);
  assert.ok(existsSync(join(root, REG, 'a/SPEC.md')));
});

test('apply puts back a folder that fails half-way — header and trims undone, nothing committed', t => {
  const root = repo(t);
  commit(root, { 'm/MANIFEST.md': 'size: md\nstate: built\n', 'm/SPEC.md': SPEC('m'), 'm/PLAN.md': 'plan\n' }, 100, 'old work');
  mkdirSync(join(root, REG, '_archive'));
  chmodSync(join(root, REG, '_archive'), 0o555);
  const before = git(root, ['rev-parse', 'HEAD']);
  let r;
  try { r = archive(root, 'apply', 'm'); } finally { chmodSync(join(root, REG, '_archive'), 0o755); }
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /✗ m — .* — put back as it was/);
  assert.equal(git(root, ['rev-parse', 'HEAD']), before, 'nothing committed');
  assert.equal(git(root, ['status', '--porcelain']), '');
  assert.equal(text(root, `${REG}/m/SPEC.md`), SPEC('m'));
  assert.ok(existsSync(join(root, REG, 'm', 'PLAN.md')));
});

test('a program whose children all ended is offered; one dropped child makes it CLOSED-or-SHIPPED by the tally', t => {
  const root = repo(t);
  commit(root, {
    'p/MANIFEST.md': 'tier: program\nchild: c1\nchild: c2\n',
    'p/PROGRAM.md': '# p — program\n> xl\n',
    '_archive/c1/SPEC.md': '# c1 — spec\n> ✅ SHIPPED 2026-09-01 — merged abc\n',
    'c2/MANIFEST.md': 'size: md\nstate: building\n',
    'c2/SPEC.md': SPEC('c2'),
  }, 100, 'old work');
  let p = JSON.parse(archive(root, 'plan', '--json').stdout);
  assert.match(p.left.find(l => l.name === 'p').why, /a program — 1 of its 2 children not archived yet/);
  assert.equal(archive(root, 'apply', 'c2', '--drop', 'c2=folded into c1').status, 0);
  p = JSON.parse(archive(root, 'plan', '--json').stdout);
  assert.equal(p.items.find(i => i.name === 'p')?.action, 'program');
  const a = archive(root, 'apply', 'p');
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.equal(text(root, `${REG}/_archive/p/PROGRAM.md`).split('\n')[1], '> ✅ SHIPPED 2026-10-27 — every child ended: 1 shipped, 1 dropped');
  assert.equal(existsSync(join(root, REG, '_archive/p/MANIFEST.md')), false);
});

test('a row named by its path takes its --drop reason; a dropped folder with no SPEC gets one, so it never reads as shipped', t => {
  const root = repo(t);
  commit(root, { 'a/MANIFEST.md': 'size: md\nstate: spec\n', 'a/SPEC.md': SPEC('a'), 'b/MANIFEST.md': 'size: md\nstate: exploring\n' }, 100, 'old work');
  commit(root, { 'f/MANIFEST.md': 'size: md\nstate: building\n', 'f/SPEC.md': SPEC('f') }, 1, 'recent');
  const r = archive(root, 'apply', `${REG}/a`, `${REG}/b`, `${REG}/f`, '--drop', 'a=superseded', '--drop', 'f=folded into a');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(text(root, `${REG}/_archive/a/SPEC.md`).split('\n')[1], '> ✖ DROPPED 2026-10-27 — superseded');
  assert.equal(text(root, `${REG}/_archive/f/SPEC.md`).split('\n')[1], '> ✖ DROPPED 2026-10-27 — folded into a');
  assert.match(text(root, `${REG}/_archive/b/SPEC.md`), /^# b\n> ✖ DROPPED 2026-10-27 — no activity since /);
  assert.equal(archivedOutcome(root, REG, 'b'), 'dropped');
});

test('a name reused for new work is not the feature that once landed under it', t => {
  const root = repo(t);
  commit(root, { 'README.md': 'x\n' }, 300, 'init');
  landed(root, 'q', 200);
  git(root, ['rm', '-rq', `${REG}/q`]);
  commit(root, { 'q/MANIFEST.md': 'size: md\nstate: spec\n', 'q/SPEC.md': SPEC('q') }, 1, 'q again');
  const p = JSON.parse(archive(root, 'plan', '--json').stdout);
  assert.equal(p.items.find(i => i.name === 'q'), undefined);
  assert.match(p.left.find(l => l.name === 'q').why, /spec — in flight/);
});

test('a workspace with anything newer than the archived record is a reused name, never a leftover', t => {
  const root = repo(t);
  commit(root, { '_archive/x/SPEC.md': '# x — spec\n> ✅ SHIPPED 2026-09-01 — merged abc\n' }, 100, 'old work');
  mkdirSync(join(root, '.builder/x'), { recursive: true });
  const past = new Date(Date.now() - 10 * DAY);
  utimesSync(join(root, REG, '_archive/x/SPEC.md'), past, past);
  writeFileSync(join(root, '.builder/x/brainstorm.md'), 'a new conversation\n');
  const p = JSON.parse(archive(root, 'plan', '--json').stdout);
  assert.equal(p.items.find(i => i.path === '.builder/x'), undefined);
  utimesSync(join(root, '.builder/x/brainstorm.md'), new Date(past - DAY), new Date(past - DAY));
  assert.equal(JSON.parse(archive(root, 'plan', '--json').stdout).items.find(i => i.path === '.builder/x')?.action, 'workspace');
});

test('the header goes directly under the title, joining a header block already there', () => {
  assert.equal(withHeader('# x\n> md\n\nbody\n', '> H'), '# x\n> H\n> md\n\nbody\n');
  assert.equal(withHeader('# x\nbody\n', '> H'), '# x\n> H\n\nbody\n');
  assert.equal(withHeader('no title\n', '> H'), null);
});
