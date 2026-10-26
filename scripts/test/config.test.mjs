import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, parseEnvPairs, hasAgentWalk } from '../config.mjs'
import { execFileSync } from 'node:child_process'

const APPS = 'apps:\n  - name: app\n    path: app/\n    role: app\n    commit: auto'
const cfgWith = (extra) => {
  const root = mkdtempSync(join(tmpdir(), 'cfg-'))
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude/builder.md'), `---\nproject: t\n${APPS}\n${extra}\n---\nbody\n`)
  return loadConfig(root)
}

test('no agent_walk block → null', () => {
  assert.equal(cfgWith('').agentWalk, null)
})

test('agent_walk parsed, with defaults for what is left out', () => {
  const cfg = cfgWith('agent_walk:\n  driver: the Playwright MCP tools\n  claude_args: --permission-mode bypassPermissions')
  assert.deepEqual(cfg.agentWalk, {
    driver: 'the Playwright MCP tools',
    claudeArgs: '--permission-mode bypassPermissions',
    worktrees: null,
    parallel: 3,
    reset: null,
    stop: null,
    copy: [],
    setup: null,
    sync: null,
    env: {},
    worktreeEnv: {},
    start: null,
    smoke: null,
    keepLogs: 30,
    autoUnpark: 2,
    batch: 8,
  })
})

test('worktree_env is parsed like env, and a bad pair names itself', () => {
  const cfg = cfgWith('agent_walk:\n  driver: x\n  claude_args: --a\n  worktree_env: TEST_DATABASE_URL="postgres://h/t_{feature}" X=1')
  assert.deepEqual(cfg.agentWalk.worktreeEnv, { TEST_DATABASE_URL: 'postgres://h/t_{feature}', X: '1' })
  const bad = cfgWith('agent_walk:\n  driver: x\n  claude_args: --a\n  worktree_env: NOPE')
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /agent_walk\.worktree_env: "NOPE" is not KEY=VALUE/)
})

test('flaky: a list of match + optional rerun; entries without a match or with placeholders are dropped', () => {
  assert.deepEqual(cfgWith('').flaky, [])
  const cfg = cfgWith('flaky:\n  - match: intake\\.test\\.ts\n    rerun: node --test apps/server/test/intake.test.ts\n  - match: two servers race\n  - rerun: no match here\n  - match: <pattern>')
  assert.deepEqual(cfg.flaky, [
    { match: 'intake\\.test\\.ts', rerun: 'node --test apps/server/test/intake.test.ts' },
    { match: 'two servers race', rerun: null },
  ])
})

test('copy, setup, sync, env, start and smoke are all parsed', () => {
  const cfg = cfgWith(
    'agent_walk:\n  driver: x\n  claude_args: --a\n  copy: .env, .env.local\n  setup: npm install\n  sync: npm install && make migrate\n  env: A=1 B="x y"\n  start: npm run dev\n  smoke: curl -sf localhost:3000'
  )
  assert.deepEqual(cfg.agentWalk.copy, ['.env', '.env.local'])
  assert.equal(cfg.agentWalk.setup, 'npm install')
  assert.equal(cfg.agentWalk.sync, 'npm install && make migrate')
  assert.deepEqual(cfg.agentWalk.env, { A: '1', B: 'x y' })
  assert.equal(cfg.agentWalk.start, 'npm run dev')
  assert.equal(cfg.agentWalk.smoke, 'curl -sf localhost:3000')
})

test('copy trims entries and drops empties', () => {
  const cfg = cfgWith('agent_walk:\n  driver: x\n  claude_args: --a\n  copy: .env, .env.local ,')
  assert.deepEqual(cfg.agentWalk.copy, ['.env', '.env.local'])
})

test('a placeholder in start means the whole block is unconfigured', () => {
  const cfg = cfgWith('agent_walk:\n  driver: x\n  claude_args: --a\n  start: <the dev server command>')
  assert.equal(cfg.agentWalk, null)
})

test('parseEnvPairs splits whitespace-separated KEY=VALUE pairs, quotes and all', () => {
  assert.deepEqual(parseEnvPairs('A=1 B="x y" C=http://h:1/p?q=a=b'), {
    A: '1',
    B: 'x y',
    C: 'http://h:1/p?q=a=b',
  })
})

test('parseEnvPairs rejects a token with no "="', () => {
  assert.throws(() => parseEnvPairs('A=1 NOTAPAIR'), /agent_walk\.env: "NOTAPAIR" is not KEY=VALUE/)
})

test('parseEnvPairs rejects an empty key', () => {
  assert.throws(() => parseEnvPairs('=x'), /agent_walk\.env: "=x" is not KEY=VALUE/)
})

test('a bad env pair in the config surfaces as ok:false, not a crash', () => {
  const cfg = cfgWith('agent_walk:\n  driver: x\n  claude_args: --a\n  env: NOTAPAIR')
  assert.equal(cfg.ok, false)
  assert.match(cfg.reason, /agent_walk\.env: "NOTAPAIR" is not KEY=VALUE/)
})

test('parallel, worktrees and hooks are read', () => {
  const cfg = cfgWith(
    'agent_walk:\n  driver: x\n  claude_args: --a\n  worktrees: ../w\n  parallel: 5\n  reset: make db-reset\n  stop: make down'
  )
  assert.equal(cfg.agentWalk.parallel, 5)
  assert.equal(cfg.agentWalk.worktrees, '../w')
  assert.equal(cfg.agentWalk.reset, 'make db-reset')
  assert.equal(cfg.agentWalk.stop, 'make down')
})

