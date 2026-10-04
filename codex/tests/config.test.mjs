import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, parseEnvPairs } from '../scripts/config.mjs'

const APPS = 'apps:\n  - name: app\n    path: app/\n    role: app\n    commit: auto'
const cfgWith = (extra) => {
  const root = mkdtempSync(join(tmpdir(), 'cfg-'))
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude/builder.md'), `---\nproject: t\n${APPS}\n${extra}\n---\nbody\n`)
  return loadConfig(root)
}

test('Codex config takes precedence and malformed authoritative config never falls through', () => {
  const root = mkdtempSync(join(tmpdir(), 'cfg-precedence-'))
  for (const dir of ['.claude', '.builder', '.codex']) mkdirSync(join(root, dir))
  const config = (project) => `---\nproject: ${project}\n${APPS}\n---\nbody\n`
  writeFileSync(join(root, '.claude/builder.md'), config('legacy'))
  writeFileSync(join(root, '.builder/config.md'), config('portable'))
  assert.equal(loadConfig(root).project, 'portable')
  writeFileSync(join(root, '.codex/builder.md'), config('codex'))
  assert.equal(loadConfig(root).project, 'codex')
  writeFileSync(join(root, '.codex/builder.md'), 'malformed')
  const malformed = loadConfig(root)
  assert.equal(malformed.ok, false)
  assert.equal(malformed.path, join(root, '.codex/builder.md'))
})

test('project model mapping is exposed for task-specific dispatch', () => {
  const cfg = cfgWith('models:\n  fast: custom-fast\n  fast_effort: low\n  judgment: custom-judgment')
  assert.deepEqual(cfg.models, { fast: 'custom-fast', fast_effort: 'low', judgment: 'custom-judgment' })
})

test('merge target follows explicit merge_into, then base_branch, with provenance', () => {
  assert.equal(cfgWith('').mergeInto, 'main')
  assert.equal(cfgWith('').mergeIntoConfigured, false)
  assert.equal(cfgWith('base_branch: develop').mergeInto, 'develop')
  assert.equal(cfgWith('base_branch: develop').mergeIntoConfigured, true)
  assert.equal(cfgWith('base_branch: develop\nmerge_into: release').mergeInto, 'release')
  assert.equal(cfgWith('merge_into: release').mergeIntoConfigured, true)
})

test('blank landing targets fall back to meaningful branch names without configured provenance', () => {
  for (const blank of ["''", '""', '"   "', 'null', '~']) {
    const base = cfgWith(`merge_into: ${blank}\nbase_branch: work`)
    assert.equal(base.ok, true)
    assert.equal(base.mergeInto, 'work')
    assert.equal(base.mergeIntoConfigured, true)
    const absent = cfgWith(`merge_into: ${blank}\nbase_branch: ${blank}`)
    assert.equal(absent.ok, true)
    assert.equal(absent.baseBranch, 'main')
    assert.equal(absent.mergeInto, 'main')
    assert.equal(absent.mergeIntoConfigured, false)
  }
  const trimmed = cfgWith('merge_into: " release "\nbase_branch: " develop "')
  assert.equal(trimmed.mergeInto, 'release')
  assert.equal(trimmed.baseBranch, 'develop')
})

test('non-string branch configuration fails instead of landing on a fallback branch', () => {
  for (const key of ['base_branch', 'merge_into']) {
    for (const value of ['false', '17', '[main]', '\n  target: main']) {
      const cfg = cfgWith(`${key}: ${value}`)
      assert.equal(cfg.ok, false)
      assert.match(cfg.reason, new RegExp(`${key} must be a branch-name string`))
    }
  }
})

test('build profile defaults accept only automatic presets and expose invalid authoring', () => {
  assert.equal(cfgWith('').buildProfileDefault, null)
  assert.equal(cfgWith('').buildProfileDefaultInvalid, null)
  for (const preset of ['rush', 'standard', 'thorough']) {
    const cfg = cfgWith(`build_profile_default: ${preset}`)
    assert.equal(cfg.buildProfileDefault, preset)
    assert.equal(cfg.buildProfileDefaultInvalid, null)
  }
  for (const value of ['thorough-you', 'custom', 'fast', 'false', '17']) {
    const cfg = cfgWith(`build_profile_default: ${value}`)
    assert.equal(cfg.ok, true)
    assert.equal(cfg.buildProfileDefault, null)
    assert.equal(cfg.buildProfileDefaultInvalid, value)
  }
})

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
