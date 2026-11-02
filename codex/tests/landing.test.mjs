import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../scripts/lifecycle.mjs';
import { parseWalkReadiness, landedMigrations, isDestructive, wrapUp } from '../scripts/landing.mjs';

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
    assert.equal(x.action, 'note'); assert.equal(x.kind, 'maybe');
    assert.match(x.why, /1 new migration landed — the dev DB may be behind: if it lacks them, run `npm run db:migrate`, then `npm run db:generate`/);
  }
  assert.match(landedMigrations({ files, readiness: { migrations: 'm' } }).why, /no `apply:` command/);
  const away = landedMigrations({ files, readiness: r, checkedOut: false, target: 'work' });
  assert.equal(away.action, 'note'); assert.match(away.why, /work, which is checked out nowhere — when you switch to it/);
});

test('pending: the dev DB\'s own answer settles an ask-mode note; without it the note says may be behind', () => {
  const r = { ...parseWalkReadiness(BODY), apply_mode: 'ask', pending: 'npx prisma migrate status' };
  const files = [{ path: 'm/1.sql', text: 'CREATE TABLE "A" ();' }];
  assert.deepEqual(landedMigrations({ files, readiness: r, pending: false }), { action: 'none', why: '1 new migration landed; `npx prisma migrate status` says the dev DB already has them' });
  const behind = landedMigrations({ files, readiness: r, pending: true });
  assert.equal(behind.action, 'note'); assert.match(behind.why, /the dev DB is behind, or `npx prisma migrate status` couldn't reach it: run `npm run db:migrate`/);
  assert.equal(landedMigrations({ files, readiness: r }).kind, 'maybe');
  assert.match(landedMigrations({ files: [{ path: 'm/1.sql', text: 'DROP TABLE "A";' }], readiness: r, pending: false }).why, /drops or rewrites data/, 'a destructive migration is noted whatever pending says');
});

test('parseWalkReadiness reads pending, restart, fixtures and smoke; wrapUp offers them after a landing, smoke last', () => {
  const body = BODY.replace('regenerate: npm run db:generate', 'regenerate: npm run db:generate\npending:    npx prisma migrate status\nrestart:    docker compose restart api   # no reload\nfixtures:   npm run db:seed\nsmoke:      curl -sf localhost:3000/health');
  const r = parseWalkReadiness(body);
  assert.equal(r.pending, 'npx prisma migrate status'); assert.equal(r.restart, 'docker compose restart api'); assert.equal(r.fixtures, 'npm run db:seed');
  assert.deepEqual(wrapUp({ readiness: r, checkedOut: true }).map((s) => [s.id, s.command]), [['restart', 'docker compose restart api'], ['fixtures', 'npm run db:seed'], ['smoke', 'curl -sf localhost:3000/health']]);
  assert.match(wrapUp({ readiness: r, checkedOut: true })[0].title, /restart what doesn't reload by itself/);
  assert.deepEqual(wrapUp({ readiness: r, checkedOut: false }), [], 'a target checked out nowhere serves no dev env here');
  assert.deepEqual(wrapUp({ readiness: { smoke: 'curl x' }, checkedOut: true }), [], 'smoke alone only follows another step');
  assert.deepEqual(wrapUp({ readiness: { smoke: 'curl x' }, checkedOut: true, migrated: true }).map((s) => s.id), ['smoke']);
  assert.deepEqual(wrapUp({ readiness: {}, checkedOut: true }), []);
});

test('destructive detection: each migration tool\'s own data-changing operations', () => {
  const js = (body) => `export async function up(queryInterface) {\n  ${body}\n}\nexport async function down() {}\n`;
  for (const body of ['await queryInterface.bulkDelete("users", null, {})', 'await queryInterface.bulkUpdate("users", { a: 1 }, {})', 'await queryInterface.removeColumn("users", "a")', 'await queryInterface.changeColumn("users", "a", {})', 'await queryInterface.removeConstraint("users", "c")', 'await queryInterface.removeIndex("users", "i")', 'await prisma.user.deleteMany({})', 'await db.collection("u").deleteOne({})', 'await db.collection("u").updateMany({}, {})', 'await db.dropCollection("u")'])
    assert.equal(isDestructive({ path: 'm/1.js', text: js(body) }), true, body);
  assert.equal(isDestructive({ path: 'm/1.js', text: js('await queryInterface.addColumn("users", "a", {})') }), false);
  for (const text of ['ALTER TABLE "A" ALTER COLUMN b SET DATA TYPE int;', 'UPDATE "A" AS a SET b = 1;', 'UPDATE public.a x SET b = 1;'])
    assert.equal(isDestructive({ path: 'm/1.sql', text }), true, text);
  const rb = (body) => `class X < ActiveRecord::Migration[7.0]\n  def up\n    ${body}\n  end\nend\n`;
  for (const body of ['User.delete_all', 'User.update_all(a: 1)', 'User.destroy_all', 'change_table :users do |t| t.remove :a end'])
    assert.equal(isDestructive({ path: 'db/migrate/1_x.rb', text: rb(body) }), true, body);
  const py = (body) => `def upgrade():\n    ${body}\n\ndef downgrade():\n    pass\n`;
  for (const body of ['op.drop_constraint("c", "t")', 'with op.batch_alter_table("t") as b: b.add_column(x)'])
    assert.equal(isDestructive({ path: 'v/1.py', text: py(body) }), true, body);
});

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const APPLY = `node -e "require('fs').writeFileSync('applied.txt','yes')"`;
const REGEN = `node -e "require('fs').writeFileSync('regenerated.txt','yes')"`;
function repo(t, mode, apply = APPLY, { regenerate = REGEN, ignore = true, extra = '' } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-landing-'));
  const root = path.join(folder, 'repo'); fs.mkdirSync(root);
  git(root, 'init', '-b', 'work'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Fixture');
  fs.mkdirSync(path.join(root, '.builder'));
  fs.writeFileSync(path.join(root, '.builder/config.md'), `---\napps:\n  - name: app\n    path: app\n---\n\n## Walk readiness\n\n\`\`\`\nmigrations: db/migrations\napply:      ${apply}\napply_mode: ${mode}   # test\nregenerate: ${regenerate}\n${extra}\`\`\`\n`);
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
  assert.equal(a.landing.action, 'note'); assert.match(a.landing.note, /the dev DB may be behind: if it lacks them, run `node -e/);
  assert.ok(!fs.existsSync(path.join(ask, 'applied.txt'))); assert.match(a.nextAction, /dev DB may be behind/);
  const drop = repo(t, 'agent'); const d = await land(drop, 'DROP TABLE "a";');
  assert.equal(d.landing.action, 'note'); assert.match(d.landing.note, /drops or rewrites data, so it was not applied/);
  assert.ok(!fs.existsSync(path.join(drop, 'applied.txt')));
});

test('ask mode asks pending: in the target checkout — exit 0 settles it, non-zero says behind; neither applies anything', async t => {
  const up = repo(t, 'ask', APPLY, { extra: 'pending:    node -e "process.exit(0)"\n' }); const u = await land(up);
  assert.equal(u.landing.action, 'none'); assert.match(u.landing.why, /says the dev DB already has them/);
  assert.equal(u.nextAction, 'Optional explicit cleanup');
  const behind = repo(t, 'ask', APPLY, { extra: 'pending:    node -e "process.exit(1)"\n' }); const b = await land(behind);
  assert.equal(b.landing.action, 'note'); assert.match(b.landing.note, /the dev DB is behind, or `node -e "process.exit\(1\)"` couldn't reach it: run/);
  assert.ok(!fs.existsSync(path.join(behind, 'applied.txt')));
});

test('deliver lists the wrap-up steps the config names, for the coordinator to offer in one question; it runs none of them', async t => {
  const root = repo(t, 'agent', APPLY, { extra: 'restart:    node -e "require(\'fs\').writeFileSync(\'restarted.txt\',\'y\')"\nfixtures:   npm run seed\nsmoke:      curl -sf localhost:1/health\n' });
  const d = await land(root);
  assert.deepEqual(d.wrapUp.map(s => s.id), ['restart', 'fixtures', 'smoke']);
  assert.equal(d.wrapUp[1].command, 'npm run seed');
  assert.ok(!fs.existsSync(path.join(root, 'restarted.txt')), 'offered, never run by deliver');
  const away = repo(t, 'agent', APPLY, { extra: 'restart:    echo restart\n' }); const a = await land(away, undefined, { away: true });
  assert.deepEqual(a.wrapUp, []);
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
