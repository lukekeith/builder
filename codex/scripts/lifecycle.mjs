#!/usr/bin/env node
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWalkReadiness, landedMigrations, wrapUp, needsYou, needsYouNext, stashName } from './landing.mjs';
import { agentOffer, buildingInSession } from './offer.mjs';

const VERIFY = fileURLToPath(new URL('./verify/verify.mjs', import.meta.url));

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const head = root => git(root, 'rev-parse', 'HEAD');
const dirty = root => git(root, 'status', '--porcelain', '--untracked-files=all');
function assert(ok, message) { if (!ok) throw new Error(message); }
function branch(root, optional = false) { try { return git(root, 'symbolic-ref', '--short', 'HEAD'); } catch { if (optional) return null; throw new Error('Detached HEAD is not supported without an explicit or configured target'); } }
function common(root) { return path.resolve(root, git(root, 'rev-parse', '--git-common-dir')); }
function location(root, name) {
  assert(/^[a-z0-9][a-z0-9-]{0,79}$/.test(name), 'Invalid feature name: use lowercase letters, digits and hyphens');
  return path.join(common(root), 'builder-codex', 'features', `${name}.json`);
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}
function read(root, name) { const file = location(root, name); assert(fs.existsSync(file), `Unknown feature: ${name}`); return [file, JSON.parse(fs.readFileSync(file, 'utf8'))]; }
function existsBranch(root, name) { try { git(root, 'show-ref', '--verify', `refs/heads/${name}`); return true; } catch { return false; } }
function ancestor(root, older, newer) { try { git(root, 'merge-base', '--is-ancestor', older, newer); return true; } catch { return false; } }
function idle(root) {
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    assert(!fs.existsSync(path.resolve(root, git(root, 'rev-parse', '--git-path', marker))), `Git operation in progress: ${marker}`);
  }
}
function identity(m) {
  assert(fs.existsSync(m.worktree), 'Feature worktree is missing; metadata retained');
  assert(git(m.worktree, 'rev-parse', '--show-toplevel') === m.worktree, 'Feature worktree root changed');
  assert(branch(m.worktree) === m.featureBranch, 'Feature worktree branch changed');
  assert(common(m.worktree) === m.commonDir, 'Feature worktree repository changed');
  assert(ancestor(m.worktree, m.targetStartHead || m.originHead, head(m.worktree)), 'Feature no longer descends from its starting commit');
  if (m.checkpointHead) assert(ancestor(m.worktree, m.checkpointHead, head(m.worktree)), 'Recorded checkpoint commit is not in feature ancestry');
  if (m.verifiedHead) assert(ancestor(m.worktree, m.verifiedHead, head(m.worktree)), 'Recorded verified commit is not in feature ancestry');
}
function originReady(m) {
  assert(git(m.originRoot, 'rev-parse', '--show-toplevel') === m.originRoot, 'Origin root changed');
  assert(common(m.originRoot) === m.commonDir, 'Origin repository changed');
  assert(branch(m.originRoot) === m.originBranch, 'Origin branch changed');
  idle(m.originRoot);
}
const targetBranch = m => m.targetBranch || m.originBranch;
/**
 * Where the target is checked out (if anywhere) and its tip. Uncommitted changes there are no
 * block by themselves: the verifier's release lands around changes that don't overlap the feature,
 * and refuses — before any write — those that do (a needs-you, below).
 */
function targetReady(m) {
  // Old records deliberately retain the original checkout/branch contract.
  if (!m.targetBranch) { originReady(m); return { worktree: m.originRoot, head: head(m.originRoot) }; }
  assert(git(m.originRoot, 'rev-parse', '--show-toplevel') === m.originRoot && common(m.originRoot) === m.commonDir, 'Origin repository changed');
  assert(existsBranch(m.originRoot, m.targetBranch), 'Landing target branch is missing');
  const records = git(m.originRoot, 'worktree', 'list', '--porcelain', '-z').split('\0\0');
  const targets = records.map(record => record.split('\0')).filter(fields => fields.includes(`branch refs/heads/${m.targetBranch}`));
  assert(targets.length <= 1, 'Landing target is checked out in multiple worktrees');
  const worktree = targets[0]?.find(field => field.startsWith('worktree '))?.slice(9);
  if (worktree) {
    assert(fs.existsSync(worktree) && common(worktree) === m.commonDir && branch(worktree) === m.targetBranch, 'Landing target worktree changed');
    idle(worktree);
  }
  return { worktree, head: git(m.originRoot, 'rev-parse', `refs/heads/${m.targetBranch}`) };
}
function invalidate(m) { m.verifiedHead = null; m.check = null; }
/** Signed off: the walk passed (a human walk report, the agent walk, or a recorded no-walk). Verify is optional after it. */
const SIGNED_OFF = ['signed-off', 'verified'];
const today = () => process.env.BUILDER_TODAY || new Date().toISOString().slice(0, 10);
/**
 * Which check holds for `now` (6.1.0: verify is optional after sign-off) — `full` the verified
 * checkpoint, `quick` verify-quick.mjs, `skipped` the owner's ship-it, `none` neither. A full or
 * quick check holds on the commit it ran on and over registry-only commits after it.
 */
function checkRan(m, now) {
  const holds = sha => Boolean(sha) && (sha === now || (ancestor(m.worktree, sha, now) && docsOnly(m.worktree, sha, now, m.registry)));
  if (holds(m.verifiedHead)) return 'full';
  if (m.check?.kind === 'quick' && holds(m.check.head)) return 'quick';
  if (m.check?.kind === 'skipped') return 'skipped';
  return 'none';
}

