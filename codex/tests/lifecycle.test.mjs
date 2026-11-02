import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { run } from '../scripts/lifecycle.mjs';
import { VERIFY_CONFIG, waitFor, landFeature, settle } from './land-helpers.mjs';
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// The committed config is .claude/builder.md — last in Codex's precedence — so a test's own
// .builder/config.md still wins for lifecycle; the verifier reads whichever is first.
function repo(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-lifecycle-'));
  const root = path.join(folder, 'repo'); fs.mkdirSync(root);
  git(root, 'init', '-b', 'work'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n'); fs.mkdirSync(path.join(root, '.claude')); fs.writeFileSync(path.join(root, '.claude/builder.md'), VERIFY_CONFIG);
  git(root, 'add', '.'); git(root, 'commit', '-m', 'seed');
  t.after(() => { settle(root); fs.rmSync(folder, { recursive: true, force: true }); }); return root;
}
const stashList = root => git(root, 'stash', 'list', '--format=%H %gs');
function commit(root, file = 'feature.txt', text = 'feature\n') { fs.writeFileSync(path.join(root, file), text); git(root, 'add', '.'); git(root, 'commit', '-m', file); return git(root, 'rev-parse', 'HEAD'); }
async function verified(root, name = 'test') {
  const m = await run('start', name, { root }); commit(m.worktree);
  await run('checkpoint', name, { root, phase: 'verified', next: 'Prepare', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') }); return m;
}
function configure(root, extra = '') {
  fs.mkdirSync(path.join(root, '.builder'), { recursive: true });
  fs.writeFileSync(path.join(root, '.builder/config.md'), `---\n${extra}apps:\n  - name: app\n    path: app\n---\n`);
}
function metadata(m) { return path.join(m.commonDir, 'builder-codex', 'features', `${m.name}.json`); }
test('start isolates all edits and preserves dirty nonmain origin; cold resume is idempotent', async t => {
  const root = repo(t); fs.writeFileSync(path.join(root, 'seed.txt'), 'user edits\n'); fs.writeFileSync(path.join(root, 'untracked.txt'), 'private\n');
  const before = git(root, 'status', '--porcelain'); const m = await run('start', 'isolated', { root });
  assert.equal(m.originBranch, 'work'); assert.equal(fs.readFileSync(path.join(m.worktree, 'seed.txt'), 'utf8'), 'seed\n');
  assert.equal(git(root, 'status', '--porcelain'), before);
  const resumed = JSON.parse(execFileSync(process.execPath, [new URL('../scripts/lifecycle.mjs', import.meta.url).pathname, 'resume', 'isolated', '--root', root], { encoding: 'utf8' }));
  assert.equal(resumed.originHead, m.originHead); assert.equal(resumed.worktree, m.worktree);
  assert.equal((await run('start', 'isolated', { root })).worktree, m.worktree);
  assert.equal((await run('list', undefined, { root })).length, 1);
});
test('refuses detached origin, invalid feature names and preexisting branch', async t => {
  const root = repo(t);
  for (const name of ['../escape', 'Bad', '-bad', 'bad/name']) await assert.rejects(run('start', name, { root }), /Invalid feature name/);
  git(root, 'branch', 'builder/collision'); await assert.rejects(run('start', 'collision', { root }), /branch already exists/);
  git(root, 'checkout', '--detach'); await assert.rejects(run('start', 'detached', { root }), /Detached HEAD/);
});
test('checkpoint preserves arbitrary manifest fields and verification requires clean exact head', async t => {
  const root = repo(t); const m = await run('start', 'checkpoints', { root });
  fs.mkdirSync(m.featurePath, { recursive: true }); fs.writeFileSync(path.join(m.featurePath, 'MANIFEST.md'), 'ticket: KEEP\nstate: built\n');
  await run('checkpoint', 'checkpoints', { root, phase: 'building', next: 'Finish implementation', task: 'Task 1' });
  const manifest = fs.readFileSync(path.join(m.featurePath, 'MANIFEST.md'), 'utf8'); assert.match(manifest, /ticket: KEEP/); assert.match(manifest, /state: building/); assert.match(manifest, /origin-branch: work/); assert.match(manifest, /size: md/); assert.ok(manifest.includes(`target-start-head: ${m.targetStartHead}`));
  await assert.rejects(run('checkpoint', 'checkpoints', { root, phase: 'building', next: 'x', verifiedHead: m.originHead }), /requires verified phase/);
  await assert.rejects(run('checkpoint', 'checkpoints', { root, phase: 'verified', next: 'x', verifiedHead: m.originHead }), /clean feature worktree/);
  git(m.worktree, 'add', '.'); git(m.worktree, 'commit', '-m', 'checkpoint'); const sha = git(m.worktree, 'rev-parse', 'HEAD');
  await assert.rejects(run('checkpoint', 'checkpoints', { root, phase: 'verified', next: 'x', verifiedHead: m.originHead }), /exact current HEAD/);
  await run('checkpoint', 'checkpoints', { root, phase: 'verified', next: 'Prepare', verifiedHead: sha }); assert.equal(git(m.worktree, 'status', '--porcelain'), '');
  assert.equal(fs.readFileSync(path.join(m.featurePath, 'MANIFEST.md'), 'utf8'), manifest);
});

test('prepare asks the merge tier for a held merge; deliver lands exactly the tested merge and records history; cleanup retains evidence', async t => {
  const root = repo(t); const m = await run('start', 'test', { root });
  fs.mkdirSync(m.featurePath, { recursive: true }); fs.writeFileSync(path.join(m.featurePath, 'PLAN.md'), '### Task 1\n### Task 2\n'); commit(m.worktree);
  await run('checkpoint', 'test', { root, phase: 'verified', next: 'Prepare', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') });
  const advanced = commit(root, 'other.txt', 'independent\n');
  const p = await run('prepare', 'test', { root }); assert.equal(p.status, 'requested'); assert.match(p.request, /^\S+$/); assert.equal(p.merge.targetHead, advanced); assert.deepEqual(p.overlap, []);
  assert.match(p.nextAction, /^Ready to land on work once the merge tier is green and the walk passed/);
  assert.equal((await run('prepare', 'test', { root })).request, p.request, 'a pending or held request is reused, not asked again');
  assert.equal(git(root, 'rev-parse', 'HEAD'), advanced, 'prepare changes nothing in the target');
  assert.equal(waitFor(root, p.request), 0);
  const result = await run('deliver', 'test', { root }); assert.equal(result.status, 'landed'); assert.equal(result.phase, 'merged'); assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), 'work');
  assert.equal(git(root, 'rev-parse', 'HEAD'), result.mergedHead); assert.equal(git(root, 'rev-parse', `${result.mergedHead}^1`), advanced); assert.equal(git(root, 'rev-parse', `${result.mergedHead}^2`), p.merge.featureHead);
  assert.equal(fs.readFileSync(path.join(root, 'feature.txt'), 'utf8'), 'feature\n');
  assert.equal(result.history.recorded, true); assert.equal(result.history.row.size.tasks, 2); assert.equal(result.history.row.mergedHead, result.mergedHead);
  assert.equal((await run('list', undefined, { root })).find(r => r.name === 'test')?.phase, 'merged', 'merged with its worktree still there: cleanup is still its next step');
  await run('cleanup', 'test', { root }); assert.ok(!fs.existsSync(m.worktree));
  assert.ok(fs.existsSync(path.join(path.dirname(root), 'repo-verify')), "cleanup leaves the verifier's own checkouts alone");
  assert.equal((await run('list', undefined, { root })).find(r => r.name === 'test'), undefined, 'finished means gone from status');
  const saved = await run('resume', 'test', { root }); assert.equal(saved.cleaned, true); assert.equal(saved.mergedHead, result.mergedHead);
});

test('a target that moved after the merge was tested is not landed: the merge is asked again, then lands on the new tip; a late feature commit is not verified', async t => {
  const root = repo(t); await verified(root); const p = await run('prepare', 'test', { root }); assert.equal(waitFor(root, p.request), 0);
  const moved = commit(root, 'advance.txt');
  const d = await run('deliver', 'test', { root }); assert.equal(d.status, 'testing'); assert.notEqual(d.request, p.request); assert.match(d.why, /target moved/); assert.equal(d.merge.targetHead, moved);
  assert.equal(git(root, 'rev-parse', 'HEAD'), moved, 'nothing landed');
  assert.equal(waitFor(root, d.request), 0);
  const landed = await run('deliver', 'test', { root }); assert.equal(landed.status, 'landed'); assert.equal(git(root, 'rev-parse', `${landed.mergedHead}^1`), moved);
  const root2 = repo(t); const m2 = await verified(root2); await run('prepare', 'test', { root: root2 });
  commit(m2.worktree, 'late.txt'); await assert.rejects(run('deliver', 'test', { root: root2 }), /must remain verified/);
});

test('uncommitted changes that do not overlap the feature are no block: it lands around them, and a switched origin does not retarget it', async t => {
  const root = repo(t); const m = await verified(root);
  fs.writeFileSync(path.join(root, 'seed.txt'), 'my edit\n'); fs.writeFileSync(path.join(root, 'notes.txt'), 'mine\n');
  const before = git(root, 'status', '--porcelain');
  const d = await landFeature(root, 'test'); assert.equal(d.status, 'landed'); assert.equal(d.needsYou, undefined);
  assert.equal(git(root, 'status', '--porcelain'), before); assert.equal(fs.readFileSync(path.join(root, 'seed.txt'), 'utf8'), 'my edit\n');
  assert.equal(fs.readFileSync(path.join(root, 'feature.txt'), 'utf8'), 'feature\n');
  const root2 = repo(t); const m2 = await verified(root2); const p = await run('prepare', 'test', { root: root2 }); waitFor(root2, p.request);
  fs.writeFileSync(path.join(m2.worktree, 'dirty.txt'), 'dirty'); await assert.rejects(run('deliver', 'test', { root: root2 }), /Feature worktree must be clean/); fs.unlinkSync(path.join(m2.worktree, 'dirty.txt'));
  git(root2, 'checkout', '-b', 'different');
  const d2 = await run('deliver', 'test', { root: root2 }); assert.equal(d2.status, 'landed');
  assert.equal(git(root2, 'symbolic-ref', '--short', 'HEAD'), 'different'); assert.equal(git(root2, 'rev-parse', 'HEAD'), m2.originHead);
  assert.equal(git(root2, 'rev-parse', 'work'), d2.mergedHead);
  void m;
});

/** A feature that edits line 1 of shared.txt; the owner's own edit there (line 5, or line 1 to clash) comes after. */
async function sharedFeature(t, line1 = 'A feature\n') {
  const root = repo(t); commit(root, 'shared.txt', 'a\nb\nc\nd\ne\n');
  const m = await run('start', 'test', { root }); commit(m.worktree, 'shared.txt', `${line1}b\nc\nd\ne\n`); commit(m.worktree, 'added.txt', 'feature adds this\n');
  await run('checkpoint', 'test', { root, phase: 'verified', next: 'Prepare', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') });
  return { root, m };
}

test('overlapping uncommitted changes park as needs you with the three choices, and nothing of the owner is touched', async t => {
  const { root } = await sharedFeature(t);
  fs.writeFileSync(path.join(root, 'shared.txt'), 'a\nb\nc\nd\nE mine\n'); fs.writeFileSync(path.join(root, 'added.txt'), 'my own copy\n');
  const p = await run('prepare', 'test', { root }); assert.deepEqual(p.overlap, ['added.txt', 'shared.txt'], 'caught early, while the tests run');
  assert.match(p.needsYou.reason, /^needs you: your uncommitted changes in .* overlap this feature — 2 files: added\.txt, shared\.txt$/);
  assert.equal(waitFor(root, p.request), 0);
  const head = git(root, 'rev-parse', 'HEAD'); const status = git(root, 'status', '--porcelain'); const stashes = stashList(root);
  const cli = spawnSync(process.execPath, [new URL('../scripts/lifecycle.mjs', import.meta.url).pathname, 'deliver', 'test', '--root', root], { encoding: 'utf8' });
  assert.equal(cli.status, 3, cli.stderr); const d = JSON.parse(cli.stdout);
  assert.equal(d.status, 'needs-you'); assert.deepEqual(d.overlap, ['added.txt', 'shared.txt']);
  assert.equal(d.recommended, 'set-aside', '2 files: 3 or fewer recommend setting them aside'); assert.match(d.why, /^only a few files/);
  assert.deepEqual(d.choices.map(c => c.label), ['Set my changes aside, land, put them back', 'Commit my changes, then land', 'Leave it for now']);
  assert.deepEqual(d.choices.map(c => c.run), ['deliver test --set-aside', 'deliver test --commit-mine "<message>"', null]);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head); assert.equal(git(root, 'status', '--porcelain'), status); assert.equal(stashList(root), stashes);
  assert.equal(fs.readFileSync(path.join(root, 'added.txt'), 'utf8'), 'my own copy\n');
  const listed = (await run('list', undefined, { root })).find(r => r.name === 'test');
  assert.equal(listed.phase, 'verified'); assert.deepEqual(listed.needsYou.files, ['added.txt', 'shared.txt']); assert.match(listed.nextAction, /^needs you: .* ask the owner: set theirs aside, land, put them back \(recommended\) · commit theirs, then land · leave it$/);
});

test('commit mine: the owner\'s changes are committed on the target, the merge is tested again on top, then it lands', async t => {
  const { root } = await sharedFeature(t);
  fs.writeFileSync(path.join(root, 'shared.txt'), 'a\nb\nc\nd\nE mine\n'); fs.writeFileSync(path.join(root, 'notes.txt'), 'not part of it\n');
  const p = await run('prepare', 'test', { root }); waitFor(root, p.request);
  await assert.rejects(run('deliver', 'test', { root, commitMine: ' ' }), /needs the message/);
  const c = await run('deliver', 'test', { root, commitMine: 'wip: my shared edits' });
  assert.equal(c.status, 'testing'); assert.deepEqual(c.committed.files, ['shared.txt']); assert.equal(git(root, 'log', '-1', '--format=%s'), 'wip: my shared edits');
  assert.equal(c.needsYou, undefined); assert.notEqual(c.request, p.request);
  assert.equal(waitFor(root, c.request), 0);
  const d = await run('deliver', 'test', { root }); assert.equal(d.status, 'landed');
  assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), 'A feature\nb\nc\nd\nE mine\n');
  assert.equal(git(root, 'status', '--porcelain'), '?? notes.txt', 'an untracked file the feature does not add is never committed');
});

test('set aside: the landing goes ahead and the owner\'s changes are put back; the stash is dropped', async t => {
  const { root } = await sharedFeature(t);
  fs.writeFileSync(path.join(root, 'shared.txt'), 'a\nb\nc\nd\nE mine\n'); fs.writeFileSync(path.join(root, 'notes.txt'), 'mine\n');
  const stashes = stashList(root);
  const d = await landFeature(root, 'test', { setAside: true }); assert.equal(d.status, 'landed'); assert.deepEqual(d.setAside, { clean: true });
  assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), 'A feature\nb\nc\nd\nE mine\n');
  assert.equal(git(root, 'diff', '--name-only'), 'shared.txt'); assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'mine\n');
  assert.equal(git(root, 'rev-parse', 'HEAD'), d.mergedHead); assert.equal(stashList(root), stashes);
});

