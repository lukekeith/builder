import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../scripts/lifecycle.mjs';
import { parseWalkReadiness, landedMigrations, isDestructive } from '../scripts/landing.mjs';

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
const APPLY = `node -e "require('fs').writeFileSync('applied.txt','yes')"`;
const REGEN = `node -e "require('fs').writeFileSync('regenerated.txt','yes')"`;
function repo(t, mode, apply = APPLY, { regenerate = REGEN, ignore = true } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-landing-'));
  const root = path.join(folder, 'repo'); fs.mkdirSync(root);
  git(root, 'init', '-b', 'work'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Fixture');
  fs.mkdirSync(path.join(root, '.builder'));
  fs.writeFileSync(path.join(root, '.builder/config.md'), `---\napps:\n  - name: app\n    path: app\n---\n\n## Walk readiness\n\n\`\`\`\nmigrations: db/migrations\napply:      ${apply}\napply_mode: ${mode}   # test\nregenerate: ${regenerate}\n\`\`\`\n`);
  if (ignore) fs.writeFileSync(path.join(root, '.gitignore'), 'applied.txt\nregenerated.txt\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'seed');
  t.after(() => fs.rmSync(folder, { recursive: true, force: true })); return root;
}
async function land(root, sql = 'CREATE TABLE "a" ();', { away = false, file = 'db/migrations/001/migration.sql' } = {}) {
  const m = await run('start', 'mig', { root });
  fs.mkdirSync(path.dirname(path.join(m.worktree, file)), { recursive: true });
  fs.writeFileSync(path.join(m.worktree, file), sql);
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

const ALEMBIC = (forward) => `"""add tags"""
from alembic import op
import sqlalchemy as sa

revision = "001"

def upgrade() -> None:
${forward}

def downgrade() -> None:
    op.drop_column("notes", "tag")
    op.drop_table("tags")
`;
const ADDITIVE = '    op.create_table("tags", sa.Column("id", sa.Integer, primary_key=True))\n    op.add_column("notes", sa.Column("tag", sa.String, nullable=True))';

test('destructive detection: widened SQL, and code migrations judged by their forward half', () => {
  for (const text of ['DROP DATABASE x;', 'DROP SEQUENCE s;', 'DROP FUNCTION f;', 'DROP MATERIALIZED VIEW v;', 'UPDATE "A" SET b = 1;', 'DELETE FROM "A";', 'ALTER TABLE "A" ALTER COLUMN b TYPE int;', 'TRUNCATE "A";', 'ALTER TABLE "A" RENAME TO "B";'])
    assert.equal(isDestructive({ path: 'm/1.sql', text }), true, text);
  for (const text of ['CREATE TABLE "A" ();', 'ALTER TABLE "A" ADD COLUMN "b" TEXT;', 'CREATE INDEX i ON "A"(b);'])
    assert.equal(isDestructive({ path: 'm/1.sql', text }), false, text);
  assert.equal(isDestructive({ path: 'versions/001_tags.py', text: ALEMBIC(ADDITIVE) }), false, 'an additive Alembic upgrade is not destructive because its downgrade drops');
  for (const op of ['    op.drop_column("notes", "tag")', '    op.alter_column("notes", "tag", type_=sa.Text)', '    op.execute("UPDATE notes SET tag = NULL")', '    op.rename_table("notes", "memos")'])
    assert.equal(isDestructive({ path: 'versions/001.py', text: ALEMBIC(op) }), true, op);
  const knex = (up) => `exports.up = function (knex) {\n  return knex.schema.${up}\n}\nexports.down = function (knex) {\n  return knex.schema.dropTable('tags')\n}\n`;
  assert.equal(isDestructive({ path: 'm/1.js', text: knex("createTable('tags', (t) => { t.increments() })") }), false);
  assert.equal(isDestructive({ path: 'm/1.js', text: knex("table('notes', (t) => { t.dropColumn('tag') })") }), true);
  assert.equal(isDestructive({ path: 'db/migrate/1_x.rb', text: 'class X < ActiveRecord::Migration[7.0]\n  def change\n    remove_column :notes, :tag\n  end\nend\n' }), true);
});

test('an additive Alembic migration is applied at landing; an op.drop_column one is only noted', async t => {
  const add = repo(t, 'agent'); const a = await land(add, ALEMBIC(ADDITIVE), { file: 'db/migrations/versions/001_add_tags.py' });
  assert.equal(a.landing.action, 'applied'); assert.ok(fs.existsSync(path.join(add, 'applied.txt')));
  const drop = repo(t, 'agent'); const d = await land(drop, ALEMBIC('    op.drop_column("notes", "tag")'), { file: 'db/migrations/versions/002_drop_tag.py' });
  assert.equal(d.landing.action, 'note'); assert.match(d.landing.note, /002_drop_tag\.py drops or rewrites data, so it was not applied/);
  assert.ok(!fs.existsSync(path.join(drop, 'applied.txt')));
});

test('commands that leave the target checkout dirty are reported by file, and the checkout can be cleaned up afterwards', async t => {
  const root = repo(t, 'agent', APPLY, { ignore: false }); const d = await land(root);
  assert.equal(d.phase, 'merged'); assert.equal(d.landing.action, 'applied-dirty');
  assert.deepEqual([...d.landing.dirty].sort(), ['applied.txt', 'regenerated.txt']);
  assert.match(d.landing.note, /It changed applied\.txt, regenerated\.txt in .*: commit them under the project's policy or restore them .* must be clean before another prepare, deliver or cleanup/);
  assert.match(d.nextAction, /regenerated\.txt/);
  await assert.rejects(run('cleanup', 'mig', { root }), /must be clean/);
  for (const f of d.landing.dirty) fs.unlinkSync(path.join(root, f));
  await run('cleanup', 'mig', { root });
});

test('a regenerate that fails after apply succeeded is reported as such, naming what is left to run', async t => {
  const root = repo(t, 'agent', APPLY, { regenerate: 'node -e "process.exit(4)"' }); const d = await land(root);
  assert.equal(d.phase, 'merged'); assert.equal(d.landing.action, 'failed');
  assert.deepEqual(d.landing.ran, [APPLY]); assert.equal(d.landing.failed, 'node -e "process.exit(4)"');
  assert.ok(fs.existsSync(path.join(root, 'applied.txt')));
  assert.match(d.landing.note, /1 new migration landed and `node -e .*applied.txt.*` ran, but `node -e "process.exit\(4\)"` failed in .* then run `node -e "process.exit\(4\)"` by hand/);
});