// ---- Landing through the verifier's merge queue (docs/plans/2026-11-01-codex-6-port.md Decision 3) 
const lines = text => String(text ?? '').split('\n').filter(Boolean);
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
function verifyCli(cwd, ...args) {
  const r = spawnSync(process.execPath, [VERIFY, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() };
}
/** The verifier's main checkout and its ledger (requests and verdicts live there for every worktree). */
async function verifier(m) {
  const [{ openLedger }, { mainRoot }] = await Promise.all([import('./verify/ledger.mjs'), import('./verify/git.mjs')]);
  const root = mainRoot(m.originRoot);
  return { root, ledger: openLedger(root) };
}
/**
 * The verifier lands only into the main checkout or a branch checked out nowhere: a target checked
 * out in another linked worktree would be left behind its own branch. Refused before anything is
 * requested, with what to do.
 */
function landable(m, target, root) {
  if (!target.worktree || real(target.worktree) === real(root)) return;
  throw new Error(`${targetBranch(m)} is checked out in ${target.worktree}, and the verifier lands only into the main checkout (${root}) or a branch checked out nowhere — next: switch ${target.worktree} to another branch (or leave it for now), then run prepare again`);
}
const PENDING = ['queued', 'running', 'folded'];
/** Ask the merge tier to test the feature merged onto the target's tip, held until delivery releases it. */
function requestMerge(m, target) {
  const featureHead = head(m.worktree);
  const r = verifyCli(m.worktree, 'request', m.worktree, featureHead, '--tier', 'merge', '--hold', '--target', targetBranch(m), '--message', `Merge builder feature ${m.name}`);
  assert(r.code === 0 && /^\S+$/.test(r.out), `The verifier did not take the merge request: ${r.err || r.out}`);
  m.merge = { request: r.out, featureHead, targetHead: target.head, requestedAt: new Date().toISOString() };
  return m.merge;
}
/** The owner's uncommitted changes in the target checkout that the feature's changes `from..to` would run into. */
async function overlapOf(target, root, from, to) {
  if (!target.worktree || real(target.worktree) !== real(root)) return [];
  const { landOverlap } = await import('./verify/checkouts.mjs');
  return landOverlap(target.worktree, from, to);
}
/** True when `from..to` changes only the feature registry — what the verifier's `carry` lands without a second run. */
function docsOnly(root, from, to, registry) {
  const prefix = `${String(registry || 'docs/features').replace(/\/+$/, '')}/`;
  return lines(git(root, 'diff', '--name-only', '--no-renames', from, to)).every(f => f.startsWith(prefix));
}
const stashes = wt => lines(git(wt, 'stash', 'list', '--format=%gd%x09%H%x09%gs')).map(l => { const [ref, sha, subject] = l.split('\t'); return { ref, sha, subject }; });
/**
 * Commit exactly the owner's changes on the target: every tracked change, and the untracked files
 * the feature adds too (`overlap`) — never another untracked or ignored file. A refused commit (a
 * hook) puts the index back. → { sha, files } | { sha: null } (nothing to commit).
 */
function commitMine(wt, message, overlap) {
  const index = git(wt, 'write-tree');
  const untracked = new Set(lines(git(wt, 'ls-files', '--others', '--exclude-standard')));
  try {
    git(wt, 'add', '-u');
    const extra = overlap.filter(f => untracked.has(f));
    if (extra.length) git(wt, 'add', '--', ...extra);
    try { git(wt, 'diff', '--cached', '--quiet'); return { sha: null }; } catch { /* staged changes: commit them */ }
    git(wt, 'commit', '-q', '-m', message);
  } catch (error) {
    try { git(wt, 'read-tree', index); } catch { /* best effort */ }
    throw new Error(`git refused the commit of your changes: ${String(error.stderr || error.message).trim().split('\n').slice(-2).join(' ')} — your changes are as you left them`);
  }
  return { sha: head(wt), files: lines(git(wt, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')) };
}
/** Set every uncommitted change aside (untracked included, ignored never) in a named stash, found by its sha. */
function setAside(wt, feature) {
  if (!dirty(wt)) return { sha: null };
  const before = new Set(stashes(wt).map(s => s.sha));
  git(wt, 'stash', 'push', '-q', '--include-untracked', '-m', stashName(feature));
  const mine = stashes(wt).find(s => !before.has(s.sha) && s.subject.endsWith(`: ${stashName(feature)}`));
  assert(mine, `git set your changes aside but the stash "${stashName(feature)}" can't be found — git stash list`);
  return { sha: mine.sha, name: stashName(feature) };
}
/**
 * Put a set-aside stash back. Clean → that one entry is dropped. Otherwise the stash is kept —
 * never dropped, never force-resolved — and the files that need the owner are named: those with
 * conflicts, and untracked ones git could not restore (the feature added the same path).
 */
function putBack(wt, aside) {
  try {
    git(wt, 'stash', 'apply', '-q', aside.sha);
    const s = stashes(wt).find(x => x.sha === aside.sha);
    if (s) git(wt, 'stash', 'drop', '-q', s.ref);
    return { clean: true };
  } catch { /* reported below */ }
  const unmerged = lines((() => { try { return git(wt, 'diff', '--name-only', '--diff-filter=U'); } catch { return ''; } })());
  let notBack = [];
  try {
    notBack = lines(git(wt, 'ls-tree', '-r', '--name-only', `${aside.sha}^3`)).filter(p => {
      let now = null;
      try { now = fs.existsSync(path.join(wt, p)) ? git(wt, 'hash-object', '--', p) : null; } catch { /* unreadable */ }
      return now !== git(wt, 'rev-parse', `${aside.sha}^3:${p}`);
    });
  } catch { /* no untracked part */ }
  const ref = stashes(wt).find(x => x.sha === aside.sha)?.ref ?? null;
  const files = [...new Set([...unmerged, ...notBack])];
  return { clean: false, files, unmerged, notBack, stash: aside.sha, ref, note: `your changes came back with conflicts in ${files.length ? files.join(', ') : 'files git did not name'}; nothing of yours was dropped — it is all still in the stash "${aside.name}" (${ref ? `${ref}, ` : ''}${aside.sha.slice(0, 7)}): resolve those files${unmerged.length ? `, git add -- ${unmerged.join(' ')}` : ''}, then git stash drop ${ref ?? aside.sha.slice(0, 7)}` };
}
function active(m) { assert(!m.paused, 'Feature is paused; explicit unpause is required'); }
async function humanReady(m) {
  const { runtimeTestPlan } = await import('./profile.mjs');
  const required = m.humanWalkRequired || runtimeTestPlan(m).levers.human === 'yes';
  assert(!m.awaitingHuman && (!required || m.humanHead === head(m.worktree)), 'Feature requires a real human walk report at exact current HEAD');
}
async function configFor(root) {
  let loader;
  try { loader = await import('./config.mjs'); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === new URL('./config.mjs', import.meta.url).href) return { registry: 'docs/features' };
    throw error;
  }
  const config = await loader.loadConfig(root);
  if (config.ok === false) {
    if (!(loader.CONFIG_PATHS || ['.builder/config.md', '.codex/builder.md', '.claude/builder.md']).some(entry => fs.existsSync(path.join(root, entry)))) return { registry: 'docs/features' };
    throw new Error(config.reason || 'Malformed project configuration');
  }
  return config;
}
function safeDestination(worktree, destination) {
  const relative = path.relative(worktree, path.resolve(destination));
  assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Artifact destination must stay inside the feature worktree');
  const realRoot = fs.realpathSync(worktree);
  let current = worktree;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    assert(!stat.isSymbolicLink(), 'Artifact destination contains a symlink; refusing external or redirected writes');
    const resolved = path.relative(realRoot, fs.realpathSync(current));
    assert(resolved !== '..' && !resolved.startsWith(`..${path.sep}`) && !path.isAbsolute(resolved), 'Artifact destination escapes the feature worktree');
  }
  return path.resolve(destination);
}
function planningImports(originRoot, originHead, registry, name) {
  const imports = [];
  for (const artifact of ['SPEC.md', 'PLAN.md', 'brainstorm.md', 'continue.md', 'ledger.md']) {
    const relative = `${registry}/${name}/${artifact}`;
    const entry = git(originRoot, 'ls-tree', originHead, '--', relative);
    if (!entry) continue;
    assert(/^100(?:644|755) blob /.test(entry), `Planning artifact must be a regular tracked file: ${relative}`);
    imports.push({ relative, content: execFileSync('git', ['-C', originRoot, 'show', `${originHead}:${relative}`]) });
  }
  return imports;
}
function importArtifacts(m, file, imports, retry = false) {
  try {
    const destinations = imports.map(({ relative }) => safeDestination(m.worktree, path.join(m.worktree, relative)));
    if (retry) {
      // A prior write may have completed before its metadata update. Accept exact source bytes,
      // or an untouched target file; refuse every user-modified or already-imported conflict.
      imports.forEach(({ relative, content }, i) => {
        const destination = destinations[i];
        if (!fs.existsSync(destination)) { assert(!m.importedArtifacts.includes(relative), `Imported planning artifact was removed: ${relative}`); return; }
        assert(fs.statSync(destination).isFile(), `Planning artifact conflicts with an existing directory: ${relative}`);
        const existing = fs.readFileSync(destination);
        if (existing.equals(content)) return;
        let original;
        try { original = execFileSync('git', ['-C', m.originRoot, 'show', `${m.targetStartHead}:${relative}`], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { /* New source artifact. */ }
        assert(!m.importedArtifacts.includes(relative) && original && existing.equals(original), `Planning artifact has local changes; refusing to overwrite: ${relative}`);
      });
    }
    for (let i = 0; i < imports.length; i++) {
      fs.mkdirSync(path.dirname(destinations[i]), { recursive: true });
      safeDestination(m.worktree, destinations[i]);
      fs.writeFileSync(destinations[i], imports[i].content);
      if (!m.importedArtifacts.includes(imports[i].relative)) m.importedArtifacts.push(imports[i].relative);
      atomic(file, m);
    }
    m.importState = 'complete'; delete m.importError;
  } catch (error) {
    m.importState = 'failed'; m.importError = error.message; m.nextAction = 'Inspect retained artifacts, resolve the import conflict, then run retry-import'; atomic(file, m); throw error;
  }
  atomic(file, m);
}
/**
 * The plan line the manifest carries: `tests:` once approved under the test plan, an old approved
 * `profile:` otherwise. start's `profile: thorough` is a placeholder, not a choice — it is written
 * only for a legacy build already under way (which is Thorough). The other key is removed so a
 * stale line never outranks the current approval.
 */
const UNDER_WAY = ['building', 'built', 'signed-off', 'verified', 'merged', 'blocked'];
function planLines(m) {
  if (m.tests) return { tests: m.tests, profile: null };
  if (m.profileApproved || UNDER_WAY.includes(m.phase)) return { profile: m.profile || 'thorough', tests: null };
  return { profile: null, tests: null };
}
function manifest(m) {
  const file = safeDestination(m.worktree, path.join(m.featurePath, 'MANIFEST.md'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const [key, value] of Object.entries({ phase: m.phase, state: m.phase, next: m.nextAction, 'current-task': m.currentTask || 'none', 'origin-branch': m.originBranch || 'detached', 'origin-head': m.originHead, 'target-branch': targetBranch(m), 'target-start-head': m.targetStartHead || m.originHead, ...planLines(m), branch: m.featureBranch, 'feature-name': m.name, registry: m.registry, ...(m.build ? { build: m.build } : {}) })) {
    const re = new RegExp(`^${key}:.*$`, 'm');
    if (value === null) { text = text.replace(new RegExp(`^${key}:.*\\n?`, 'm'), ''); continue; }
    const line = `${key}: ${key === 'next' || key === 'current-task' ? JSON.stringify(value) : value}`;
    text = re.test(text) ? text.replace(re, () => line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  }
  if (!/^size:/m.test(text)) text = `size: md\n${text}`;
  fs.writeFileSync(file, text);
}
/** The migration files `from..to` added under the config's Walk readiness `migrations:` dir, with their text. */
function newMigrations(root, dir, from, to) {
  if (!dir || !from) return [];
  const names = git(root, 'diff', '--name-only', '--diff-filter=A', `${from}..${to}`, '--', dir).split('\n').filter(Boolean);
  return names.map(file => ({ path: file, text: (() => { try { return git(root, 'show', `${to}:${file}`); } catch { return ''; } })() }));
}
/**
 * After delivery into the target: the dev DB the target checkout serves needs the migrations the
 * feature brought (its walk only proved them on the feature's isolated database). apply_mode agent
 * and additive → run apply, then regenerate, in that checkout; anything else → a note naming the
 * exact command. Failures become notes: the landing itself stands.
 */
async function migrateAfterLanding(m, worktree, before, after) {
  try {
    const { loadConfig } = await import('./config.mjs');
    const config = loadConfig(worktree || m.worktree);
    const readiness = config.ok ? parseWalkReadiness(config.body) : {};
    const files = newMigrations(m.originRoot, readiness.migrations, before, after);
    let plan = landedMigrations({ files, readiness, checkedOut: Boolean(worktree), target: targetBranch(m) });
    // Git only knows the files landed; the dev DB's own `pending:` answer says whether it has them.
    if (plan.kind === 'maybe' && readiness.pending && worktree) {
      let pending = true;
      try { execSync(readiness.pending, { cwd: worktree, stdio: 'ignore', timeout: 2 * 60 * 1000 }); pending = false; } catch {}
      plan = landedMigrations({ files, readiness, checkedOut: true, target: targetBranch(m), pending });
    }
    const migrations = files.map(f => f.path);
    if (plan.action === 'none') return { migrations, action: 'none', ...(plan.why ? { why: plan.why } : {}) };
    if (plan.action === 'note') return { migrations, action: 'note', note: plan.why };
    const log = path.join(m.commonDir, 'builder-codex', 'logs', `${m.name}-land.log`);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const n = `${files.length} new migration${files.length === 1 ? '' : 's'}`;
    // What the commands leave behind in the owner's checkout is named for them, not hidden — only
    // what the commands changed: uncommitted work of the owner's own was there before them.
    const changedNow = () => { try { const d = dirty(worktree); return d ? d.split('\n').map(l => l.trim().replace(/^\S+\s+/, '')).filter(Boolean) : []; } catch { return []; } };
    const owners = new Set(changedNow());
    const leftovers = () => changedNow().filter(f => !owners.has(f));
    const changed = files => files.length ? ` It changed ${files.join(', ')} in ${worktree}: commit them under the project's policy or restore them (git -C ${worktree} restore/clean).` : '';
    const done = [];
    for (const cmd of plan.commands) {
      const fd = fs.openSync(log, 'a');
      try { execSync(cmd, { cwd: worktree, stdio: ['ignore', fd, fd], timeout: 10 * 60 * 1000 }); done.push(cmd); }
      catch {
        const left = leftovers();
        const rest = plan.commands.slice(done.length).map(c => `\`${c}\``).join(', then ');
        return { migrations, action: 'failed', commands: plan.commands, ran: done, failed: cmd, log, dirty: left, note: `${n} landed${done.length ? ` and ${done.map(c => `\`${c}\``).join(', ')} ran` : ''}, but \`${cmd}\` failed in ${worktree} — see ${log}, then run ${rest} by hand.${changed(left)}` };
      }
      finally { fs.closeSync(fd); }
    }
    const left = leftovers();
    if (left.length) return { migrations, action: 'applied-dirty', commands: plan.commands, ran: done, log, worktree, dirty: left, note: `${n} applied to the dev DB here (${done.map(c => `\`${c}\``).join(', then ')}).${changed(left)}` };
    return { migrations, action: 'applied', commands: plan.commands, ran: done, log, worktree };
  } catch (error) {
    return { migrations: [], action: 'note', note: `Could not check landed migrations (${error.message}) — check the dev DB by hand` };
  }
}
/** The wrap-up steps Walk readiness names for the target checkout's dev env — offered, never run here. */
async function wrapUpAfterLanding(worktree, landing) {
  if (!worktree) return [];
  try {
    const { loadConfig } = await import('./config.mjs');
    const config = loadConfig(worktree);
    return wrapUp({ readiness: config.ok ? parseWalkReadiness(config.body) : {}, checkedOut: true, migrated: /^applied/.test(landing?.action ?? '') });
  } catch { return []; }
}
export async function run(command, name, options = {}) {
  const root = path.resolve(options.root || process.cwd());
  if (command === 'list') {
    const folder = path.join(common(root), 'builder-codex', 'features');
    if (!fs.existsSync(folder)) return [];
    const { runtimeTestPlan } = await import('./profile.mjs');
    const now = Date.now();
    return fs.readdirSync(folder).filter(x => x.endsWith('.json')).sort().flatMap(x => {
      const file = path.join(folder, x); const m = JSON.parse(fs.readFileSync(file, 'utf8')); m.profile ||= 'thorough';
      // Finished means gone from status: a merged feature whose worktrees were cleaned up has no
      // next step. Merged but not cleaned up stays, its next step the optional cleanup.
      if (m.phase === 'merged' && m.cleaned) return [];
      // `build: here` shows from the moment it is chosen; otherwise the test plan's label
      // (`none · end` — walk · review), an old profile or 5.x plan mapped onto it.
      return [{ ...m, build: m.build || 'none', profileLabel: runtimeTestPlan(m).label, touchedAt: fs.statSync(file).mtimeMs, inSession: buildingInSession(m, now), agent: agentOffer(m, now) }];
    });
  }
  const file = location(root, name);
  assert(options.into === undefined || command === 'start' || command === 'approve', '--into is only accepted by start or approve; landing targets are immutable');
  if (command === 'start') {
    if (fs.existsSync(file)) {
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert(m.phase !== 'merged' && !m.cleaned, 'Feature already merged; start a new feature instead');
      assert(options.into === undefined || options.into === targetBranch(m), 'Landing target is immutable; start a new feature to change it');
      identity(m); return { ...m, profile: m.profile || 'thorough', head: head(m.worktree), dirty: dirty(m.worktree) };
    }
    const originRoot = git(root, 'rev-parse', '--show-toplevel');
    const originBranch = branch(originRoot, true);
    idle(originRoot);
    const featureBranch = `builder/${name}`;
    assert(!existsBranch(originRoot, featureBranch), 'Feature branch already exists');
    const worktree = path.join(path.dirname(originRoot), `${path.basename(originRoot)}-builder-${name}`);
    assert(!fs.existsSync(worktree), 'Worktree path already exists');
    const config = await configFor(originRoot);
    const registry = config.registry || config.frontmatter?.registry || 'docs/features';
    // merge_into: current lands on the branch this checkout is on — never a builder/* feature branch
    // and never a detached HEAD; both fall back to base_branch.
    const current = config.mergeIntoCurrent && originBranch && !originBranch.startsWith('builder/') ? originBranch : null;
    assert(options.into || current || !config.mergeIntoCurrent || config.mergeIntoConfigured, 'merge_into: current needs a named branch checked out (not detached, not builder/*) or a configured base_branch; pass --into');
    const landingBranch = options.into ?? current ?? (config.mergeIntoConfigured ? config.mergeInto : null) ?? originBranch;
    assert(landingBranch, 'Detached HEAD is not supported without an explicit or configured target');
    assert(typeof landingBranch === 'string' && !landingBranch.startsWith('-'), 'Invalid landing target branch');
    try { git(originRoot, 'check-ref-format', `refs/heads/${landingBranch}`); } catch { throw new Error('Invalid landing target branch'); }
    assert(existsBranch(originRoot, landingBranch), `Landing target branch does not exist: ${landingBranch}`);
    const targetStartHead = git(originRoot, 'rev-parse', `refs/heads/${landingBranch}`);
    assert(typeof registry === 'string' && !path.isAbsolute(registry) && !registry.split(/[\\/]/).includes('..'), 'Registry must be a relative repository path');
    assert(!git(originRoot, 'ls-tree', '-r', '--name-only', targetStartHead, '--', `${registry}/${name}/MANIFEST.md`), 'Tracked feature manifest already exists; resume or recover it instead');
    assert(!git(originRoot, 'ls-tree', '-r', '--name-only', targetStartHead, '--', `${registry}/_archive/${name}`), 'Feature is already archived on the landing target; start a new feature instead');
    const originHead = head(originRoot);
    // Carry only committed planning documents, never source code or manifest identity.
    const imports = originHead !== targetStartHead ? planningImports(originRoot, originHead, registry, name) : [];
    git(originRoot, 'worktree', 'add', '-b', featureBranch, worktree, targetStartHead);
    const m = { name, originRoot, originBranch, originHead, targetBranch: landingBranch, targetStartHead, importedArtifacts: [], importState: imports.length ? 'pending' : 'complete', commonDir: common(originRoot), worktree, featureBranch, featurePath: path.join(worktree, registry, name), registry, profile: 'thorough', phase: 'exploring', currentTask: null, nextAction: 'Read project configuration and inspect relevant implementation', verifiedHead: null };
    // Register ownership before copying, so a rejected or interrupted import is recoverable.
    atomic(file, m);
    importArtifacts(m, file, imports); return m;
  }
  const [, m] = read(root, name);
  m.profile ||= 'thorough';
  if (m.cleaned && ['status', 'resume'].includes(command)) return m;
  assert(!m.cleaned, 'Cleaned feature is read-only; start a new feature');
  identity(m);
  if (command === 'status' || command === 'resume') return { ...m, head: head(m.worktree), dirty: dirty(m.worktree) };
  if (command === 'agent-ready') {
    // Read-only: whether Codex workers may take this feature now, and what they would do.
    const offer = agentOffer(m);
    assert(offer.offer, offer.reason);
    // The feature worktree is cut from its target, so workers read the TARGET's config. A target
    // whose config has no agent_walk block has no agent mode (Claude 5.1.0's fleet refusal).
    const { CONFIG_PATHS, hasAgentWalk } = await import('./config.mjs');
    const target = targetBranch(m);
    const configText = CONFIG_PATHS.map((p) => { try { return git(m.originRoot, 'show', `refs/heads/${target}:${p}`); } catch { return null; } }).find((t) => t != null);
    assert(hasAgentWalk(configText), `${m.name} — ${target}'s config has no agent_walk block, so workers there have no agent mode; commit the config to ${target}, or start the feature again landing on the branch you are on`);
    return { name: m.name, phase: m.phase, build: m.build || 'none', targetBranch: targetBranch(m), worktree: m.worktree, ...offer };
  }
  assert(m.phase !== 'merged' || command === 'cleanup', 'Merged feature is read-only except for cleanup');
  if (command === 'pause') {
    assert(m.phase !== 'merged', 'Merged feature cannot be paused');
    if (!m.paused) m.pauseState = { phase: m.phase, nextAction: m.nextAction };
    // A paused landing is never resumed from its old merge request: prepare asks again.
    m.paused = true; invalidate(m); m.merge = null; m.nextAction = 'Explicit unpause required'; atomic(file, m); return m;
  }
  if (command === 'unpause') {
    assert(m.paused && m.pauseState, 'Feature is not paused');
    m.phase = m.pauseState.phase;
    m.nextAction = m.pauseState.nextAction; m.paused = false; delete m.pauseState;
    invalidate(m); m.merge = null; atomic(file, m); return m;
  }
  active(m);
  if (command === 'retry-import') {
    assert(['pending', 'failed'].includes(m.importState), 'No incomplete artifact import to retry');
    idle(m.worktree); invalidate(m); m.nextAction = 'Read imported planning documents and continue the feature';
    importArtifacts(m, file, planningImports(m.originRoot, m.originHead, m.registry, m.name), true); return m;
  }
  assert(!m.importState || m.importState === 'complete', 'Artifact import is incomplete; resolve it and run retry-import before continuing');
  if (command === 'here') {
    // Build it in this session without the ceremony: chosen before the build starts, never after.
    assert(['spec', 'aligned', 'audited', 'planned'].includes(m.phase), `Build here is chosen before the build starts (spec, aligned, audited or planned); ${m.phase} continues as usual`);
    if (m.build !== 'here') { m.build = 'here'; manifest(m); atomic(file, m); }
    return m;
  }
  if (command === 'approve') {
    assert(m.phase !== 'merged', 'Merged feature cannot be approved');
    assert(options.into === undefined || options.into === targetBranch(m), 'Landing target is immutable; start a new feature to change it');
    assert(Boolean(options.tests) !== Boolean(options.profile), 'Approval requires --tests (or a legacy --profile), not both');
    const { parseProfile, parseTests, formatTests } = await import('./profile.mjs');
    let walkYou;
    if (options.tests) {
      const plan = parseTests(options.tests);
      assert(!plan.warning, `Invalid test plan: ${plan.warning}`);
      m.tests = formatTests(plan.levers); walkYou = plan.levers.human === 'yes';
    } else {
      const profile = parseProfile(options.profile);
      assert(!profile.warning, `Invalid profile: ${profile.warning}`);
      m.profile = profile.preset === 'custom' ? options.profile.trim() : profile.preset; delete m.tests;
      walkYou = profile.levers.testing === 'full+human';
    }
    m.profileApproved = true;
    m.humanHead = null;
    if (walkYou) m.awaitingHuman = true;
    invalidate(m); if (m.phase === 'verified') m.phase = 'signed-off';
    manifest(m); atomic(file, m); return m;
  }
  if (command === 'await-human') {
    assert(m.phase !== 'merged', 'Merged feature cannot await human review');
    m.awaitingHuman = true; m.humanWalkRequired = true; m.humanHead = null; m.phase = 'built'; invalidate(m);
    m.nextAction = 'Wait for an actual human walk report'; atomic(file, m); return m;
  }
  if (command === 'human-pass') {
    assert(m.awaitingHuman, 'Feature is not waiting for a human walk');
    assert(typeof options.report === 'string' && options.report.trim(), 'Human pass requires --report containing the received human walk report');
    idle(m.worktree); assert(!dirty(m.worktree), 'Human pass requires a clean committed feature worktree');
    m.humanReport = options.report; m.humanHead = head(m.worktree); m.awaitingHuman = false; m.phase = 'signed-off'; invalidate(m);
    m.nextAction = 'Signed off — choose a check: quick check, ship it or full verify (none is required), then deliver'; atomic(file, m); return m;
  }
  if (command === 'checkpoint') {
    assert(options.phase && options.next, 'Checkpoint requires --phase and --next');
    assert(['exploring', 'spec', 'aligned', 'audited', 'planned', 'building', 'built', 'signed-off', 'verified', 'blocked'].includes(options.phase), 'Invalid checkpoint phase');
    assert(!options.verifiedHead || options.phase === 'verified', '--verified-head requires verified phase');
    if (options.phase === 'verified') {
      await humanReady(m);
      assert(options.verifiedHead === head(m.worktree), 'Verified checkpoint requires exact current HEAD');
      idle(m.worktree); assert(!dirty(m.worktree), 'Verified checkpoint requires a clean feature worktree');
      m.verifiedHead = options.verifiedHead;
    } else { m.verifiedHead = null; }
    m.phase = options.phase; m.nextAction = options.next; m.checkpointHead = head(m.worktree);
    if (options.task !== undefined) m.currentTask = options.task;
    // Verification is runtime-only: writing MANIFEST here would invalidate its tested tree.
    if (m.phase !== 'verified') manifest(m);
    atomic(file, m); return m;
  }
  if (command === 'record-check') {
    // After sign-off the owner (or --auto) picks a check; none is required. Runtime-only, like the verified checkpoint.
    assert(['quick', 'skipped'].includes(options.check), 'record-check takes --check quick or skipped (a full verify is the verified checkpoint)');
    assert(SIGNED_OFF.includes(m.phase), `${name} is not signed off yet — the walk comes first; there is no check to record`);
    await humanReady(m);
    idle(m.worktree); assert(!dirty(m.worktree), 'Recording a check requires a clean committed feature worktree');
    m.check = { kind: options.check, head: head(m.worktree), date: today() };
    m.nextAction = `${options.check === 'quick' ? 'Quick check passed' : 'Check skipped'} — deliver`;
    atomic(file, m); return m;
  }
  if (command === 'prepare') {
    // The merge tier is asked once the feature is built — when its walk starts, or later — so the
    // walk (an agent's or the owner's) runs beside it; deliver holds the verified and walk guards.
    assert(['built', 'signed-off', 'verified'].includes(m.phase), 'Prepare asks for the merge once the feature is built (when its walk starts, or later)');
    idle(m.worktree); assert(!dirty(m.worktree), 'Feature worktree must be clean');
    const target = targetReady(m); const v = await verifier(m); landable(m, target, v.root);
    const featureHead = head(m.worktree);
    const prev = m.merge && v.ledger.getRequest(m.merge.request);
    const usable = prev && m.merge.featureHead === featureHead && m.merge.targetHead === target.head
      && (PENDING.includes(prev.state) || (prev.state === 'done' && prev.verdict?.status === 'green' && prev.verdict.held));
    if (!usable) requestMerge(m, target);
    // Caught early (while the tests run): the owner's uncommitted changes the landing would run into.
    const overlap = await overlapOf(target, v.root, git(m.originRoot, 'merge-base', target.head, featureHead), featureHead);
    if (overlap.length) m.needsYou = needsYou({ feature: name, files: overlap, target: targetBranch(m), checkout: target.worktree });
    else delete m.needsYou;
    m.nextAction = m.needsYou
      ? needsYouNext(m.needsYou)
      : `Ready to land on ${targetBranch(m)} once the merge tier is green and the walk passed — verify.mjs wait ${m.merge.request}, then deliver`;
    atomic(file, m);
    return { ...m, status: 'requested', request: m.merge.request, overlap };
  }
  if (command === 'deliver') {
    await humanReady(m);
    // 6.1.0: signed off is enough — a quick check, a skip or a full verify is recorded, never required.
    assert(SIGNED_OFF.includes(m.phase), `${name} is not signed off yet — the walk comes first (a human walk report through human-pass, or the agent walk's checkpoint --phase signed-off); a check after sign-off is optional`);
    idle(m.worktree); assert(!dirty(m.worktree), 'Feature worktree must be clean');
    assert(m.merge?.request, `No merge requested yet — run prepare ${name} first`);
    assert(!(options.setAside && options.commitMine !== undefined), 'Pick one: --commit-mine or --set-aside');
    assert(options.commitMine === undefined || (typeof options.commitMine === 'string' && options.commitMine.trim()), '--commit-mine needs the message to commit your changes with');
    const target = targetReady(m); const v = await verifier(m); landable(m, target, v.root);
    const t = targetBranch(m);
    const done = extra => { atomic(file, m); return { ...m, ...extra }; };
    const again = why => { requestMerge(m, target); m.nextAction = `${why} — the merge tier is testing it again: verify.mjs wait ${m.merge.request}, then deliver`; return done({ status: 'testing', request: m.merge.request, why }); };
    const r = v.ledger.getRequest(m.merge.request);
    if (!r) return again(`The verifier has no record of merge request ${m.merge.request}`);
    if (PENDING.includes(r.state)) { m.nextAction = `Ready to land on ${t} once the merge tier is green — verify.mjs wait ${r.id}, then deliver`; return done({ status: 'testing', request: r.id }); }
    const verdict = r.verdict ?? { status: r.state };
    if (verdict.status === 'conflict') {
      m.nextAction = `The feature conflicts with ${t} in ${(verdict.files ?? []).join(', ')} — merge ${t} into the feature worktree, resolve those files, commit, verify again, then prepare`;
      return done({ status: 'conflict', files: verdict.files ?? [], request: r.id });
    }
    if (verdict.status !== 'green') {
      const { summarize } = await import('./verify/verify.mjs');
      let summary = verdict.status; try { summary = summarize(verdict); } catch { /* a bare status */ }
      m.nextAction = verdict.status === 'env-broken' ? `The merge tier could not run (env-broken) — fix what its ⚠ lines name, then prepare again` : `The merge tier is ${verdict.status} on ${t} — fix what it names in the feature, verify again, then prepare`;
      return done({ status: verdict.status, summary, request: r.id });
    }
    // Landed by an earlier deliver that stopped before recording it: record it now, never land twice.
    const recovered = verdict.landed && ancestor(m.originRoot, verdict.landed, target.head) ? verdict.landed : null;
    if (!recovered && !verdict.held) return again(`The tested merge of ${r.id} can no longer land (${t} moved since)`);
    // What it tested is HEAD, or HEAD gained only registry commits since (walk results, the manifest): those carry.
    const now = head(m.worktree);
    const mode = recovered ? null : now === r.sha ? 'release' : ancestor(m.worktree, r.sha, now) && docsOnly(m.worktree, r.sha, now, m.registry) ? 'carry' : null;
    if (!recovered && !mode) return again('The feature changed since the merge was tested');
    // The owner's uncommitted changes the landing would run into: none of theirs is touched without an answer.
    const overlap = !recovered && target.head === verdict.targetSha ? await overlapOf(target, v.root, verdict.targetSha, verdict.merged) : [];
    const park = files => {
      m.needsYou = needsYou({ feature: name, files, target: t, checkout: target.worktree });
      m.nextAction = needsYouNext(m.needsYou);
      return done({ status: 'needs-you', overlap: files, recommended: m.needsYou.recommended, why: m.needsYou.why, choices: m.needsYou.choices });
    };
    if (overlap.length && !options.setAside && options.commitMine === undefined) return park(overlap);
    let committed = null; let aside = null; let back = null;
    if (!recovered && options.commitMine !== undefined) {
      assert(target.worktree, `${t} is checked out nowhere, so there are no changes of yours to commit`);
      committed = commitMine(target.worktree, options.commitMine.trim(), overlap);
      if (committed.sha) { delete m.needsYou; return { ...again(`Your changes are committed on ${t} as ${committed.sha.slice(0, 7)}`), committed }; }
    }
    if (!recovered && options.setAside && target.worktree) aside = setAside(target.worktree, name);
    let landed = recovered ?? undefined;
    if (!landed) {
      try {
        const cli = verifyCli(v.root, mode, r.id, '--in', v.root);
        if (cli.code === 0) landed = v.ledger.getRequest(r.id)?.verdict?.landed;
        else if (cli.code === 7 || (mode === 'carry' && cli.code === 2)) landed = { again: cli.out.split('\n')[0] || `${t} moved` };
        else {
          const o = /^overlap: (.*)$/m.exec(cli.out);
          landed = o ? { overlap: JSON.parse(o[1]) } : { refused: cli.out || cli.err || `exit ${cli.code}` };
        }
      } finally {
        // Put back before anything else runs in the owner's checkout — landed or not.
        if (aside?.sha) back = putBack(target.worktree, aside);
      }
    }
    const kept = back && !back.clean ? { setAside: back } : back ? { setAside: { clean: true } } : {};
    if (typeof landed !== 'string') {
      if (landed?.again) return { ...again(landed.again), ...kept };
      if (landed?.overlap) return { ...park(landed.overlap), ...kept };
      throw new Error(`The landing was refused: ${landed?.refused ?? 'the verifier recorded no landed commit'}${back && !back.clean ? ` — and ${back.note}` : ''}`);
    }
    m.landedCheck = checkRan(m, now);
    m.phase = 'merged'; m.mergedHead = landed; delete m.needsYou; m.nextAction = 'Optional explicit cleanup';
    if (back && !back.clean) m.setAside = back;
    atomic(file, m);
    // The merge is final; what follows only brings the dev DB along and never undoes the landing.
    m.landing = await migrateAfterLanding(m, target.worktree, verdict.targetSha, landed);
    if (m.landing.note) m.nextAction = `${m.landing.note}; then optional explicit cleanup`;
    if (back && !back.clean) m.nextAction = `Landed — but ${back.note}; ${m.nextAction}`;
    m.wrapUp = await wrapUpAfterLanding(target.worktree, m.landing);
    try {
      const { recordLanding } = await import('./history.mjs');
      const metrics = options.metrics ? JSON.parse(fs.readFileSync(options.metrics, 'utf8')) : null;
      m.history = { recorded: true, row: recordLanding(m, { metrics }) };
    } catch (error) { m.history = { recorded: false, why: error.message }; }
    return done({ status: 'landed', ...(committed ? { committed } : {}), ...kept });
  }
  if (command === 'cleanup') {
    const target = targetReady(m);
    assert(m.phase === 'merged' && m.mergedHead && ancestor(m.originRoot, m.mergedHead, target.head), 'Merged result must be proven in target ancestry');
    assert(!dirty(m.worktree), 'Feature worktree must be clean'); idle(m.worktree);
    assert(ancestor(m.originRoot, head(m.worktree), target.head), 'Feature contains unmerged commits');
    // A 5.x landing's integration worktree; the verifier's own checkouts (<root>-verify/) are never touched.
    if (m.integration && fs.existsSync(m.integration.worktree)) {
      assert(branch(m.integration.worktree) === m.integration.branch && !dirty(m.integration.worktree), 'Integration worktree must retain its branch and be clean'); idle(m.integration.worktree);
      assert(ancestor(m.originRoot, head(m.integration.worktree), target.head), 'Integration contains unmerged commits');
      git(m.originRoot, 'worktree', 'remove', m.integration.worktree);
      git(m.originRoot, 'branch', m.targetBranch ? '-D' : '-d', m.integration.branch);
    }
    git(m.originRoot, 'worktree', 'remove', m.worktree); git(m.originRoot, 'branch', m.targetBranch ? '-D' : '-d', m.featureBranch);
    m.cleaned = true; atomic(file, m); return m;
  }
  throw new Error(`Unknown command: ${command}`);
}
const help = 'Usage: lifecycle.mjs start|status|resume|agent-ready|here|retry-import|approve|pause|unpause|await-human|human-pass|checkpoint|record-check|prepare|deliver|cleanup FEATURE [--root PATH]\n       lifecycle.mjs list [--root PATH] (features in flight; a merged feature drops out once cleaned up)\nstart: [--into TARGET] (configured merge_into, configured base_branch, or current branch)\nagent-ready: read-only; refuses a feature another session is building, merged, paused or awaiting a human walk, else says what workers would do\nhere: build it in this session without workers or reviewer agents (before the build starts); records build: here\nretry-import: retry an incomplete planning import, preserving local conflicts\napprove: --tests "walk=none|risk|full review=end|app|slice[ human=yes]" (or a legacy --profile VALUE; a 5.x slice=/end= value is mapped) [--into TARGET] (captured target cannot change)\nhuman-pass: --report TEXT (received human walk report at the clean HEAD; signs the feature off)\ncheckpoint: --phase VALUE --next TEXT [--task TEXT] [--verified-head SHA] (--phase verified is the full verify)\nrecord-check: --check quick|skipped, after sign-off: the check the owner chose (verify-quick.mjs records quick; ship it records skipped); runtime-only, none is required\nprepare: asks the verifier\'s merge tier to test the feature merged onto the target, held until deliver (from built on, so the walk runs beside it); returns the request id and any overlap with your uncommitted changes in the target checkout\ndeliver: a signed-off feature, whatever check ran (recorded as landedCheck: full · quick · skipped · none) [--commit-mine "MESSAGE" | --set-aside] [--metrics MEASURED_JSON] lands the held green merge by compare-and-swap (verify.mjs release, or carry when only registry commits came after it), then records history and the landed migrations. Exit 0 landed, 1 red/env-broken/refused, 3 needs you (your uncommitted changes overlap it; nothing touched), 4 conflict, 75 still testing or asked again (the target or feature moved)\nPause and human review invalidate verification and a recorded check. Resume never unpauses. Verified checkpoints are runtime-only; earlier checkpoints mirror MANIFEST.md. Deliver applies landed additive migrations to the target checkout only under Walk readiness apply_mode agent, otherwise notes the command. No push or PR is performed.';
if ((() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help') || !args.length) console.log(help);
    else {
      const command = args.shift(); const name = args[0]?.startsWith('--') ? undefined : args.shift(); const options = {};
      while (args.length) {
        const key = args.shift();
        if (key === '--set-aside') { options.setAside = true; continue; }
        assert(['--root', '--phase', '--next', '--task', '--verified-head', '--into', '--tests', '--profile', '--report', '--commit-mine', '--metrics', '--check'].includes(key) && args.length, `Invalid option: ${key}`);
        options[key.slice(2).replace(/-([a-z])/g, (_, x) => x.toUpperCase())] = args.shift();
      }
      const result = await run(command, name, options);
      console.log(JSON.stringify(result, null, 2));
      if (command === 'deliver') process.exitCode = { landed: 0, 'needs-you': 3, conflict: 4, testing: 75 }[result?.status] ?? 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
