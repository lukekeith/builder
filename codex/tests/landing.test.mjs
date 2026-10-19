import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../scripts/lifecycle.mjs';
import { parseWalkReadiness, landedMigrations } from '../scripts/landing.mjs';

const BODY = [
  '## Quality gates', '', '```', 'x: y', '```', '',
  '## Walk readiness', '', '```',
  'migrations: packages/db/prisma/migrations',
  'status:     npx prisma migrate status   # against the DEV db',
  'apply:      npm run db:migrate',
  'apply_mode: agent       # owner: just run it',
  'regenerate: npm run db:generate',
  '```', '', '- prose', '', '## Global constraints', '',
].join('\n');

test('parseWalkReadiness reads the fenced block under Walk readiness, comments and placeholders dropped', () => {
  assert.deepEqual(parseWalkReadiness(BODY), { migrations: 'packages/db/prisma/migrations', status: 'npx prisma migrate status', apply: 'npm run db:migrate', apply_mode: 'agent', regenerate: 'npm run db:generate' });
  assert.deepEqual(parseWalkReadiness('## Other\n'), {});
  assert.deepEqual(parseWalkReadiness('## Walk readiness\n\nprose only\n'), {});
  assert.equal(parseWalkReadiness(BODY.replace('apply:      npm run db:migrate', 'apply:      <command>')).apply, undefined);
});

