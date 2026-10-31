#!/usr/bin/env node
/**
 * handoff — the build lane's end state, written once for the walk lane, so the walk lane's resume
 * reads one file instead of re-deriving it in ~7 calls (REFERENCE headings, §Walk readiness, build's
 * walk section, walk.md, the verifier's verdicts, the manifest).
 *
 *   node <builder>/scripts/handoff.mjs write <folder> [--note "<line>"]…
 *   node <builder>/scripts/handoff.mjs read  <folder> [--no-docs]
 *
 * write → <WS>/handoff.md: the manifest's state, ready, contract, test plan and next; HEAD and the
 *   branch; the verifier's latest verdict per tier (commit, phase,
 *   merge) for this branch, from `.builder/verify/requests/`; the contract freeze;
 *   walk.md's item counts; the open items (a `blocked:` line, open `## Fixes` rows, the ledger's
 *   Ruling / deferred-minor / parked lines); this config's readiness facts (agent_walk.start / smoke /
 *   env and §Walk readiness, verbatim); and the walk lane's route with the exact advance.mjs call
 *   that records readiness. --note adds a line only the build lane knows. Run it as the build lane's
 *   last act, after its manifest commit.
 *
 * read → prints `trust: ok — …` and the handoff, then `docs.mjs walk-lane` (unless --no-docs), exit 0.
 *   Or `stale: <why> — re-derive from the manifest as before` and exit 3, when there is no handoff, the
 *   recorded head is not an ancestor of HEAD, code changed since it (registry-only commits don't
 *   count), or the manifest's state / ready / contract no longer match. The manifest always wins.
 *
 * Judgment left to the walk lane: running readiness itself (migrations, the smoke, what a failure
 * means) and deciding a restart-class change; the handoff only says where things stood.
 *
 * Safe to re-run: write rewrites the file only when its content changed (the date, not the time, is
 * recorded); read writes nothing.
 */
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFeature, read, writeAtomic, git, shortHead, currentBranch, today, mdSection, configSection, codeChangedSince, parseArgs, cli } from './feature-core.mjs'
import { bundle } from './docs.mjs'

const TRACKED = ['state', 'ready', 'contract']

/** The branch's latest done verdict per tier, from the main checkout's request files. */
function verifierLines(f) {
  let reqs = []
  try {
    const main = git(f.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).replace(/\/\.git$/, '')
    const d = join(main, '.builder', 'verify', 'requests')
    for (const n of readdirSync(d).filter((n) => n.endsWith('.json'))) {
      // One half-written file must not blank every tier.
      try {
        const r = JSON.parse(read(join(d, n)))
        if (r && typeof r === 'object') reqs.push(r)
      } catch {}
    }
  } catch {}
  const branch = currentBranch(f.root)
  const mine = reqs.filter((r) => r.branch === branch && r.state === 'done' && r.verdict).sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
  return ['commit', 'phase', 'merge'].map((tier) => {
    const v = mine.filter((r) => r.tier === tier).at(-1)?.verdict
    return v ? `- ${tier}: ${String(v.status ?? '?').toUpperCase()} at ${String(v.sha).slice(0, 7)} — ${(v.regressions ?? []).length} regression(s), ${(v.flakes ?? []).length} flake(s), ${(v.known ?? []).length} known` : `- ${tier}: no verdict yet`
  })
}

function walkLine(ws) {
  const w = read(join(ws, 'walk.md'))
  if (!w) return 'walk.md — not written yet: `node <builder>/scripts/walk-script.mjs <folder>`'
  const cross = w.indexOf('\n## Cross-app (verify E2E)')
  const perApp = (cross < 0 ? w : w.slice(0, cross)).split('\n').filter((l) => /^\d+\.\s/.test(l))
  const e = (cross < 0 ? '' : w.slice(cross)).split('\n').filter((l) => /^E\d+\.\s/.test(l)).length
  return `walk.md — ${perApp.length} per-app items (${perApp.filter((l) => /^\d+\.\s+\[risk\]/.test(l)).length} [risk])${e ? ` + cross-app E1–E${e}` : ''} · ${join(ws, 'walk.md')}`
}

