/**
 * The plugin's hooks (hooks/hooks.json): the SessionStart brief and the PreToolUse PR lock, each
 * spawned through its bash entry with a fake environment and stdin, the way Claude Code runs them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { leanRepo, git, LEAN } from './fixtures/lean-repo.mjs'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SESSION_START = join(PLUGIN, 'hooks', 'session-start')
const PR_LOCK = join(PLUGIN, 'hooks', 'pr-lock')

/** Run a hook entry. env replaces the inherited builder variables so the host's never leak in. */
function hook(entry, { env = {}, input = '', cwd = tmpdir() } = {}) {
  const base = { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN }
  delete base.BUILDER_FLEET_DIR
  delete base.CLAUDE_PROJECT_DIR
  const r = spawnSync(entry, [], { cwd, input, encoding: 'utf8', env: { ...base, ...env }, timeout: 15000 })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

const brief = (r) => JSON.parse(r.stdout).hookSpecificOutput
const plainDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'hooks-plain-')))

/** A builder project with no features at all. */
function emptyProject() {
  const root = plainDir()
  git(root, 'init', '-q', '-b', 'main')
  mkdirSync(join(root, '.claude'), { recursive: true })
  cpSync(join(LEAN, 'note-tags', 'builder.md'), join(root, '.claude', 'builder.md'))
  return root
}

/** Rewrite (or add, or with null remove) manifest keys. */
function setManifest(folder, keys) {
  const p = join(folder, 'MANIFEST.md')
  let text = readFileSync(p, 'utf8')
  for (const [k, v] of Object.entries(keys)) {
    const re = new RegExp(`^${k}:.*\\n?`, 'm')
    if (v == null) text = text.replace(re, '')
    else if (re.test(text)) text = text.replace(re, `${k}: ${v}\n`)
    else text += `${text.endsWith('\n') ? '' : '\n'}${k}: ${v}\n`
  }
  writeFileSync(p, text)
}

const call = (command, cwd) => JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...(cwd && { cwd }) })
const denied = (r) => {
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout).hookSpecificOutput
  assert.equal(out.hookEventName, 'PreToolUse')
  assert.equal(out.permissionDecision, 'deny')
  return out.permissionDecisionReason
}
const allowed = (r) => {
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
}

// --- hooks.json ---------------------------------------------------------------------------------

