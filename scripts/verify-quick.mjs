#!/usr/bin/env node
/**
 * verify-quick — the quick check after sign-off: the mechanical part of /builder:verify's checklist in
 * one call, no model judgment. Verify is optional after sign-off — the human (or the fleet) picks
 * Quick check (this), Ship it (`--skip`) or Full verify (/builder:verify) — and nothing refuses a ship
 * or a merge for want of any of them. A gap here is advice, never a block.
 *
 *   node <builder>/scripts/verify-quick.mjs <folder> [--json] [--max-wait <seconds>] [--no-record] [--message <merge subject>]
 *   node <builder>/scripts/verify-quick.mjs <folder> --skip
 *
 * The checks (skills/verify/SKILL.md's items, the mechanical subset):
 *   walk        (1)  the SPEC header carries `✅ SIGNED OFF` with a `walk:` line, or `🤖 AGENT SIGNED OFF`
 *                    with `walk: agent-pass …` (and, when it is on this machine, that round's report
 *                    ends `verdict: PASS`)
 *   fixes       (2)  no `- [ ]` left under `## Fixes`
 *   schema      (4)  every §Schema & API changes row's Status carries a migration id or a marking —
 *                    not empty, `planned`, `pending`, `todo`, `tbd`, `open`
 *   decisions   (6)  no OPEN (or empty) Ruling in §Decisions
 *   obligations (13) check-obligations.mjs <folder> finds no FAIL
 *   merge tier  (3)  the verifier's merge tier green on HEAD — `verify.mjs verdict <branch> --tier merge`;
 *                    an older green holds when only the registry changed since. A run still going is
 *                    waited on (`verify.mjs wait`); none → `request <root> HEAD --tier merge --hold`,
 *                    then waited on. The wait is bounded by --max-wait (default 1800 s): time, not
 *                    tokens. Past it, a gap naming the request id to wait on.
 *
 * Output: one `✓ <check>: <what>` / `✗ <check>: <the gap>` line each, then `QUICK CHECK: PASS` or
 * `QUICK CHECK: GAPS (n)`. --json prints { feature, folder, sha, checks, pass, gaps, recorded }.
 * Exit 0 pass · 1 gaps (or --skip refused) · 2 usage.
 *
 * On PASS it records `verify: QUICK <YYYY-MM-DD> <sha7>` (the HEAD it checked) and `next:` (resume —
 * or the hold) in the manifest and commits `docs(<key>): <feature> — quick check passed`; a
 * `verify: READY` already there stands and is never downgraded. --no-record writes nothing.
 * --skip records `verify: SKIPPED <YYYY-MM-DD>` the same way (`— verify skipped`) without checking
 * anything; it is refused only on a feature that was never signed off. Both re-run as a no-op.
 *
 * --message is the merge commit's subject for a merge tier this check requests (the fleet passes its
 * own). BUILDER_VERIFY_BIN overrides the verify client (tests stub it).
 */
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openFeature, read, mdSection, tableRows, shortHead, currentBranch, codeChangedSince, today, parseArgs, cli, BUILDER } from './feature-core.mjs'
import { advance } from './advance.mjs'
import { isSet } from './manifest.mjs'

const verifyBin = () => process.env.BUILDER_VERIFY_BIN || join(BUILDER, 'scripts', 'verify', 'verify.mjs')
const unquote = (v) => String(v ?? '').replace(/^"(.*)"$/, '$1')

