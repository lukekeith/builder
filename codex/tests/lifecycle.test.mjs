import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { run } from '../scripts/lifecycle.mjs';
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-lifecycle-'));
  const root = path.join(folder, 'repo'); fs.mkdirSync(root);
  git(root, 'init', '-b', 'work'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'seed');
  t.after(() => fs.rmSync(folder, { recursive: true, force: true })); return root;
}
function commit(root, file = 'feature.txt', text = 'feature\n') { fs.writeFileSync(path.join(root, file), text); git(root, 'add', '.'); git(root, 'commit', '-m', file); return git(root, 'rev-parse', 'HEAD'); }
async function verified(root, name = 'test') {
  const m = await run('start', name, { root }); commit(m.worktree);
  await run('checkpoint', name, { root, phase: 'verified', next: 'Prepare candidate', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') }); return m;
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
test('prepare uses current starting branch and delivery fastforwards exact verified candidate; cleanup retains evidence', async t => {
  const root = repo(t); const m = await verified(root); const advanced = commit(root, 'other.txt', 'independent\n');
  const p = await run('prepare', 'test', { root }); assert.equal(p.integration.targetHead, advanced); assert.ok(fs.existsSync(p.candidatePath));
  assert.equal(git(root, 'rev-parse', 'HEAD'), advanced); assert.equal((await run('prepare', 'test', { root })).candidateHead, p.candidateHead);
  await assert.rejects(run('deliver', 'test', { root, verifiedHead: m.originHead }), /exact verified candidate/);
  const result = await run('deliver', 'test', { root, verifiedHead: p.candidateHead }); assert.equal(result.phase, 'merged'); assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), 'work');
  assert.equal(git(root, 'rev-parse', 'HEAD'), p.candidateHead); assert.equal(fs.readFileSync(path.join(root, 'feature.txt'), 'utf8'), 'feature\n');
  await run('cleanup', 'test', { root }); assert.ok(!fs.existsSync(m.worktree));
  const saved = await run('resume', 'test', { root }); assert.equal(saved.cleaned, true); assert.equal(saved.verifiedHead, p.integration.featureHead); assert.equal(saved.mergedHead, p.candidateHead);
});
test('delivery refuses stale target or feature commits', async t => {
  const root = repo(t); const m = await verified(root); const p = await run('prepare', 'test', { root });
  commit(root, 'advance.txt'); await assert.rejects(run('deliver', 'test', { root, verifiedHead: p.candidateHead }), /Origin advanced/);
  assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), 'work');
  const root2 = repo(t); const m2 = await verified(root2); const p2 = await run('prepare', 'test', { root: root2 });
  commit(m2.worktree, 'late.txt'); await assert.rejects(run('deliver', 'test', { root: root2, verifiedHead: p2.candidateHead }), /must remain verified/);
});
test('dirty target, feature and candidate checkouts block delivery; switched origin does not retarget delivery', async t => {
  const root = repo(t); const m = await verified(root); const p = await run('prepare', 'test', { root });
  fs.writeFileSync(path.join(root, 'dirty.txt'), 'dirty'); await assert.rejects(run('deliver', 'test', { root, verifiedHead: p.candidateHead }), /Origin checkout must be clean/); fs.unlinkSync(path.join(root, 'dirty.txt'));
  fs.writeFileSync(path.join(m.worktree, 'dirty.txt'), 'dirty'); await assert.rejects(run('deliver', 'test', { root, verifiedHead: p.candidateHead }), /Feature changed/); fs.unlinkSync(path.join(m.worktree, 'dirty.txt'));
  fs.writeFileSync(path.join(p.candidatePath, 'dirty.txt'), 'dirty'); await assert.rejects(run('deliver', 'test', { root, verifiedHead: p.candidateHead }), /candidate must retain/); fs.unlinkSync(path.join(p.candidatePath, 'dirty.txt'));
  git(root, 'checkout', '-b', 'different');
  await run('deliver', 'test', { root, verifiedHead: p.candidateHead });
  assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), 'different'); assert.equal(git(root, 'rev-parse', 'HEAD'), m.originHead);
  assert.equal(git(root, 'rev-parse', 'work'), p.candidateHead);
});
test('resume rejects rewritten ancestry and wrong feature branch', async t => {
  const root = repo(t); const m = await verified(root);
  git(m.worktree, 'checkout', '-b', 'wrong'); await assert.rejects(run('resume', 'test', { root }), /Feature worktree branch changed/);
  git(m.worktree, 'checkout', m.featureBranch); git(m.worktree, 'checkout', '--orphan', 'rewritten'); git(m.worktree, 'add', '.'); git(m.worktree, 'commit', '-m', 'unrelated');
  git(m.worktree, 'branch', '-f', m.featureBranch, 'HEAD'); git(m.worktree, 'checkout', m.featureBranch);
  await assert.rejects(run('resume', 'test', { root }), /no longer descends/);
});
test('prepare refuses unverified and dirty features; in-flight origin operations are blocked', async t => {
  const root = repo(t); const m = await run('start', 'test', { root });
  await assert.rejects(run('prepare', 'test', { root }), /must be verified/);
  commit(m.worktree); await run('checkpoint', 'test', { root, phase: 'verified', next: 'Prepare', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') });
  fs.writeFileSync(path.join(m.worktree, 'dirty.txt'), 'dirty'); await assert.rejects(run('prepare', 'test', { root }), /Feature worktree must be clean/); fs.unlinkSync(path.join(m.worktree, 'dirty.txt'));
  const mergeHead = path.resolve(root, git(root, 'rev-parse', '--git-path', 'MERGE_HEAD')); fs.writeFileSync(mergeHead, `${m.originHead}\n`);
  await assert.rejects(run('prepare', 'test', { root }), /Git operation in progress/); fs.unlinkSync(mergeHead);
});
test('prepare retains conflicted candidate and resumes after explicit conflict resolution', async t => {
  const root = repo(t); const m = await run('start', 'conflict', { root });
  commit(m.worktree, 'seed.txt', 'feature version\n'); await run('checkpoint', 'conflict', { root, phase: 'verified', next: 'Prepare', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') });
  commit(root, 'seed.txt', 'origin version\n'); await assert.rejects(run('prepare', 'conflict', { root }));
  const saved = await run('resume', 'conflict', { root }); assert.ok(saved.integration); assert.equal(saved.integration.candidateHead, null);
  fs.writeFileSync(path.join(saved.integration.worktree, 'seed.txt'), 'combined version\n'); git(saved.integration.worktree, 'add', 'seed.txt'); git(saved.integration.worktree, 'commit', '-m', 'Resolve integration conflict');
  const candidate = await run('prepare', 'conflict', { root }); assert.equal(candidate.candidateHead, git(saved.integration.worktree, 'rev-parse', 'HEAD'));
  await run('deliver', 'conflict', { root, verifiedHead: candidate.candidateHead });
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
test('prepare refreshes target advancement and intentional candidate fixes without resetting', async t => {
  const root = repo(t); const m = await verified(root); const first = await run('prepare', 'test', { root });
  const target = commit(root, 'advanced.txt'); await assert.rejects(run('deliver', 'test', { root, verifiedHead: first.candidateHead }), /Origin advanced/);
  const second = await run('prepare', 'test', { root }); assert.equal(second.integration.targetHead, target); assert.notEqual(second.candidateHead, first.candidateHead);
  const fix = commit(second.candidatePath, 'integration-fix.txt', 'fix\n');
  await assert.rejects(run('deliver', 'test', { root, verifiedHead: fix }), /exact verified candidate/);
  const refreshed = await run('prepare', 'test', { root }); assert.equal(refreshed.candidateHead, fix);
  await run('deliver', 'test', { root, verifiedHead: fix }); assert.equal(fs.readFileSync(path.join(root, 'integration-fix.txt'), 'utf8'), 'fix\n');
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
  const p = await run('prepare', m.name, { root }); await run('deliver', m.name, { root, verifiedHead: p.candidateHead });
  assert.equal(git(root, 'rev-parse', 'HEAD'), detachedHead); assert.equal(git(root, 'rev-parse', 'main'), p.candidateHead);
  configure(root, 'base_branch: main\n'); assert.equal((await run('start', 'detached-config', { root })).targetBranch, 'main');
});
test('delivery finds a target checked out elsewhere and preserves switched dirty origin', async t => {
  const root = repo(t); const m = await verified(root); const originHead = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-b', 'other'); const targetRoot = path.join(path.dirname(root), 'target'); git(root, 'worktree', 'add', targetRoot, 'work');
  fs.writeFileSync(path.join(root, 'private.txt'), 'origin local edits\n'); const originDirty = git(root, 'status', '--porcelain');
  fs.writeFileSync(path.join(targetRoot, 'local.txt'), 'target local edits\n');
  await assert.rejects(run('prepare', m.name, { root }), /Landing target checkout must be clean/); fs.unlinkSync(path.join(targetRoot, 'local.txt'));
  const p = await run('prepare', m.name, { root });
  fs.writeFileSync(path.join(targetRoot, 'local.txt'), 'late target edits\n');
  await assert.rejects(run('deliver', m.name, { root, verifiedHead: p.candidateHead }), /Landing target checkout must be clean/); fs.unlinkSync(path.join(targetRoot, 'local.txt'));
  await run('deliver', m.name, { root, verifiedHead: p.candidateHead });
  assert.equal(git(targetRoot, 'rev-parse', 'HEAD'), p.candidateHead); assert.equal(fs.readFileSync(path.join(targetRoot, 'feature.txt'), 'utf8'), 'feature\n');
  assert.equal(git(root, 'status', '--porcelain'), originDirty); assert.equal(git(root, 'rev-parse', 'HEAD'), originHead);
  await run('cleanup', m.name, { root }); assert.equal(fs.existsSync(m.worktree), false);
  await assert.rejects(run('start', m.name, { root }), /already merged/);
});
test('unchecked target CAS refuses a ref advanced immediately before update', async t => {
  const root = repo(t); const m = await verified(root); const p = await run('prepare', m.name, { root });
  git(root, 'checkout', '-b', 'other'); const concurrentHead = commit(root, 'concurrent.txt');
  const bin = path.join(path.dirname(root), 'bin'); fs.mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nif [ "$3" = update-ref ] && [ "$4" = refs/heads/work ]; then\n  "$BUILDER_REAL_GIT" -C "$2" update-ref "$4" "$BUILDER_RACE_HEAD" "$6" || exit\nfi\nexec "$BUILDER_REAL_GIT" "$@"\n', { mode: 0o755 });
  const delivery = spawnSync(process.execPath, [new URL('../scripts/lifecycle.mjs', import.meta.url).pathname, 'deliver', m.name, '--root', root, '--verified-head', p.candidateHead], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, BUILDER_REAL_GIT: realGit, BUILDER_RACE_HEAD: concurrentHead } });
  assert.equal(delivery.status, 1); assert.match(delivery.stderr, /cannot lock ref.*expected/);
  assert.equal(git(root, 'rev-parse', 'work'), concurrentHead); assert.equal((await run('status', m.name, { root })).phase, 'verified');
});
test('pause survives cold resume and checkpoint attempts; unpause restores phase without proofs', async t => {
  const root = repo(t); const m = await verified(root); const p = await run('prepare', m.name, { root });
  const paused = await run('pause', m.name, { root }); assert.equal(paused.paused, true); assert.equal(paused.pauseState.phase, 'verified'); assert.equal(paused.verifiedHead, null); assert.equal(paused.integration.candidateHead, null);
  const cold = JSON.parse(execFileSync(process.execPath, [new URL('../scripts/lifecycle.mjs', import.meta.url).pathname, 'resume', m.name, '--root', root], { encoding: 'utf8' })); assert.equal(cold.paused, true);
  for (const command of ['prepare', 'deliver', 'approve', 'checkpoint']) await assert.rejects(run(command, m.name, { root, phase: 'verified', next: 'Skip pause', verifiedHead: p.candidateHead, profile: 'rush' }), /paused/);
  await run('pause', m.name, { root }); const resumed = await run('unpause', m.name, { root }); assert.equal(resumed.phase, 'verified'); assert.equal(resumed.verifiedHead, null); assert.equal(resumed.integration.candidateHead, null);
  await assert.rejects(run('prepare', m.name, { root }), /exact current HEAD/); await assert.rejects(run('deliver', m.name, { root, verifiedHead: p.candidateHead }), /Prepare an integration candidate/);
  await run('checkpoint', m.name, { root, phase: 'verified', next: 'Prepare again', verifiedHead: git(m.worktree, 'rev-parse', 'HEAD') });
  const fresh = await run('prepare', m.name, { root }); await run('deliver', m.name, { root, verifiedHead: fresh.candidateHead });
});
test('legacy metadata keeps original branch checks and defaults to thorough', async t => {
  const root = repo(t); const m = await verified(root); const saved = JSON.parse(fs.readFileSync(metadata(m), 'utf8'));
  delete saved.targetBranch; delete saved.targetStartHead; delete saved.profile; fs.writeFileSync(metadata(m), JSON.stringify(saved));
  assert.equal((await run('status', m.name, { root })).profile, 'thorough');
  const p = await run('prepare', m.name, { root }); git(root, 'checkout', '-b', 'other');
  await assert.rejects(run('deliver', m.name, { root, verifiedHead: p.candidateHead }), /Origin branch changed/);
  git(root, 'checkout', 'work'); await run('deliver', m.name, { root, verifiedHead: p.candidateHead });
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
  const p = await run('prepare', m.name, { root }); await run('deliver', m.name, { root, verifiedHead: p.candidateHead });
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