test('landedMigrations: none, additive under agent, destructive, ask/human, no apply, unchecked target', () => {
  const r = parseWalkReadiness(BODY);
  assert.deepEqual(landedMigrations({ files: [], readiness: r }), { action: 'none' });
  assert.deepEqual(landedMigrations({ files: [{ path: 'm/1.sql', text: 'ALTER TABLE "A" ADD COLUMN "b" TEXT;' }], readiness: r }), { action: 'apply', commands: ['npm run db:migrate', 'npm run db:generate'] });
  for (const text of ['DROP TABLE "A";', 'ALTER TABLE "A" DROP COLUMN "b";', 'DELETE FROM "A";', 'TRUNCATE "A";', 'ALTER TABLE "A" RENAME COLUMN "b" TO "c";']) {
    const x = landedMigrations({ files: [{ path: 'm/1.sql', text }], readiness: r });
    assert.equal(x.action, 'note', text); assert.match(x.why, /drops or rewrites data/); assert.match(x.why, /npm run db:migrate/);
  }
  const files = [{ path: 'm/1.sql', text: 'CREATE TABLE "A" ();' }];
  for (const mode of ['ask', 'human', undefined]) {
    const x = landedMigrations({ files, readiness: { ...r, apply_mode: mode } });
    assert.equal(x.action, 'note'); assert.match(x.why, /1 new migration landed — the dev DB is behind: run `npm run db:migrate`, then `npm run db:generate`/);
  }
  assert.match(landedMigrations({ files, readiness: { migrations: 'm' } }).why, /no `apply:` command/);
  const away = landedMigrations({ files, readiness: r, checkedOut: false, target: 'work' });
  assert.equal(away.action, 'note'); assert.match(away.why, /work, which is checked out nowhere — when you switch to it/);
});

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo(t, mode, apply = `node -e "require('fs').writeFileSync('applied.txt','yes')"`) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-landing-'));
  const root = path.join(folder, 'repo'); fs.mkdirSync(root);
  git(root, 'init', '-b', 'work'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Fixture');
  fs.mkdirSync(path.join(root, '.builder'));
  fs.writeFileSync(path.join(root, '.builder/config.md'), `---\napps:\n  - name: app\n    path: app\n---\n\n## Walk readiness\n\n\`\`\`\nmigrations: db/migrations\napply:      ${apply}\napply_mode: ${mode}   # test\nregenerate: node -e "require('fs').writeFileSync('regenerated.txt','yes')"\n\`\`\`\n`);
  fs.writeFileSync(path.join(root, '.gitignore'), 'applied.txt\nregenerated.txt\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'seed');
  t.after(() => fs.rmSync(folder, { recursive: true, force: true })); return root;
}
async function land(root, sql = 'CREATE TABLE "a" ();', { away = false } = {}) {
  const m = await run('start', 'mig', { root });
  fs.mkdirSync(path.join(m.worktree, 'db/migrations/001'), { recursive: true });
  fs.writeFileSync(path.join(m.worktree, 'db/migrations/001/migration.sql'), sql);
  git(m.worktree, 'add', '.'); git(m.worktree, 'commit', '-m', 'a migration');
  await run('checkpoint', 'mig', { root, phase: 'verified', next: 'Prepare', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') });
  const p = await run('prepare', 'mig', { root });
  if (away) git(root, 'checkout', '-q', '-b', 'elsewhere');
  return run('deliver', 'mig', { root, verifiedHead: p.candidateHead });
}

test('delivery applies an additive landed migration in the target checkout under apply_mode agent, then regenerates', async t => {
  const root = repo(t, 'agent'); const d = await land(root);
  assert.equal(d.phase, 'merged');
  assert.equal(d.landing.action, 'applied'); assert.deepEqual(d.landing.migrations, ['db/migrations/001/migration.sql']);
  assert.equal(fs.readFileSync(path.join(root, 'applied.txt'), 'utf8'), 'yes');
  assert.ok(fs.existsSync(path.join(root, 'regenerated.txt')), 'regenerate ran after apply');
  assert.equal(d.nextAction, 'Optional explicit cleanup');
});

test('ask mode and destructive migrations are noted with the exact command, never run', async t => {
  const ask = repo(t, 'ask'); const a = await land(ask);
  assert.equal(a.landing.action, 'note'); assert.match(a.landing.note, /the dev DB is behind: run `node -e/);
  assert.ok(!fs.existsSync(path.join(ask, 'applied.txt'))); assert.match(a.nextAction, /dev DB is behind/);
  const drop = repo(t, 'agent'); const d = await land(drop, 'DROP TABLE "a";');
  assert.equal(d.landing.action, 'note'); assert.match(d.landing.note, /drops or rewrites data, so it was not applied/);
  assert.ok(!fs.existsSync(path.join(drop, 'applied.txt')));
});

test('a target checked out nowhere gets a note for when you switch; a failed apply is noted and the landing stands', async t => {
  const away = repo(t, 'agent'); const a = await land(away, undefined, { away: true });
  assert.equal(a.phase, 'merged'); assert.equal(a.landing.action, 'note'); assert.match(a.landing.note, /checked out nowhere — when you switch to it/);
  assert.ok(!fs.existsSync(path.join(away, 'applied.txt')));
  const bad = repo(t, 'agent', 'node -e "process.exit(3)"'); const b = await land(bad);
  assert.equal(b.phase, 'merged'); assert.equal(b.landing.action, 'failed'); assert.match(b.landing.note, /failed in .* by hand/);
  assert.ok(fs.existsSync(b.landing.log)); assert.ok(!fs.existsSync(path.join(bad, 'regenerated.txt')), 'regenerate never runs after a failed apply');
  assert.equal(git(bad, 'rev-parse', 'HEAD'), b.mergedHead);
});

test('a feature that brings no migrations lands with nothing to do', async t => {
  const root = repo(t, 'agent'); const m = await run('start', 'plain', { root });
  fs.writeFileSync(path.join(m.worktree, 'x.txt'), 'x\n'); git(m.worktree, 'add', '.'); git(m.worktree, 'commit', '-m', 'x');
  await run('checkpoint', 'plain', { root, phase: 'verified', next: 'Prepare', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') });
  const p = await run('prepare', 'plain', { root }); const d = await run('deliver', 'plain', { root, verifiedHead: p.candidateHead });
  assert.equal(d.landing.action, 'none'); assert.ok(!fs.existsSync(path.join(root, 'applied.txt')));
});
