#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
function candidateIdentity(m, requireAncestry = true) {
  const c = m.integration;
  assert(c && fs.existsSync(c.worktree), 'Integration candidate is missing');
  assert(!c.targetBranch || c.targetBranch === targetBranch(m), 'Integration candidate target changed');
  assert(git(c.worktree, 'rev-parse', '--show-toplevel') === c.worktree && common(c.worktree) === m.commonDir, 'Integration candidate repository changed');
  assert(branch(c.worktree) === c.branch, 'Integration candidate branch changed');
  idle(c.worktree);
  assert(!dirty(c.worktree), 'Integration candidate must retain its branch and be clean');
  if (requireAncestry) assert(ancestor(c.worktree, c.targetHead, head(c.worktree)) && ancestor(c.worktree, c.featureHead, head(c.worktree)), 'Integration candidate must contain target and feature commits');
}
function originReady(m) {
  assert(git(m.originRoot, 'rev-parse', '--show-toplevel') === m.originRoot, 'Origin root changed');
  assert(common(m.originRoot) === m.commonDir, 'Origin repository changed');
  assert(branch(m.originRoot) === m.originBranch, 'Origin branch changed');
  idle(m.originRoot);
  assert(!dirty(m.originRoot), 'Origin checkout must be clean');
}
const targetBranch = m => m.targetBranch || m.originBranch;
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
    assert(!dirty(worktree), 'Landing target checkout must be clean (Origin checkout must be clean when it holds the target)');
  }
  return { worktree, head: git(m.originRoot, 'rev-parse', `refs/heads/${m.targetBranch}`) };
}
function invalidate(m) { m.verifiedHead = null; if (m.integration) m.integration.candidateHead = null; }
function active(m) { assert(!m.paused, 'Feature is paused; explicit unpause is required'); }
async function humanReady(m) {
  const { parseProfile } = await import('./profile.mjs');
  const required = m.humanWalkRequired || parseProfile(m.profile).levers.testing === 'full+human';
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
function manifest(m) {
  const file = safeDestination(m.worktree, path.join(m.featurePath, 'MANIFEST.md'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const [key, value] of Object.entries({ phase: m.phase, state: m.phase, next: m.nextAction, 'current-task': m.currentTask || 'none', 'origin-branch': m.originBranch || 'detached', 'origin-head': m.originHead, 'target-branch': targetBranch(m), 'target-start-head': m.targetStartHead || m.originHead, profile: m.profile || 'thorough', branch: m.featureBranch, 'feature-name': m.name, registry: m.registry })) {
    const line = `${key}: ${key === 'next' || key === 'current-task' ? JSON.stringify(value) : value}`;
    const re = new RegExp(`^${key}:.*$`, 'm');
    text = re.test(text) ? text.replace(re, () => line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  }
  if (!/^size:/m.test(text)) text = `size: md\n${text}`;
  fs.writeFileSync(file, text);
}
export async function run(command, name, options = {}) {
  const root = path.resolve(options.root || process.cwd());
  if (command === 'list') {
    const folder = path.join(common(root), 'builder-codex', 'features');
    return fs.existsSync(folder) ? fs.readdirSync(folder).filter(x => x.endsWith('.json')).sort().map(x => { const m = JSON.parse(fs.readFileSync(path.join(folder, x), 'utf8')); return { ...m, profile: m.profile || 'thorough' }; }) : [];
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
    const landingBranch = options.into ?? (config.mergeIntoConfigured ? config.mergeInto : null) ?? originBranch;
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
  assert(m.phase !== 'merged' || command === 'cleanup', 'Merged feature is read-only except for cleanup');
  if (command === 'pause') {
    assert(m.phase !== 'merged', 'Merged feature cannot be paused');
    if (!m.paused) m.pauseState = { phase: m.phase, nextAction: m.nextAction };
    m.paused = true; invalidate(m); m.nextAction = 'Explicit unpause required'; atomic(file, m); return m;
  }
  if (command === 'unpause') {
    assert(m.paused && m.pauseState, 'Feature is not paused');
    m.phase = m.pauseState.phase;
    m.nextAction = m.pauseState.nextAction; m.paused = false; delete m.pauseState;
    invalidate(m); atomic(file, m); return m;
  }
  active(m);
  if (command === 'retry-import') {
    assert(['pending', 'failed'].includes(m.importState), 'No incomplete artifact import to retry');
    idle(m.worktree); invalidate(m); m.nextAction = 'Read imported planning documents and continue the feature';
    importArtifacts(m, file, planningImports(m.originRoot, m.originHead, m.registry, m.name), true); return m;
  }
  assert(!m.importState || m.importState === 'complete', 'Artifact import is incomplete; resolve it and run retry-import before continuing');
  if (command === 'approve') {
    assert(m.phase !== 'merged', 'Merged feature cannot be approved');
    assert(options.into === undefined || options.into === targetBranch(m), 'Landing target is immutable; start a new feature to change it');
    assert(options.profile, 'Approval requires --profile');
    const { parseProfile } = await import('./profile.mjs');
    const profile = parseProfile(options.profile);
    assert(!profile.warning, `Invalid profile: ${profile.warning}`);
    m.profile = profile.preset === 'custom' ? options.profile.trim() : profile.preset; m.profileApproved = true;
    m.humanHead = null;
    if (profile.levers.testing === 'full+human') m.awaitingHuman = true;
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
    m.nextAction = 'Run checks again and record exact verified HEAD'; atomic(file, m); return m;
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
  if (command === 'prepare') {
    assert(m.phase === 'verified' && m.verifiedHead === head(m.worktree), 'Feature must be verified at exact current HEAD');
    await humanReady(m);
    idle(m.worktree); assert(!dirty(m.worktree), 'Feature worktree must be clean'); const target = targetReady(m);
    if (m.integration) candidateIdentity(m, false);
    else {
      const integrationBranch = `builder-integrate/${name}`;
      const worktree = `${m.worktree}-integration`;
      assert(!existsBranch(m.originRoot, integrationBranch) && !fs.existsSync(worktree), 'Integration branch or worktree already exists');
      m.integration = { branch: integrationBranch, worktree, targetBranch: targetBranch(m), targetHead: target.head, featureHead: head(m.worktree), candidateHead: null };
      git(m.originRoot, 'worktree', 'add', '-b', integrationBranch, worktree, m.integration.targetHead);
    }
    assert(ancestor(m.originRoot, m.integration.targetHead, target.head), 'Landing target history was rewritten after candidate preparation');
    m.integration.targetHead = target.head;
    m.integration.featureHead = head(m.worktree);
    m.integration.candidateHead = null;
    atomic(file, m);
    git(m.integration.worktree, 'merge', '--no-ff', '-m', `Integrate current target for ${name}`, m.integration.targetHead);
    git(m.integration.worktree, 'merge', '--no-ff', '-m', `Merge builder feature ${name}`, m.integration.featureHead);
    candidateIdentity(m);
    m.integration.candidateHead = head(m.integration.worktree); atomic(file, m);
    return { ...m, candidatePath: m.integration.worktree, candidateHead: m.integration.candidateHead };
  }
  if (command === 'deliver') {
    await humanReady(m);
    assert(m.integration?.candidateHead, 'Prepare an integration candidate first');
    assert(m.phase === 'verified' && m.verifiedHead === head(m.worktree), 'Feature must remain verified at exact current HEAD');
    const target = targetReady(m); idle(m.worktree); idle(m.integration.worktree);
    assert(target.head === m.integration.targetHead, 'Landing target / Origin advanced after candidate preparation');
    assert(head(m.worktree) === m.integration.featureHead && !dirty(m.worktree), 'Feature changed after candidate preparation');
    candidateIdentity(m);
    assert(options.verifiedHead === m.integration.candidateHead && head(m.integration.worktree) === options.verifiedHead, 'Delivery requires exact verified candidate HEAD');
    if (target.worktree) {
      assert(branch(target.worktree) === targetBranch(m) && head(target.worktree) === m.integration.targetHead, 'Landing target changed before delivery');
      git(target.worktree, 'merge', '--ff-only', options.verifiedHead);
    } else {
      // Compare-and-swap prevents overwriting an independently advanced ref.
      git(m.originRoot, 'update-ref', `refs/heads/${targetBranch(m)}`, options.verifiedHead, m.integration.targetHead);
    }
    m.phase = 'merged'; m.mergedHead = options.verifiedHead; m.nextAction = 'Optional explicit cleanup'; atomic(file, m); return m;
  }
  if (command === 'cleanup') {
    const target = targetReady(m);
    assert(m.phase === 'merged' && m.mergedHead && ancestor(m.originRoot, m.mergedHead, target.head), 'Merged result must be proven in target ancestry');
    assert(!dirty(m.worktree), 'Feature worktree must be clean'); idle(m.worktree);
    assert(ancestor(m.originRoot, head(m.worktree), target.head), 'Feature contains unmerged commits');
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
const help = 'Usage: lifecycle.mjs start|status|resume|retry-import|approve|pause|unpause|await-human|human-pass|checkpoint|prepare|deliver|cleanup FEATURE [--root PATH]\n       lifecycle.mjs list [--root PATH]\nstart: [--into TARGET] (configured merge_into, configured base_branch, or current branch)\nretry-import: retry an incomplete planning import, preserving local conflicts\napprove: --profile VALUE [--into TARGET] (captured target cannot change)\nhuman-pass: --report TEXT (received human walk report; requires fresh checks)\ncheckpoint: --phase VALUE --next TEXT [--task TEXT] [--verified-head SHA]\ndeliver: --verified-head CANDIDATE_SHA\nPause and human review invalidate verification. Resume never unpauses. Verified checkpoints are runtime-only; earlier checkpoints mirror MANIFEST.md. No push or PR is performed.';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help') || !args.length) console.log(help);
    else {
      const command = args.shift(); const name = args[0]?.startsWith('--') ? undefined : args.shift(); const options = {};
      while (args.length) { const key = args.shift(); assert(['--root', '--phase', '--next', '--task', '--verified-head', '--into', '--profile', '--report'].includes(key) && args.length, `Invalid option: ${key}`); options[key.slice(2).replace(/-([a-z])/g, (_, x) => x.toUpperCase())] = args.shift(); }
      console.log(JSON.stringify(await run(command, name, options), null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