test('set aside: changes that clash on the way back keep the stash and name the files — never dropped, never force-resolved', async t => {
  const { root } = await sharedFeature(t);
  fs.writeFileSync(path.join(root, 'shared.txt'), 'A mine\nb\nc\nd\ne\n');
  const d = await landFeature(root, 'test', { setAside: true }); assert.equal(d.status, 'landed'); assert.equal(git(root, 'rev-parse', 'HEAD'), d.mergedHead);
  assert.equal(d.setAside.clean, false); assert.deepEqual(d.setAside.files, ['shared.txt']);
  const kept = stashList(root).split('\n').find(l => l.endsWith('builder: before landing test'));
  assert.ok(kept, 'the stash is kept'); assert.equal(kept.split(' ')[0], d.setAside.stash);
  assert.equal(git(root, 'show', `${d.setAside.stash}:shared.txt`), 'A mine\nb\nc\nd\ne');
  assert.match(d.nextAction, /^Landed — but your changes came back with conflicts in shared\.txt; nothing of yours was dropped/);
  assert.match(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), /<<<<<<<[\s\S]*A feature[\s\S]*=======[\s\S]*A mine[\s\S]*>>>>>>>/);
});
test('resume rejects rewritten ancestry and wrong feature branch', async t => {
  const root = repo(t); const m = await verified(root);
  git(m.worktree, 'checkout', '-b', 'wrong'); await assert.rejects(run('resume', 'test', { root }), /Feature worktree branch changed/);
  git(m.worktree, 'checkout', m.featureBranch); git(m.worktree, 'checkout', '--orphan', 'rewritten'); git(m.worktree, 'add', '.'); git(m.worktree, 'commit', '-m', 'unrelated');
  git(m.worktree, 'branch', '-f', m.featureBranch, 'HEAD'); git(m.worktree, 'checkout', m.featureBranch);
  await assert.rejects(run('resume', 'test', { root }), /no longer descends/);
});