/** The `>` lines right under the SPEC's title. */
function headerLines(spec) {
  const all = String(spec ?? '').split('\n')
  const t = all.findIndex((l) => /^# /.test(l))
  const out = []
  for (let j = t + 1; t >= 0 && j < all.length && all[j].startsWith('>'); j++) out.push(all[j])
  return out
}

/** The sign-off a SPEC header carries: { kind: 'human' | 'agent', line } or null. */
export function signoffOf(spec) {
  for (const l of headerLines(spec)) {
    if (/^> ✅ SIGNED OFF\b/.test(l)) return { kind: 'human', line: l }
    if (/^> 🤖 (AGENT SIGNED OFF|AGENT-VERIFIED)\b/.test(l)) return { kind: 'agent', line: l }
  }
  return null
}

const ok = (name, detail) => ({ name, ok: true, detail })
const gap = (name, detail) => ({ name, ok: false, detail })

function walkCheck(f, spec) {
  const s = signoffOf(spec)
  if (!s) return gap('walk', `no sign-off on the SPEC — the walk comes first (/builder:signoff --path ${f.rel}, or the agent walk)`)
  const mf = f.manifest
  const hasManifest = f.manifestText != null
  if (s.kind === 'human') {
    const by = /^> ✅ SIGNED OFF (\S+) — (\S+) · by (.+?):/.exec(s.line)
    if (hasManifest && !isSet(mf.walk)) return gap('walk', 'the SPEC says signed off but the manifest has no `walk:` line — who walked it is not recorded')
    return ok('walk', by ? `signed off by ${by[3]} ${by[1]} at ${by[2]}` : 'signed off')
  }
  if (hasManifest && !/^agent-pass\b/.test(mf.walk ?? '')) return gap('walk', `the SPEC says agent signed off but \`walk:\` reads "${mf.walk ?? 'absent'}"`)
  if (/— no walk\b/.test(s.line)) return ok('walk', 'agent signed off with no walk (tests: walk=none) — not walked, not human-tested')
  const n = /agent walk round (\d+)/.exec(s.line)?.[1]
  const report = n ? read(join(f.ws({ create: false }), 'agent-walk', `round-${n}`, 'report.md')) : null
  if (report != null) {
    const verdict = report.trim().split('\n').reverse().find((l) => /^verdict:/.test(l.trim()))?.trim() ?? 'no verdict line'
    if (!/^verdict:\s*PASS\b/.test(verdict)) return gap('walk', `agent walk round ${n}'s report says "${verdict}"`)
  }
  return ok('walk', `agent signed off${n ? ` — walk round ${n} PASS` : ''}${n && report == null ? ' (its report is not on this machine)' : ''} — not human-tested`)
}

function fixesCheck(spec) {
  const i = spec.search(/^## Fixes\s*$/m)
  const open = i < 0 ? [] : spec.slice(i).split('\n').slice(1).filter((l) => /^\s*[-*] \[ \]/.test(l))
  return open.length ? gap('fixes', `${open.length} open under ## Fixes — first: ${open[0].replace(/^\s*[-*] \[ \]\s*/, '')}`) : ok('fixes', 'none open')
}

const UNLANDED = /^(planned|pending|todo|tbd|open|proposed|wip|—|-|\?|\[ \])?$/i
function schemaCheck(spec) {
  const sec = mdSection(spec, 'Schema & API changes', { level: 2 }) ?? mdSection(spec, 'Schema', { level: 2 })
  if (!sec) return ok('schema', 'no §Schema & API changes section')
  const rows = tableRows(sec.body).filter((c) => c.length > 1 && /\S/.test(c[0]))
  if (!rows.length) return ok('schema', /no schema change/i.test(sec.body) ? 'no schema change' : 'no rows')
  const bad = rows.filter((c) => UNLANDED.test(c.at(-1).replace(/[*_`]/g, '').trim().split(/\s/)[0] ?? ''))
  if (!bad.length) return ok('schema', `${rows.length} row${rows.length === 1 ? '' : 's'}, each with a Status`)
  return gap('schema', `${bad.map((c) => `${`${c[0]} ${c[2] ?? ''}`.trim()} — Status "${c.at(-1) || 'empty'}"`).join('; ')} — no migration id and not marked (landed, deferred with a decider, n/a)`)
}

function decisionsCheck(spec) {
  const sec = mdSection(spec, 'Decisions', { level: 2 })
  if (!sec) return ok('decisions', 'no §Decisions section')
  const rows = tableRows(sec.body).map((c) => c.map((x) => x.replace(/^[*_`]+|[*_`]+$/g, '')))
  const open = rows.filter((c) => c.length < 3 || !c[2] || c.some((x) => /^open\b/i.test(x)))
  return open.length ? gap('decisions', `${open.map((c) => c[0]).join(', ')} OPEN in §Decisions`) : ok('decisions', `none OPEN (${rows.length} ruled)`)
}

function obligationsCheck(f) {
  const r = spawnSync(process.execPath, [join(BUILDER, 'scripts', 'check-obligations.mjs'), f.dir, '--json'], { cwd: f.root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: f.root } })
  let results
  try {
    results = JSON.parse(r.stdout)
  } catch {
    return gap('obligations', `check-obligations could not run (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`)
  }
  const fails = results.flatMap((x) => x.findings ?? []).filter((x) => x.severity === 'FAIL')
  return fails.length ? gap('obligations', `${fails.length} dangling — ${fails.map((x) => `[${x.id}] ${x.rule}`).join('; ')}`) : ok('obligations', 'check-obligations: every obligation discharged')
}

function verifyCli(root, args) {
  const r = spawnSync(process.execPath, [verifyBin(), ...args], { cwd: root, encoding: 'utf8' })
  if (r.error) throw r.error
  return { out: (r.stdout ?? '').replace(/\s+$/, ''), status: r.status, err: (r.stderr ?? '').trim() }
}

/** `verify <tier> <sha7> <branch>: STATUS …` → { sha, status, line } or null. */
const verdictLine = (out) => {
  const line = out.split('\n')[0] ?? ''
  const m = /^verify merge ([0-9a-f]{4,40}) \S+: ([A-Z-]+)/.exec(line)
  return m ? { sha: m[1], status: m[2], line } : null
}
const pendingId = (out) => [...out.matchAll(/^pending: merge \S+ (\S+)$/gm)].at(-1)?.[1] ?? null

function mergeCheck(f, maxWait, message = null) {
  const branch = currentBranch(f.root)
  if (!branch) return gap('merge tier', 'HEAD is detached — check out the feature branch')
  const registry = f.cfg?.registry ?? 'docs/features'
  const holds = (sha) => (codeChangedSince(f.root, sha, registry) ?? ['?']).length === 0
  const judge = (v) => {
    if (v.status !== 'GREEN') return gap('merge tier', `${v.line} — /builder:verify --path ${f.rel} works the failures`)
    if (/untested/.test(v.line)) return gap('merge tier', `${v.line} — the config names no tests, so nothing ran`)
    return ok('merge tier', v.line)
  }
  const request = () => {
    const r = verifyCli(f.root, ['request', f.root, 'HEAD', '--tier', 'merge', '--hold', ...(message ? ['--message', message] : [])])
    const id = r.status === 0 ? r.out.split('\n').at(-1).trim() : null
    return id || null
  }
  const until = Date.now() + maxWait * 1000
  let id = null
  const first = verifyCli(f.root, ['verdict', branch, '--tier', 'merge'])
  const done = [0, 1, 3, 4, 6].includes(first.status) ? verdictLine(first.out) : null
  id = pendingId(first.out)
  if (done && !id && holds(done.sha)) return judge(done)
  if (!id) id = request()
  if (!id) return gap('merge tier', `the merge tier could not be requested — run /builder:verify --path ${f.rel}`)
  for (let tries = 0; tries < 3; tries++) {
    let w
    for (;;) {
      const left = Math.ceil((until - Date.now()) / 1000)
      w = verifyCli(f.root, ['wait', id, '--max', String(Math.max(1, Math.min(left, 540)))])
      if (w.status !== 75 || Date.now() >= until) break
    }
    if (w.status === 75) return gap('merge tier', `still running (${id}) after ${maxWait}s — run the quick check again later, or \`verify.mjs wait ${id}\``)
    const v = verdictLine(w.out)
    if (!v) return gap('merge tier', `no verdict from the verifier (exit ${w.status}): ${(w.out || w.err).split('\n')[0]}`)
    if (holds(v.sha)) return judge(v)
    id = request() // it tested older code: once more, on HEAD
    if (!id) return gap('merge tier', `the merge tier could not be requested — run /builder:verify --path ${f.rel}`)
  }
  return gap('merge tier', `the code kept changing under the merge tier (${id}) — run the quick check again`)
}

/** Every check, in a fixed order — the cheap ones first, the merge tier (which may wait) last. */
export function quickCheck(f, { maxWait = 1800, message = null } = {}) {
  const spec = read(f.specPath)
  const sha = shortHead(f.root)
  // No SPEC: one gap for the spec's checks — the merge tier is still worth reading.
  const specChecks = spec == null ? [gap('spec', `no SPEC.md in ${f.rel} — nothing to check the walk, schema or decisions against`)] : [walkCheck(f, spec), fixesCheck(spec), schemaCheck(spec), decisionsCheck(spec), obligationsCheck(f)]
  const checks = [...specChecks, mergeCheck(f, maxWait, message)]
  return { sha, checks, gaps: checks.filter((c) => !c.ok).length }
}

const nextOf = (f) => (isSet(f.manifest.hold) ? `🛑 held — ${unquote(f.manifest.hold)}` : `/builder:resume --path ${f.rel}`)

/** Record `verify: <value>` + next and commit — unless READY already stands. → { recorded, lines } */
function record(f, value, preset) {
  if (f.manifestText == null) return { recorded: null, lines: ['manifest: none (a condensed folder) — nothing recorded'] }
  if (/^READY\b/.test(f.manifest.verify ?? '')) return { recorded: null, lines: [`manifest: verify ${f.manifest.verify} — READY stands, not recorded over`] }
  // Already recorded on this HEAD's parent (a re-run): the same value would only change the date.
  if (/^(QUICK|SKIPPED)\b/.test(f.manifest.verify ?? '') && value.split(' ')[0] === f.manifest.verify.split(' ')[0] && (value.startsWith('SKIPPED') || value.split(' ')[2] === f.manifest.verify.split(' ')[2]))
    return { recorded: f.manifest.verify, lines: [`already applied: verify ${f.manifest.verify}`] }
  const r = advance(f, { sets: [['verify', value], ['next', nextOf(f)]], head: true, commit: preset })
  return { recorded: value, lines: r.lines }
}

async function main(argv) {
  const a = parseArgs(argv, { bool: ['json', 'skip', 'no-record'] })
  const maxWait = a['max-wait'] == null ? 1800 : Number(a['max-wait'])
  if (!a._[0] || !Number.isFinite(maxWait) || maxWait < 0) {
    console.error('usage: verify-quick.mjs <folder> [--json] [--max-wait <seconds>] [--no-record] [--message <merge subject>] | <folder> --skip')
    return 2
  }
  if (!existsSync(a._[0])) {
    console.error(`no such feature folder: ${a._[0]}`)
    return 2
  }
  const f = openFeature(a._[0])
  if (a.skip) {
    if (!signoffOf(read(f.specPath))) {
      console.error(`${f.feature} is not signed off — there is no verify to skip yet; the walk comes first (/builder:resume --path ${f.rel})`)
      return 1
    }
    const r = record(f, `SKIPPED ${today()}`, 'verify-skipped')
    for (const l of r.lines) console.log(l)
    return 0
  }
  const res = quickCheck(f, { maxWait, message: a.message ?? null })
  const pass = res.gaps === 0
  const rec = pass && !a['no-record'] ? record(f, `QUICK ${today()} ${res.sha}`, 'verify-quick') : { recorded: null, lines: [] }
  if (a.json) {
    console.log(JSON.stringify({ feature: f.feature, folder: f.rel, sha: res.sha, checks: res.checks, pass, gaps: res.gaps, recorded: rec.recorded }, null, 2))
    return pass ? 0 : 1
  }
  console.log(`quick check — ${f.feature} at ${res.sha}`)
  for (const c of res.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`)
  console.log(pass ? 'QUICK CHECK: PASS' : `QUICK CHECK: GAPS (${res.gaps})`)
  for (const l of rec.lines) console.log(l)
  return pass ? 0 : 1
}

if ((() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()) cli(main)