export function compose(f, notes = []) {
  const ws = f.ws()
  const m = f.manifest
  const rel = f.rel
  const ledger = (read(join(ws, 'progress.md')) ?? '').split('\n')
  const fixes = (mdSection(read(f.specPath) ?? '', 'Fixes', { level: 2 })?.body ?? '').split('\n').filter((l) => /^\s*-\s*\[ \]/.test(l))
  const aw = f.cfg?.agentWalk
  const readiness = configSection(f.cfg, 'Walk readiness').trim()
  const env = aw?.env && Object.keys(aw.env).length ? Object.entries(aw.env).map(([k, v]) => `${k}=${v}`).join(' ') : null
  const walkLane = m.state === 'building' && /^pending\b/.test(m.ready ?? '')
  const agent = /^on\b/.test(m['agent-walk'] ?? '')
  const walkWritten = read(join(ws, 'walk.md')) != null
  const next = agent ? `/builder:agent-walk --path ${rel}` : `🔒 your walk → /builder:signoff --path ${rel}`
  const lines = [
    `# ${f.feature} — handoff from the build lane`,
    '',
    `written: ${today()} · head: ${shortHead(f.root)} · branch: ${currentBranch(f.root) ?? '(detached)'}`,
    ...['state', 'ready', 'contract', 'tests', 'agent-walk', 'next'].filter((k) => m[k] != null).map((k) => `${k}: ${m[k]}`),
    '',
    '## Route for the walk lane',
    '',
    walkLane
      ? [
          `1. Walk readiness — REFERENCE §Walk readiness, against the walk env${aw?.start ? ' the fleet started (never start or restart it here)' : ''}: migrations, regenerate, the smoke.`,
          `2. Record it: \`node <builder>/scripts/advance.mjs ${rel} --set state=built --set "ready=yes <YYYY-MM-DD> <sha>" --set "next=${next}" --head --commit built\``,
          agent
            ? `3. Then \`/builder:agent-walk --path ${rel}\` — ${walkWritten ? 'walk.md is already written' : 'write walk.md first: `node <builder>/scripts/walk-script.mjs ' + rel + '`'}; don't re-run the final review.`
            : `3. Then 🔒 the human's walk (resume §🔒 The walk) — ${walkWritten ? 'walk.md is already written' : 'write walk.md first: `node <builder>/scripts/walk-script.mjs ' + rel + '`'}; don't re-run the final review.`,
        ].join('\n')
      : `The manifest says state ${m.state ?? '?'}, ready ${m.ready ?? '?'} — not the walk lane's entry (building + ready pending). Route on the manifest's next: ${m.next ?? '?'}`,
    '',
    '## Verifier (the latest verdict per tier)',
    '',
    ...verifierLines(f),
    '',
    '## Contract',
    '',
    `contract: ${m.contract ?? 'none'}${/^frozen\b/.test(m.contract ?? '') ? ' — consumers are briefed against it; a change is /builder:revise' : ''}`,
    '',
    '## Walk script',
    '',
    walkLine(ws),
    '',
    '## Open items',
    '',
    `- blocked: ${m.blocked ?? 'none'}`,
    `- SPEC ## Fixes: ${fixes.length ? `${fixes.length} open` : 'none open'}`,
    ...fixes.map((l) => `  ${l.trim()}`),
    ...ledger.filter((l) => /Ruling:|minor \(deferred\)|\bparked\b/i.test(l)).map((l) => `- ${l}`),
    ...notes.map((n) => `- ${n}`),
    '',
    '## Readiness facts for this config',
    '',
    aw ? `- agent_walk.start: ${aw.start ? `\`${aw.start}\`` : 'not set — readiness starts nothing under the fleet'}` : '- no agent_walk block',
    ...(aw?.smoke ? [`- agent_walk.smoke: \`${aw.smoke}\``] : []),
    ...(env ? [`- agent_walk.env: ${env}`] : []),
    '',
    readiness ? "The config's §Walk readiness, verbatim:\n\n" + readiness : "The config has no §Walk readiness section — infer the commands as /builder:init would, and say so.",
  ]
  return lines.join('\n') + '\n'
}

function write(f, a) {
  const path = join(f.ws(), 'handoff.md')
  const text = compose(f, a.note ?? [])
  if (read(path) === text) console.log(`handoff: unchanged — ${path}`)
  else {
    writeAtomic(path, text)
    console.log(`handoff: written — ${path}`)
  }
  return 0
}

function readCmd(f, a) {
  const path = join(f.ws({ create: false }), 'handoff.md')
  const text = read(path)
  const stale = (why) => {
    console.log(`stale: ${why} — re-derive from the manifest as before`)
    return 3
  }
  if (!text) return stale(`no handoff.md in ${f.ws({ create: false })}`)
  const head = /^written: .* · head: (\S+)/m.exec(text)?.[1]
  if (!head || git(f.root, ['merge-base', '--is-ancestor', head, 'HEAD'], { allowFail: true }) === null) return stale(`its head ${head ?? '?'} is not in this branch's history`)
  const changed = codeChangedSince(f.root, head, f.cfg?.registry ?? 'docs/features') ?? []
  if (changed.length) return stale(`code changed since the handoff (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ` +${changed.length - 5} more` : ''})`)
  const top = text.split('\n## ')[0]
  for (const k of TRACKED) {
    const was = new RegExp(`^${k}: (.*)$`, 'm').exec(top)?.[1] ?? null
    const now = f.manifest[k] ?? null
    if (was !== now) return stale(`the manifest moved since the handoff (${k}: ${was ?? '—'} → ${now ?? '—'})`)
  }
  console.log(`trust: ok — head ${head}${shortHead(f.root) !== head ? ` (HEAD ${shortHead(f.root)}: registry-only commits since)` : ''}, the manifest agrees (${TRACKED.map((k) => `${k} ${f.manifest[k] ?? '—'}`).join(' · ')})`)
  console.log('')
  process.stdout.write(text)
  if (!a['no-docs']) {
    const b = bundle('walk-lane', { config: false, root: f.root })
    console.log('')
    for (const s of b.sections) console.log(`--- ${s.label}\n\n${s.text}\n`)
  }
  return 0
}

async function main(argv) {
  const a = parseArgs(argv, { repeat: ['note'], bool: ['no-docs'] })
  const [cmd, folder] = a._
  if (!['write', 'read'].includes(cmd) || !folder) {
    console.error('usage: handoff.mjs write <folder> [--note "<line>"]… | handoff.mjs read <folder> [--no-docs]')
    return 2
  }
  const f = openFeature(folder)
  return cmd === 'write' ? write(f, a) : readCmd(f, a)
}

if ((() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()) cli(main)