test('prepare refuses a feature not built yet and a dirty one; in-flight origin operations are blocked', async t => {
  const root = repo(t); const m = await run('start', 'test', { root });
  await assert.rejects(run('prepare', 'test', { root }), /once the feature is built/);
  commit(m.worktree); await run('checkpoint', 'test', { root, phase: 'verified', next: 'Prepare', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') });
  fs.writeFileSync(path.join(m.worktree, 'dirty.txt'), 'dirty'); await assert.rejects(run('prepare', 'test', { root }), /Feature worktree must be clean/); fs.unlinkSync(path.join(m.worktree, 'dirty.txt'));
  const mergeHead = path.resolve(root, git(root, 'rev-parse', '--git-path', 'MERGE_HEAD')); fs.writeFileSync(mergeHead, `${m.originHead}\n`);
  await assert.rejects(run('prepare', 'test', { root }), /Git operation in progress/); fs.unlinkSync(mergeHead);
});

test('a conflict verdict names the files; the target merged into the feature and resolved, the merge is asked again and lands', async t => {
  const root = repo(t); const m = await run('start', 'conflict', { root });
  commit(m.worktree, 'seed.txt', 'feature version\n'); await run('checkpoint', 'conflict', { root, phase: 'verified', next: 'Prepare', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') });
  const target = commit(root, 'seed.txt', 'origin version\n');
  const p = await run('prepare', 'conflict', { root }); assert.equal(waitFor(root, p.request), 4);
  const d = await run('deliver', 'conflict', { root }); assert.equal(d.status, 'conflict'); assert.deepEqual(d.files, ['seed.txt']);
  assert.match(d.nextAction, /merge work into the feature worktree, resolve those files, commit, verify again, then prepare/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), target);
  try { git(m.worktree, 'merge', 'work'); } catch { /* the conflict, resolved below */ }
  fs.writeFileSync(path.join(m.worktree, 'seed.txt'), 'combined version\n'); git(m.worktree, 'add', 'seed.txt'); git(m.worktree, 'commit', '--no-edit');
  await run('checkpoint', 'conflict', { root, phase: 'verified', next: 'Prepare again', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') });
  const landed = await landFeature(root, 'conflict'); assert.equal(landed.status, 'landed');
  assert.equal(fs.readFileSync(path.join(root, 'seed.txt'), 'utf8'), 'combined version\n');
  fs.writeFileSync(path.join(m.worktree, 'local.txt'), 'local'); await assert.rejects(run('cleanup', 'conflict', { root }), /Feature worktree must be clean/); assert.ok(fs.existsSync(m.worktree));
});
test('malformed existing config and tracked manifest collisions are refused', async t => {
  const root = repo(t); fs.mkdirSync(path.join(root, '.builder')); fs.writeFileSync(path.join(root, '.builder/config.md'), 'malformed');
  await assert.rejects(run('start', 'invalid-config', { root }), /frontmatter/);
  fs.writeFileSync(path.join(root, '.builder/config.md'), '---\nregistry: docs/work\napps:\n  - name: app\n    path: app\n---\n');
  fs.mkdirSync(path.join(root, 'docs/work/existing'), { recursive: true }); fs.writeFileSync(path.join(root, 'docs/work/existing/MANIFEST.md'), 'state: built\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'existing feature');
  await assert.rejects(run('start', 'existing', { root }), /Tracked feature manifest already exists/);
  const m = await run('start', 'new-feature', { root }); assert.equal(m.registry, 'docs/work');
});
test('phase injection cannot mark work merged', async t => {
  const root = repo(t); const m = await run('start', 'test', { root });
  for (const phase of ['merged', 'shipped', 'building\nstate: merged']) await assert.rejects(run('checkpoint', 'test', { root, phase, next: 'x' }), /Invalid checkpoint phase/);
  assert.equal((await run('resume', 'test', { root })).phase, 'exploring'); assert.ok(!fs.existsSync(m.featurePath));
});

test('registry-only commits after the merge was tested carry it, with no second run; a code commit asks for the merge again', async t => {
  const root = repo(t); const m = await verified(root); const p = await run('prepare', 'test', { root }); assert.equal(waitFor(root, p.request), 0);
  fs.mkdirSync(m.featurePath, { recursive: true }); const walked = commit(m.worktree, 'docs/features/test/walk.md', 'walk passed\n');
  await run('checkpoint', 'test', { root, phase: 'verified', next: 'Deliver', verifiedHead: walked });
  const d = await run('deliver', 'test', { root }); assert.equal(d.status, 'landed'); assert.equal(d.merge.request, p.request, 'carried, not asked again');
  assert.equal(git(root, 'rev-parse', `${d.mergedHead}^2`), walked); assert.ok(fs.existsSync(path.join(root, 'docs/features/test/walk.md')));
  const root2 = repo(t); const m2 = await verified(root2); const p2 = await run('prepare', 'test', { root: root2 }); waitFor(root2, p2.request);
  const code = commit(m2.worktree, 'more-code.txt'); await run('checkpoint', 'test', { root: root2, phase: 'verified', next: 'Deliver', verifiedHead: code });
  const again = await run('deliver', 'test', { root: root2 }); assert.equal(again.status, 'testing'); assert.match(again.why, /changed since the merge was tested/);
  assert.equal(waitFor(root2, again.request), 0); assert.equal((await run('deliver', 'test', { root: root2 })).status, 'landed');
  assert.equal(git(root2, 'rev-parse', 'work^2'), code);
});
test('explicit target captures origin separately and starts from target, with CLI and immutable retries', async t => {
  const root = repo(t); const targetHead = git(root, 'rev-parse', 'HEAD'); git(root, 'branch', 'main');
  const originHead = commit(root, 'source-only.txt', 'source\n');
  const m = JSON.parse(execFileSync(process.execPath, [new URL('../scripts/lifecycle.mjs', import.meta.url).pathname, 'start', 'explicit', '--root', root, '--into', 'main'], { encoding: 'utf8' }));
  assert.equal(m.targetBranch, 'main'); assert.equal(m.targetStartHead, targetHead); assert.equal(m.originHead, originHead); assert.equal(m.originBranch, 'work');
  assert.equal(git(m.worktree, 'rev-parse', 'HEAD'), targetHead); assert.equal(fs.existsSync(path.join(m.worktree, 'source-only.txt')), false);
  await assert.rejects(run('start', 'explicit', { root, into: 'work' }), /immutable/);
  await assert.rejects(run('prepare', 'explicit', { root, into: 'work' }), /only accepted/);
  await assert.rejects(run('start', 'missing', { root, into: 'missing' }), /does not exist/);
});
test('configured target precedence uses merge_into then explicit base_branch, with current fallback', async t => {
  const root = repo(t); git(root, 'branch', 'main'); git(root, 'branch', 'release');
  configure(root, 'merge_into: release\nbase_branch: main\n');
  assert.equal((await run('start', 'merge-config', { root })).targetBranch, 'release');
  assert.equal((await run('start', 'override-config', { root, into: 'work' })).targetBranch, 'work');
  configure(root, 'base_branch: main\n'); assert.equal((await run('start', 'base-config', { root })).targetBranch, 'main');
  configure(root); assert.equal((await run('start', 'no-target-config', { root })).targetBranch, 'work');
});

test('detached origin can use explicit or configured targets without requiring origin ancestry', async t => {
  const root = repo(t); git(root, 'branch', 'main'); const detachedHead = commit(root, 'detached-only.txt'); git(root, 'checkout', '--detach');
  const m = await run('start', 'detached-explicit', { root, into: 'main' }); assert.equal(m.originBranch, null); assert.equal(m.originHead, detachedHead);
  commit(m.worktree); await run('checkpoint', m.name, { root, phase: 'verified', next: 'Prepare', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') });
  const d = await landFeature(root, m.name); assert.equal(d.status, 'landed');
  assert.equal(git(root, 'rev-parse', 'HEAD'), detachedHead); assert.equal(git(root, 'rev-parse', 'main'), d.mergedHead);
  configure(root, 'base_branch: main\n'); assert.equal((await run('start', 'detached-config', { root })).targetBranch, 'main');
});

test('a target checked out in another linked worktree is refused with what to do; the origin and its edits stay put', async t => {
  const root = repo(t); const m = await verified(root); const originHead = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-b', 'other'); const targetRoot = path.join(path.dirname(root), 'target'); git(root, 'worktree', 'add', targetRoot, 'work');
  fs.writeFileSync(path.join(root, 'private.txt'), 'origin local edits\n'); const originDirty = git(root, 'status', '--porcelain');
  await assert.rejects(run('prepare', m.name, { root }), /work is checked out in .*target, and the verifier lands only into the main checkout .* — next: switch .*target to another branch \(or leave it for now\), then run prepare again/);
  git(root, 'worktree', 'remove', targetRoot);
  const d = await landFeature(root, m.name); assert.equal(d.status, 'landed'); assert.equal(git(root, 'rev-parse', 'work'), d.mergedHead);
  assert.equal(git(root, 'status', '--porcelain'), originDirty); assert.equal(git(root, 'rev-parse', 'HEAD'), originHead);
  await run('cleanup', m.name, { root }); assert.equal(fs.existsSync(m.worktree), false);
  await assert.rejects(run('start', m.name, { root }), /already merged/);
});

test('pause survives cold resume and checkpoint attempts; unpause restores phase without proofs or the old merge request', async t => {
  const root = repo(t); const m = await verified(root); await run('prepare', m.name, { root });
  const paused = await run('pause', m.name, { root }); assert.equal(paused.paused, true); assert.equal(paused.pauseState.phase, 'verified'); assert.equal(paused.verifiedHead, null); assert.equal(paused.merge, null);
  const cold = JSON.parse(execFileSync(process.execPath, [new URL('../scripts/lifecycle.mjs', import.meta.url).pathname, 'resume', m.name, '--root', root], { encoding: 'utf8' })); assert.equal(cold.paused, true);
  for (const command of ['prepare', 'deliver', 'approve', 'checkpoint']) await assert.rejects(run(command, m.name, { root, phase: 'verified', next: 'Skip pause', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD'), profile: 'rush' }), /paused/);
  await run('pause', m.name, { root }); const resumed = await run('unpause', m.name, { root }); assert.equal(resumed.phase, 'verified'); assert.equal(resumed.verifiedHead, null); assert.equal(resumed.merge, null);
  await assert.rejects(run('deliver', m.name, { root }), /must remain verified/);
  await run('checkpoint', m.name, { root, phase: 'verified', next: 'Prepare again', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') });
  await assert.rejects(run('deliver', m.name, { root }), /No merge requested yet/);
  assert.equal((await landFeature(root, m.name)).status, 'landed');
});

test('a merge the verifier landed before deliver could record it is recorded, never landed twice', async t => {
  const root = repo(t); await verified(root); const p = await run('prepare', 'test', { root }); assert.equal(waitFor(root, p.request), 0);
  const rel = spawnSync(process.execPath, [new URL('../scripts/verify/verify.mjs', import.meta.url).pathname, 'release', p.request, '--in', root], { encoding: 'utf8' });
  assert.equal(rel.status, 0, rel.stdout + rel.stderr); const tip = git(root, 'rev-parse', 'HEAD');
  const d = await run('deliver', 'test', { root }); assert.equal(d.status, 'landed'); assert.equal(d.mergedHead, tip); assert.equal(git(root, 'rev-parse', 'HEAD'), tip);
});
test('legacy metadata keeps original branch checks and defaults to thorough', async t => {
  const root = repo(t); const m = await verified(root); const saved = JSON.parse(fs.readFileSync(metadata(m), 'utf8'));
  delete saved.targetBranch; delete saved.targetStartHead; delete saved.profile; fs.writeFileSync(metadata(m), JSON.stringify(saved));
  assert.equal((await run('status', m.name, { root })).profile, 'thorough');
  const p = await run('prepare', m.name, { root }); waitFor(root, p.request); git(root, 'checkout', '-b', 'other');
  await assert.rejects(run('deliver', m.name, { root }), /Origin branch changed/);
  git(root, 'checkout', 'work'); assert.equal((await run('deliver', m.name, { root })).status, 'landed');
});
test('approval persists validated profile but cannot change target or clear human review', async t => {
  const root = repo(t); const m = await verified(root); git(root, 'branch', 'other');
  await assert.rejects(run('approve', m.name, { root, profile: 'rush', into: 'other' }), /immutable/);
  await assert.rejects(run('approve', m.name, { root, profile: 'invalid' }), /Invalid profile/);
  const approved = await run('approve', m.name, { root, profile: 'standard', into: 'work' }); assert.equal(approved.profile, 'standard'); assert.equal(approved.profileApproved, true); assert.equal(approved.verifiedHead, null);
  await run('await-human', m.name, { root }); await run('approve', m.name, { root, profile: 'thorough-you' });
  assert.equal((await run('resume', m.name, { root })).awaitingHuman, true);
  await assert.rejects(run('checkpoint', m.name, { root, phase: 'verified', next: 'Skip walk', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') }), /real human walk report/);
  await assert.rejects(run('human-pass', m.name, { root }), /requires --report/);
  commit(m.worktree, 'review-notes.txt', 'Committed before human walk\n');
  const walked = await run('human-pass', m.name, { root, report: 'User tested the save flow and reported it passed' }); assert.equal(walked.awaitingHuman, false); assert.equal(walked.phase, 'signed-off'); assert.equal(walked.verifiedHead, null);
  assert.equal(walked.humanHead, git(m.worktree, 'rev-parse', 'HEAD'));
  await run('checkpoint', m.name, { root, phase: 'verified', next: 'Prepare', verifiedHead: walked.humanHead });
  commit(m.worktree, 'changed-after-walk.txt');
  await assert.rejects(run('checkpoint', m.name, { root, phase: 'verified', next: 'Skip new walk', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') }), /human walk report at exact current HEAD/);
});
test('custom full+human requires a recorded walk and merged work cannot be reopened', async t => {
  const root = repo(t); const m = await verified(root);
  const approved = await run('approve', m.name, { root, profile: 'custom testing=full+human' }); assert.equal(approved.awaitingHuman, true);
  assert.match(fs.readFileSync(path.join(m.featurePath, 'MANIFEST.md'), 'utf8'), /profile: custom testing=full\+human/);
  commit(m.worktree, 'before-walk.txt');
  await assert.rejects(run('checkpoint', m.name, { root, phase: 'verified', next: 'Prepare', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') }), /requires a real human walk report/);
  await run('human-pass', m.name, { root, report: 'User reported all changed screens passed' });
  await run('checkpoint', m.name, { root, phase: 'verified', next: 'Prepare', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') });
  assert.equal((await landFeature(root, m.name)).status, 'landed');
  for (const command of ['checkpoint', 'approve', 'pause', 'unpause', 'await-human', 'human-pass', 'prepare', 'deliver']) await assert.rejects(run(command, m.name, { root, phase: 'building', next: 'Reopen', profile: 'rush', report: 'pass' }), /Merged feature is read-only/);
});
test('explicitly reserved human walk remains required across profile changes and subsequent edits', async t => {
  const root = repo(t); const m = await verified(root);
  await run('await-human', m.name, { root }); const approved = await run('approve', m.name, { root, profile: 'standard' });
  assert.equal(approved.humanWalkRequired, true); assert.equal(approved.awaitingHuman, true);
  commit(m.worktree, 'walk-ready.txt'); await run('human-pass', m.name, { root, report: 'User confirmed the reserved human walk passed' });
  commit(m.worktree, 'after-human.txt');
  await assert.rejects(run('checkpoint', m.name, { root, phase: 'verified', next: 'Prepare', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') }), /human walk report at exact current HEAD/);
});
test('target-based start transfers committed planning artifacts without source code or manifest identity', async t => {
  const root = repo(t); git(root, 'branch', 'main');
  const docs = path.join(root, 'docs/features/planned'); fs.mkdirSync(docs, { recursive: true });
  for (const name of ['SPEC.md', 'PLAN.md', 'brainstorm.md', 'continue.md', 'ledger.md']) fs.writeFileSync(path.join(docs, name), `Source ${name}\n\n`);
  fs.writeFileSync(path.join(docs, 'MANIFEST.md'), 'branch: source-identity\n');
  commit(root, 'seed.txt', 'source code differs\n'); fs.writeFileSync(path.join(docs, 'SPEC.md'), 'uncommitted spec edit\n');
  const m = await run('start', 'planned', { root, into: 'main' });
  assert.equal(fs.readFileSync(path.join(m.worktree, 'seed.txt'), 'utf8'), 'seed\n');
  assert.equal(fs.readFileSync(path.join(m.featurePath, 'SPEC.md'), 'utf8'), 'Source SPEC.md\n\n'); assert.equal(m.importedArtifacts.length, 5);
  assert.equal(fs.existsSync(path.join(m.featurePath, 'MANIFEST.md')), false); assert.notEqual(git(m.worktree, 'status', '--porcelain'), '');
  assert.equal(fs.readFileSync(path.join(docs, 'SPEC.md'), 'utf8'), 'uncommitted spec edit\n');
});
test('planning imports reject symlink ancestors without external writes and retain recoverable identity', async t => {
  const root = repo(t); const external = path.join(path.dirname(root), 'external'); fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(root, 'docs')); git(root, 'add', '.'); git(root, 'commit', '-m', 'target docs symlink'); git(root, 'branch', 'main');
  fs.unlinkSync(path.join(root, 'docs')); const docs = path.join(root, 'docs/features/copied'); fs.mkdirSync(docs, { recursive: true }); fs.writeFileSync(path.join(docs, 'PLAN.md'), 'committed source plan\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'source planning directory');
  await assert.rejects(run('start', 'copied', { root, into: 'main' }), /contains a symlink/);
  assert.deepEqual(fs.readdirSync(external), []);
  const retained = await run('resume', 'copied', { root }); assert.equal(retained.importState, 'failed'); assert.equal(retained.targetBranch, 'main'); assert.equal(retained.importedArtifacts.length, 0);
  assert.equal(git(retained.worktree, 'status', '--porcelain'), '');
  for (const command of ['approve', 'checkpoint', 'prepare', 'deliver']) await assert.rejects(run(command, retained.name, { root, profile: 'rush', phase: 'verified', next: 'Continue', verifiedHead: git(retained.worktree, 'rev-parse', 'HEAD') }), /import is incomplete/);
  fs.unlinkSync(path.join(retained.worktree, 'docs')); fs.mkdirSync(retained.featurePath, { recursive: true });
  fs.writeFileSync(path.join(retained.featurePath, 'PLAN.md'), 'my local plan\n');
  await assert.rejects(run('retry-import', retained.name, { root }), /refusing to overwrite/); assert.equal(fs.readFileSync(path.join(retained.featurePath, 'PLAN.md'), 'utf8'), 'my local plan\n');
  fs.unlinkSync(path.join(retained.featurePath, 'PLAN.md'));
  const recovered = await run('retry-import', retained.name, { root }); assert.equal(recovered.importState, 'complete'); assert.equal(recovered.importError, undefined);
  assert.equal(fs.readFileSync(path.join(retained.featurePath, 'PLAN.md'), 'utf8'), 'committed source plan\n'); assert.deepEqual(fs.readdirSync(external), []);
});
test('interrupted planning import retry preserves already imported edits and accepts unrecorded exact writes', async t => {
  const root = repo(t); git(root, 'branch', 'main');
  const docs = path.join(root, 'docs/features/interrupted'); fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, 'SPEC.md'), 'source spec\n'); fs.writeFileSync(path.join(docs, 'PLAN.md'), 'source plan\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'source docs');
  const m = await run('start', 'interrupted', { root, into: 'main' }); const saved = JSON.parse(fs.readFileSync(metadata(m), 'utf8'));
  saved.importState = 'pending'; saved.importedArtifacts = ['docs/features/interrupted/SPEC.md']; fs.writeFileSync(metadata(m), JSON.stringify(saved));
  fs.writeFileSync(path.join(m.featurePath, 'SPEC.md'), 'my amended imported spec\n');
  await assert.rejects(run('retry-import', m.name, { root }), /refusing to overwrite/); assert.equal(fs.readFileSync(path.join(m.featurePath, 'SPEC.md'), 'utf8'), 'my amended imported spec\n');
  fs.writeFileSync(path.join(m.featurePath, 'SPEC.md'), 'source spec\n');
  const resumed = await run('retry-import', m.name, { root }); assert.equal(resumed.importState, 'complete'); assert.equal(resumed.importedArtifacts.length, 2);
});
test('manifest writes reject symlink files and leave external content and metadata untouched', async t => {
  const root = repo(t); const m = await run('start', 'manifest-link', { root });
  const external = path.join(path.dirname(root), 'external-manifest'); fs.writeFileSync(external, 'outside content\n');
  fs.mkdirSync(m.featurePath, { recursive: true }); fs.symlinkSync(external, path.join(m.featurePath, 'MANIFEST.md'));
  await assert.rejects(run('checkpoint', m.name, { root, phase: 'building', next: 'Continue' }), /contains a symlink/);
  assert.equal(fs.readFileSync(external, 'utf8'), 'outside content\n'); assert.equal((await run('status', m.name, { root })).phase, 'exploring');
});
test('archived landing target prevents restarting stale source planning artifacts without runtime metadata', async t => {
  const root = repo(t); const base = git(root, 'rev-parse', 'HEAD');
  const archive = path.join(root, 'docs/features/_archive/finished'); fs.mkdirSync(archive, { recursive: true }); fs.writeFileSync(path.join(archive, 'SPEC.md'), 'shipped spec\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'archived feature'); git(root, 'branch', 'main'); git(root, 'reset', '--hard', base);
  const stale = path.join(root, 'docs/features/finished'); fs.mkdirSync(stale, { recursive: true }); fs.writeFileSync(path.join(stale, 'SPEC.md'), 'stale source plan\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'stale source artifacts');
  await assert.rejects(run('start', 'finished', { root, into: 'main' }), /already archived on the landing target/); assert.equal(git(root, 'branch', '--list', 'builder/finished'), '');
});
test('merge_into: current lands on the branch the feature starts from; a builder/* branch or detached HEAD falls back to base_branch', async t => {
  const root = repo(t); git(root, 'branch', 'main');
  configure(root, 'merge_into: current\nbase_branch: main\n');
  assert.equal((await run('start', 'on-work', { root })).targetBranch, 'work');
  git(root, 'checkout', '-b', 'builder/elsewhere'); assert.equal((await run('start', 'on-builder', { root })).targetBranch, 'main');
  git(root, 'checkout', '--detach'); assert.equal((await run('start', 'detached-current', { root })).targetBranch, 'main');
});
test('approval records a walk · review test plan, mirrors it as tests:, labels the list and human=yes waits for a human', async t => {
  const root = repo(t); const m = await verified(root);
  await assert.rejects(run('approve', m.name, { root, tests: 'walk=bogus' }), /Invalid test plan/);
  await assert.rejects(run('approve', m.name, { root, tests: 'walk=none', profile: 'rush' }), /not both/);
  const approved = await run('approve', m.name, { root, tests: 'walk=risk' });
  assert.equal(approved.tests, 'walk=risk review=end'); assert.equal(approved.profileApproved, true); assert.equal(approved.awaitingHuman, undefined);
  const manifest = fs.readFileSync(path.join(m.featurePath, 'MANIFEST.md'), 'utf8');
  assert.match(manifest, /^tests: walk=risk review=end$/m); assert.doesNotMatch(manifest, /^profile:/m);
  assert.equal((await run('list', undefined, { root })).find(r => r.name === m.name).profileLabel, 'risk · end');
  const old = await run('approve', m.name, { root, tests: 'slice=own end=everything review=app' });
  assert.equal(old.tests, 'walk=full review=app', 'a 5.x value is mapped, never stored as written');
  const you = await run('approve', m.name, { root, tests: 'walk=full review=slice human=yes' }); assert.equal(you.awaitingHuman, true);
  const youOld = await run('approve', m.name, { root, tests: 'slice=own end=everything review=slice walk=you' }); assert.equal(youOld.tests, 'walk=full review=slice human=yes'); assert.equal(youOld.awaitingHuman, true);
  const legacy = await run('approve', m.name, { root, profile: 'rush' }); assert.equal(legacy.tests, undefined); assert.equal(legacy.profile, 'rush');
  assert.match(fs.readFileSync(path.join(m.featurePath, 'MANIFEST.md'), 'utf8'), /^profile: rush$/m);
});
test('start\'s profile placeholder is not mirrored as a plan; a stale tests line never outranks a later approval', async t => {
  const root = repo(t); const m = await run('start', 'plain', { root });
  await run('checkpoint', 'plain', { root, phase: 'planned', next: 'Go-ahead' });
  const manifest = () => fs.readFileSync(path.join(m.featurePath, 'MANIFEST.md'), 'utf8');
  assert.doesNotMatch(manifest(), /^(profile|tests):/m, 'no plan before the go-ahead');
  await run('approve', 'plain', { root, tests: 'walk=risk' }); assert.match(manifest(), /^tests: walk=risk review=end$/m);
  await run('approve', 'plain', { root, profile: 'standard' }); assert.doesNotMatch(manifest(), /^tests:/m); assert.match(manifest(), /^profile: standard$/m);
});
test('merge_into: current with no base_branch refuses a detached checkout instead of inventing main', async t => {
  const root = repo(t); git(root, 'branch', 'main'); configure(root, 'merge_into: current\n');
  assert.equal((await run('start', 'cur-work', { root })).targetBranch, 'work');
  git(root, 'checkout', '--detach'); await assert.rejects(run('start', 'cur-detached', { root }), /merge_into: current needs a named branch/);
});
