import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { run } from '../scripts/lifecycle.mjs';
import { ACTIVE_MS, agentOffer, buildingInSession, pickerOrder } from '../scripts/offer.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const CLI = new URL('../scripts/lifecycle.mjs', import.meta.url).pathname;
function repo(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-offer-'));
  const root = path.join(folder, 'repo'); fs.mkdirSync(root);
  git(root, 'init', '-b', 'work'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'seed');
  t.after(() => fs.rmSync(folder, { recursive: true, force: true })); return root;
}
function touch(m, file = 'brief-1.md') { const dir = path.join(m.worktree, '.builder', m.name); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), 'x\n'); }

test('a session is building a feature only when it is approved-planned, here-planned or building and its working files are fresh', async t => {
  const root = repo(t); const m = await run('start', 'busy', { root });
  const now = Date.now();
  assert.equal(buildingInSession({ ...m, phase: 'building' }, now), false, 'no working files yet');
  touch(m);
  assert.equal(buildingInSession({ ...m, phase: 'building' }, now), true);
  assert.equal(buildingInSession({ ...m, phase: 'building' }, now + ACTIVE_MS + 1000), false, 'stale after 30 minutes');
  assert.equal(buildingInSession({ ...m, phase: 'spec' }, now), false, 'only specced in a session is still offered');
  assert.equal(buildingInSession({ ...m, phase: 'planned' }, now), false, 'planned without a go-ahead');
  assert.equal(buildingInSession({ ...m, phase: 'planned', profileApproved: true }, now), true);
  assert.equal(buildingInSession({ ...m, phase: 'planned', build: 'here' }, now), true);
  assert.equal(ACTIVE_MS, 30 * 60 * 1000);
  // the tracked ledger counts as working files too
  const other = await run('start', 'ledger', { root }); fs.mkdirSync(other.featurePath, { recursive: true }); fs.writeFileSync(path.join(other.featurePath, 'ledger.md'), 'Task 1: done\n');
  assert.equal(buildingInSession({ ...other, phase: 'building' }, Date.now()), true);
});

test('agent offers say what workers would do; merged, paused, awaiting-human, exploring and in-session work is refused', () => {
  const base = { name: 'f', worktree: '/nonexistent', featurePath: '/nonexistent/f', targetBranch: 'main' };
  assert.match(agentOffer({ ...base, phase: 'audited' }).does, /^not built yet · agents audit, plan, build, test and merge it$/);
  assert.match(agentOffer({ ...base, phase: 'building', currentTask: 'Task 3' }).does, /^part-built \(at Task 3\) · agents build the rest, test and merge it$/);
  assert.equal(agentOffer({ ...base, phase: 'built' }).does, 'built in a session, not tested yet · agents only walk it, verify and merge it');
  assert.equal(agentOffer({ ...base, phase: 'built', build: 'here' }).does, 'built here by you, not tested yet · agents only walk it, verify and merge it');
  assert.equal(agentOffer({ ...base, phase: 'verified' }).does, 'tested · agents only verify and merge it');
  assert.match(agentOffer({ ...base, phase: 'merged' }).reason, /already merged into main/);
  assert.match(agentOffer({ ...base, phase: 'building', paused: true }).reason, /paused/);
  assert.match(agentOffer({ ...base, phase: 'built', awaitingHuman: true }).reason, /waiting for your walk/);
  assert.match(agentOffer({ ...base, phase: 'exploring' }).reason, /no spec yet/);
});

test('picker order: not built yet first, then part-built, then built, most recently touched within each', () => {
  const row = (name, phase, touchedAt) => ({ name, touchedAt, agent: agentOffer({ name, phase, worktree: '/none' }) });
  const order = pickerOrder([row('built-old', 'built', 1), row('part', 'building', 5), row('new-old', 'spec', 1), row('new-recent', 'planned', 9), row('gone', 'merged', 99)]).map(r => r.name);
  assert.deepEqual(order, ['new-recent', 'new-old', 'part', 'built-old']);
});

test('list and agent-ready refuse a feature another session is building; a just-specced one is still offered', async t => {
  const root = repo(t);
  const busy = await run('start', 'busy', { root }); await run('checkpoint', 'busy', { root, phase: 'building', next: 'Task 2', task: 'Task 2' }); touch(busy);
  const specced = await run('start', 'specced', { root }); await run('checkpoint', 'specced', { root, phase: 'spec', next: 'Audit' }); touch(specced);
  const rows = Object.fromEntries((await run('list', undefined, { root })).map(r => [r.name, r]));
  assert.equal(rows.busy.inSession, true); assert.equal(rows.busy.agent.offer, false);
  assert.equal(rows.specced.inSession, false); assert.equal(rows.specced.agent.offer, true);
  const refused = spawnSync(process.execPath, [CLI, 'agent-ready', 'busy', '--root', root], { encoding: 'utf8' });
  assert.equal(refused.status, 1); assert.match(refused.stderr, /busy — being built in a session; finish it there/);
  const ok = JSON.parse(execFileSync(process.execPath, [CLI, 'agent-ready', 'specced', '--root', root], { encoding: 'utf8' }));
  assert.equal(ok.offer, true); assert.match(ok.does, /not built yet/); assert.equal(ok.targetBranch, 'work');
});

test('every Codex feature has its own builder/<name> branch, so no branch is shared by several features', async t => {
  const root = repo(t);
  const a = await run('start', 'one', { root }); const b = await run('start', 'two', { root });
  assert.equal(a.featureBranch, 'builder/one'); assert.equal(b.featureBranch, 'builder/two');
  git(root, 'branch', 'builder/three'); await assert.rejects(run('start', 'three', { root }), /branch already exists/);
});

test('build here is chosen before the build starts, recorded on the manifest and shown as here', async t => {
  const root = repo(t); const m = await run('start', 'local', { root });
  await assert.rejects(run('here', 'local', { root }), /before the build starts.*exploring continues as usual/);
  await run('checkpoint', 'local', { root, phase: 'audited', next: 'Plan' });
  const h = await run('here', 'local', { root }); assert.equal(h.build, 'here');
  assert.match(fs.readFileSync(path.join(m.featurePath, 'MANIFEST.md'), 'utf8'), /^build: here$/m);
  assert.equal((await run('here', 'local', { root })).build, 'here', 'choosing it again changes nothing');
  await run('checkpoint', 'local', { root, phase: 'building', next: 'Task 1', task: 'Task 1' });
  assert.match(fs.readFileSync(path.join(m.featurePath, 'MANIFEST.md'), 'utf8'), /^build: here$/m, 'later checkpoints keep it');
  await assert.rejects(run('here', 'local', { root }), /building continues as usual/);
  const [row] = await run('list', undefined, { root }); assert.equal(row.profileLabel, 'here'); assert.equal(row.build, 'here');
  await assert.rejects(run('approve', 'local', { root, profile: 'here' }), /Invalid profile/, 'here is not a build profile');
  await run('checkpoint', 'local', { root, phase: 'built', next: 'Test it yourself, or resume for walk, verify and delivery' });
  assert.equal(agentOffer({ ...(await run('status', 'local', { root })), worktree: '/none' }).does, 'built here by you, not tested yet · agents only walk it, verify and merge it');
  const other = await run('start', 'fleetless', { root });
  assert.equal((await run('list', undefined, { root })).find(r => r.name === other.name).profileLabel, 'thorough');
});