test('hooks.json: SessionStart on startup|clear|compact and PreToolUse on Bash, both through ${CLAUDE_PLUGIN_ROOT}', () => {
  const h = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks
  assert.equal(h.SessionStart[0].matcher, 'startup|clear|compact')
  assert.match(h.SessionStart[0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/session-start/)
  assert.equal(h.PreToolUse[0].matcher, 'Bash')
  assert.match(h.PreToolUse[0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/pr-lock/)
  for (const f of ['session-start', 'pr-lock']) assert.match(readFileSync(join(PLUGIN, 'hooks', f), 'utf8'), /^#!\/bin\/bash\n/, `${f}: PATH-independent shebang`)
})

// --- SessionStart -------------------------------------------------------------------------------

test('session-start: silent outside a builder project', () => {
  const r = hook(SESSION_START, { env: { CLAUDE_PROJECT_DIR: plainDir() } })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('session-start: silent under an unattended run (BUILDER_FLEET_DIR set)', () => {
  const { root } = leanRepo('note-tags')
  const r = hook(SESSION_START, { env: { CLAUDE_PROJECT_DIR: root, BUILDER_FLEET_DIR: join(root, '.builder', 'fleet') } })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('session-start: a builder project with nothing in flight gets the brief, no feature list', () => {
  const r = hook(SESSION_START, { env: { CLAUDE_PROJECT_DIR: emptyProject() } })
  assert.equal(r.status, 0, r.stderr)
  const out = brief(r)
  assert.equal(out.hookEventName, 'SessionStart')
  const text = out.additionalContext
  for (const s of ['/builder:brainstorm', '/builder:status', '/builder:resume', 'superpowers:brainstorming', 'superpowers:writing-plans',
    'superpowers:executing-plans', 'builder:test-driven-development', 'superpowers:systematic-debugging',
    'builder:verification-before-completion', 'superpowers:receiving-code-review', '/builder:signoff'])
    assert.ok(text.includes(s), s)
  assert.doesNotMatch(text, /In flight/)
  assert.ok(text.split('\n').length <= 16, `brief stays short: ${text.split('\n').length} lines`)
})

test('session-start: in-flight features listed with state and next step', () => {
  const { root } = leanRepo('note-tags')
  const text = brief(hook(SESSION_START, { env: { CLAUDE_PROJECT_DIR: root } })).additionalContext
  assert.match(text, /In flight, most recent first:\n- note-tags \(planned\) — next: [^\n]+ · \/builder:resume --path docs\/features\/note-tags/)
})

test('session-start: what the fleet parked or failed is listed with why and next, and not again under In flight', () => {
  const { root } = leanRepo('note-tags')
  mkdirSync(join(root, '.builder', 'fleet'), { recursive: true })
  writeFileSync(join(root, '.builder', 'fleet', 'fleet.json'), JSON.stringify({ features: {
    'note-tags': { status: 'parked', reason: "merge into main conflicted and an agent run couldn't settle it — next: finish the merge in /wt/note-tags, then /builder:agent" },
    other: { status: 'failed', reason: 'run timed out twice — both no output for 30 min (the idle timeout) — see /l/other-04.log — next: /builder:agent to retry' },
    busy: { status: 'building' },
  } }))
  const text = brief(hook(SESSION_START, { env: { CLAUDE_PROJECT_DIR: root } })).additionalContext
  assert.match(text, /Stopped in the fleet — each waits on you \(\/builder:fleet:status has the table; naming one in \/builder:agent retries it\):\n- ⛔ note-tags parked — merge into main conflicted and an agent run couldn't settle it — next: finish the merge in \/wt\/note-tags, then \/builder:agent\n- ⛔ other failed — run timed out twice — both no output for 30 min \(the idle timeout\) — next: \/builder:agent to retry\n/)
  assert.doesNotMatch(text, /busy/)
  assert.doesNotMatch(text, /In flight/, 'the one in-flight feature is the parked one, said once')
})

test('session-start: at most five features, then a pointer to /builder:status', () => {
  const { root, folder } = leanRepo('note-tags')
  const manifest = readFileSync(join(folder, 'MANIFEST.md'), 'utf8')
  for (let i = 1; i <= 6; i++) {
    const d = join(root, 'docs', 'features', `extra-${i}`)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'MANIFEST.md'), manifest.replace(/note-tags/g, `extra-${i}`))
    writeFileSync(join(d, 'SPEC.md'), `# extra-${i} — spec\n`)
  }
  const text = brief(hook(SESSION_START, { env: { CLAUDE_PROJECT_DIR: root } })).additionalContext
  const rows = text.split('\n').filter((l) => /^- (note-tags|extra-\d)/.test(l))
  assert.equal(rows.length, 5)
  assert.match(text, /- … and 2 more — \/builder:status lists them all/)
})

test('session-start: a config the scripts cannot read still gets the brief, minus the list', () => {
  const root = plainDir()
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude', 'builder.md'), 'not a config\n')
  const r = hook(SESSION_START, { env: { CLAUDE_PROJECT_DIR: root } })
  assert.equal(r.status, 0)
  const text = brief(r).additionalContext
  assert.match(text, /\/builder:brainstorm/)
  assert.doesNotMatch(text, /In flight/)
})

test('session-start: a broken PATH still yields the brief (bash builtins until node is found)', () => {
  const r = hook(SESSION_START, { env: { CLAUDE_PROJECT_DIR: emptyProject(), PATH: '' } })
  assert.equal(r.status, 0, r.stderr)
  assert.match(brief(r).additionalContext, /builder is set up in this repo/)
})

// --- PreToolUse: the PR lock --------------------------------------------------------------------

test('pr-lock: a command that is not gh pr create passes silently', () => {
  const { root } = leanRepo('note-tags')
  allowed(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input: call('git status && npm test', root) }))
  allowed(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input: call('gh pr view 12', root) }))
})

test('pr-lock: the fast path — a non-gh command exits in bash, no node, in a few ms', () => {
  const { root } = leanRepo('note-tags')
  const input = call('npm test -- --watch=false', root)
  hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input }) // warm the file cache
  const times = []
  for (let i = 0; i < 5; i++) {
    const t = process.hrtime.bigint()
    allowed(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input }))
    times.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  const best = Math.min(...times)
  // Spawning bash itself is most of it; node starting would add ~40 ms or more.
  assert.ok(best < 30, `fast path took ${best.toFixed(1)} ms`)
  // And no node at all: with no PATH and no HOME the non-gh path still exits clean and silent.
  allowed(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root, PATH: '', HOME: plainDir() }, input }))
})