test('a template placeholder left in the block means unconfigured', () => {
  const cfg = cfgWith('agent_walk:\n  driver: <how the agent drives the UI>\n  claude_args: --a')
  assert.equal(cfg.agentWalk, null)
})

test('the rest of the config is unaffected', () => {
  const cfg = cfgWith('agent_walk:\n  driver: x\n  claude_args: --a')
  assert.equal(cfg.ok, true)
  assert.deepEqual(cfg.appNames, ['app'])
})

test('keep_logs: a whole number of days, 0 keeps forever, anything else is the default', () => {
  const kl = (v) => cfgWith(`agent_walk:\n  driver: x\n  claude_args: --a\n  keep_logs: ${v}`).agentWalk.keepLogs
  assert.equal(kl(7), 7)
  assert.equal(kl(0), 0)
  assert.equal(kl(-1), 30)
  assert.equal(kl('soon'), 30)
})

test('auto_unpark: a whole number of retries per park, 0 turns them off, anything else is the default', () => {
  const au = (v) => cfgWith(`agent_walk:\n  driver: x\n  claude_args: --a\n  auto_unpark: ${v}`).agentWalk.autoUnpark
  assert.equal(au(0), 0)
  assert.equal(au(5), 5)
  assert.equal(au(-1), 2)
  assert.equal(au('lots'), 2)
})

test('build_profile_default: no key → null', () => {
  assert.equal(cfgWith('').buildProfileDefault, null)
})

test('build_profile_default: rush → "rush"', () => {
  assert.equal(cfgWith('build_profile_default: rush').buildProfileDefault, 'rush')
})

test('build_profile_default: standard → "standard"', () => {
  assert.equal(cfgWith('build_profile_default: standard').buildProfileDefault, 'standard')
})

test('build_profile_default: thorough → "thorough"', () => {
  assert.equal(cfgWith('build_profile_default: thorough').buildProfileDefault, 'thorough')
})

test('build_profile_default: invalid value → null without throwing', () => {
  const cfg = cfgWith('build_profile_default: fast')
  assert.equal(cfg.ok, true)
  assert.equal(cfg.buildProfileDefault, null)
})

test('build_profile_default: an invalid value is reported, never warned from loadConfig', () => {
  const warnCalls = []
  const origWarn = console.warn
  console.warn = (...args) => warnCalls.push(args.join(' '))
  try {
    const cfg = cfgWith('build_profile_default: speedy')
    assert.equal(cfg.buildProfileDefault, null)
    assert.equal(cfg.buildProfileDefaultInvalid, 'speedy')
    assert.equal(warnCalls.length, 0)
    assert.equal(cfgWith('build_profile_default: rush').buildProfileDefaultInvalid, null)
    assert.equal(cfgWith('').buildProfileDefaultInvalid, null)
  } finally {
    console.warn = origWarn
  }
})

const gitIn = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
const repoWith = (extra) => {
  const root = mkdtempSync(join(tmpdir(), 'cfg-git-'))
  gitIn(root, 'init', '-q', '-b', 'main')
  gitIn(root, 'config', 'user.email', 't@t')
  gitIn(root, 'config', 'user.name', 't')
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude/builder.md'), `---\nproject: t\nbase_branch: main\n${APPS}\n${extra}\n---\nbody\n`)
  gitIn(root, 'add', '-A')
  gitIn(root, 'commit', '-qm', 'init')
  return root
}

test('merge_into: unset → base_branch; a branch name → that branch, never the checkout', () => {
  const root = repoWith('')
  gitIn(root, 'switch', '-q', '-c', 'feature/x')
  assert.equal(loadConfig(root).mergeInto, 'main')
  assert.equal(loadConfig(root).mergeIntoCurrent, false)
  const dev = repoWith('merge_into: develop')
  gitIn(dev, 'switch', '-q', '-c', 'feature/x')
  assert.equal(loadConfig(dev).mergeInto, 'develop')
})

test('merge_into: current → the branch checked out in the main worktree, even read from a linked worktree', () => {
  const root = repoWith('merge_into: current')
  gitIn(root, 'switch', '-q', '-c', 'feature/x')
  const cfg = loadConfig(root)
  assert.equal(cfg.mergeIntoCurrent, true)
  assert.equal(cfg.mergeInto, 'feature/x')
  // A fleet worktree on builder/<feature> still answers with the human's branch.
  const wt = `${root}-wt`
  gitIn(root, 'worktree', 'add', '-q', '-b', 'builder/a', wt)
  assert.equal(loadConfig(wt).mergeInto, 'feature/x')
})

test('merge_into: current on a detached HEAD falls back to base_branch', () => {
  const root = repoWith('merge_into: current')
  gitIn(root, 'checkout', '-q', '--detach')
  assert.equal(loadConfig(root).mergeInto, 'main')
})

test('hasAgentWalk reads another branch\'s config text', () => {
  assert.equal(hasAgentWalk(null), false)
  assert.equal(hasAgentWalk(`---\nproject: t\n${APPS}\n---\n`), false)
  assert.equal(hasAgentWalk(`---\nproject: t\n${APPS}\nagent_walk:\n  driver: none\n  claude_args: --x\n---\n`), true)
})
