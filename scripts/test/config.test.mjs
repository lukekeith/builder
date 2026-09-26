import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, parseEnvPairs } from '../config.mjs'

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
    env: {},
    start: null,
    smoke: null,
  })
})

test('copy, setup, env, start and smoke are all parsed', () => {
  const cfg = cfgWith(
    'agent_walk:\n  driver: x\n  claude_args: --a\n  copy: .env, .env.local\n  setup: npm install\n  env: A=1 B="x y"\n  start: npm run dev\n  smoke: curl -sf localhost:3000'
  )
  assert.deepEqual(cfg.agentWalk.copy, ['.env', '.env.local'])
  assert.equal(cfg.agentWalk.setup, 'npm install')
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