test('pr-lock: gh pr create outside a builder project passes', () => {
  const root = plainDir()
  git(root, 'init', '-q', '-b', 'feature/x')
  allowed(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input: call('gh pr create --fill', root) }))
})

test('pr-lock: gh pr create on a branch no builder feature owns passes', () => {
  const { root } = leanRepo('note-tags')
  git(root, 'checkout', '-qb', 'chore/deps')
  allowed(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input: call('gh pr create --fill', root) }))
})

test('pr-lock: walk: none on the feature\'s branch → denied, with the next step', () => {
  const { root } = leanRepo('note-tags')
  const reason = denied(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input: call('git push -u origin HEAD && gh pr create --fill', root) }))
  assert.match(reason, /note-tags/)
  assert.match(reason, /walk: none/)
  assert.match(reason, /🔒 walk it, then \/builder:signoff --path docs\/features\/note-tags/)
})

test('pr-lock: no walk line at all counts as not walked', () => {
  const { root, folder } = leanRepo('note-tags')
  setManifest(folder, { walk: null })
  denied(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input: call('gh pr create --fill', root) }))
})

test('pr-lock: --head names the branch when the PR is not from the checked-out one', () => {
  const { root } = leanRepo('note-tags')
  git(root, 'checkout', '-q', 'main')
  denied(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input: call('gh pr create --head builder/note-tags --fill', root) }))
  allowed(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input: call('gh pr create --fill', root) }))
})

test('pr-lock: no cwd on stdin falls back to CLAUDE_PROJECT_DIR', () => {
  const { root } = leanRepo('note-tags')
  denied(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input: call('gh pr create --fill') }))
})

test('pr-lock: a human sign-off on the manifest → allowed', () => {
  const { root, folder } = leanRepo('note-tags')
  setManifest(folder, { state: 'verified', walk: 'luke 2026-10-24', 'agent-walk': 'off' })
  allowed(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input: call('gh pr create --fill', root) }))
})

test('pr-lock: an agent sign-off passes only in agent mode (agent-walk: on)', () => {
  const { root, folder } = leanRepo('note-tags')
  setManifest(folder, { state: 'verified', walk: 'agent-pass 2026-10-24 abc1234', 'agent-walk': 'on 2026-10-23' })
  allowed(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input: call('gh pr create --fill', root) }))
  setManifest(folder, { 'agent-walk': 'off' })
  assert.match(denied(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input: call('gh pr create --fill', root) })), /signed off by an agent/)
  setManifest(folder, { 'agent-walk': null })
  denied(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input: call('gh pr create --fill', root) }))
})

test('pr-lock: bad input, or another tool, never blocks', () => {
  const { root } = leanRepo('note-tags')
  allowed(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input: 'gh pr create {not json' }))
  allowed(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input: JSON.stringify({ tool_name: 'Write', tool_input: { content: 'gh pr create' }, cwd: root }) }))
  allowed(hook(PR_LOCK, { env: { CLAUDE_PROJECT_DIR: root }, input: '' }))
})
