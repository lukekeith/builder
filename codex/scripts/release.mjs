#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git, repository, verifySync } from './sync.mjs';
export function releasePlan(root = repository) {
  const state = verifySync(root, 'main');
  if (git(root, 'status', '--porcelain')) throw new Error('Release requires a clean repository; commit reviewed changes first');
  if (git(root, 'branch', '--show-current') !== 'main') throw new Error('Release from main after verified local integration');
  const catalog = JSON.parse(fs.readFileSync(path.join(root, '.agents/plugins/marketplace.json'), 'utf8'));
  if (catalog.name !== 'builder-codex' || catalog.plugins?.find(p => p.name === 'builder')?.source?.path !== './codex') throw new Error('Invalid Builder Codex marketplace');
  const head = git(root, 'rev-parse', 'HEAD'), tag = `builder-codex--v${state.version}`;
  const existing = git(root, 'tag', '--list', tag);
  if (existing && git(root, 'rev-list', '-n', '1', tag) !== head) throw new Error(`Tag ${tag} already belongs to another commit; never overwrite a release`);
  return { version: state.version, upstream: state.commit, head, tag, asset: `builder-codex-${state.version}.tar.gz`, existing: Boolean(existing) };
}
export function release(root = repository, mode = 'dry-run') {
  const plan = releasePlan(root);
  if (mode === 'dry-run') return { ...plan, action: 'Validate tests, package, tag, push main and Codex tag, create GitHub release' };
  if (!['pack', 'publish'].includes(mode)) throw new Error('Unknown release mode');
  const tests = fs.readdirSync(path.join(root, 'codex/tests')).filter(n => n.endsWith('.test.mjs')).map(n => path.join(root, 'codex/tests', n));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  execFileSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit', env });
  // Tests must not change the release inputs.
  const verified = releasePlan(root);
  if (verified.head !== plan.head || verified.upstream !== plan.upstream || verified.version !== plan.version) throw new Error('Release inputs advanced during verification');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-codex-release-'));
  try {
    const asset = path.join(dir, plan.asset);
    execFileSync('git', ['archive', '--format=tar.gz', '--output', asset, plan.head, 'codex', '.agents/plugins/marketplace.json'], { cwd: root });
    if (mode === 'pack') {
      const dest = path.join(root, 'dist', plan.asset); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(asset, dest); return { ...plan, asset: dest };
    }
    // Refuse publication to a different repository.
    const remote = git(root, 'remote', 'get-url', 'origin');
    if (!/^(?:git@github\.com:|https:\/\/github\.com\/)lukekeith\/builder(?:\.git)?$/.test(remote)) throw new Error('Publication requires origin to be lukekeith/builder');
    execFileSync('gh', ['auth', 'status'], { cwd: root, stdio: 'inherit' });
    if (git(root, 'rev-parse', 'main') !== plan.head || git(root, 'status', '--porcelain')) throw new Error('Release checkout changed before publication');
    if (!plan.existing) git(root, 'tag', '-a', plan.tag, plan.head, '-m', `Builder for Codex ${plan.version}`);
    execFileSync('git', ['push', '--atomic', 'origin', `${plan.head}:refs/heads/main`, `refs/tags/${plan.tag}`], { cwd: root, stdio: 'inherit' });
    const notes = path.join(dir, 'notes.md');
    fs.writeFileSync(notes, `Builder for Codex ${plan.version}, adapted from Claude Builder ${plan.version} (${plan.upstream}).\n\nInstall:\n\n\`\`\`sh\ncodex plugin marketplace add lukekeith/builder --ref main\ncodex plugin add builder@builder-codex\n\`\`\`\n\nUpdate: \`codex plugin marketplace upgrade builder-codex\`, then \`codex plugin add builder@builder-codex\` and start a new session.\n\nIncludes $sync for Claude-first feature migration and release, and $update-local for global installs and protected local vendoring. See codex/README.md for runtime differences. The attached archive includes the marketplace and self-contained package.\n`);
    let exists = false;
    try { execFileSync('gh', ['release', 'view', plan.tag, '--repo', 'lukekeith/builder'], { stdio: 'ignore' }); exists = true; } catch {}
    if (!exists) execFileSync('gh', ['release', 'create', plan.tag, asset, '--repo', 'lukekeith/builder', '--verify-tag', '--title', `Builder for Codex ${plan.version}`, '--notes-file', notes], { cwd: root, stdio: 'inherit' });
    else execFileSync('gh', ['release', 'upload', plan.tag, asset, '--repo', 'lukekeith/builder', '--clobber'], { cwd: root, stdio: 'inherit' });
    return { ...plan, url: `https://github.com/lukekeith/builder/releases/tag/${plan.tag}` };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--dry-run', '--pack', '--publish'].includes(args[0])) throw new Error('Usage: release.mjs --dry-run|--pack|--publish');
    console.log(JSON.stringify(release(repository, args[0].slice(2)), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
