#!/usr/bin/env node
/**
 * condense — the SPEC surgery at sign-off and at ship (REFERENCE §Condense, ship §At sign-off and
 * §At ship), done by script instead of a hand-written `node -e` / Python heredoc each time.
 *
 *   node <builder>/scripts/condense.mjs <folder> --signoff agent [--round N] [--no-walk]
 *   node <builder>/scripts/condense.mjs <folder> --signoff human --name "<name>" --words "<words>" [--sha S] [--hold "<reason>"]
 *   node <builder>/scripts/condense.mjs <folder> --ship (--pr N | --into <branch> | --merged <sha> [--into <branch>])
 *     … plus advance.mjs's own flags (--set, --unset, --head, --ledger, --commit, --body, --trailer, --no-commit)
 *
 * --signoff agent   agent-walk §4 AGENT-PASS, whole: the 🤖 header line under the title, the §Plan
 *                   index cut by its heading, `git rm` PLAN.md (and PARKED.md), the manifest
 *                   (`walk: agent-pass <date> <sha>`, `state: signed-off`, `verify: none`, `head`,
 *                   `next: /builder:verify --path <folder>`) and the commit
 *                   `docs(<key>): <feature> agent signed off (not human-tested)`. The round is the
 *                   newest `<WS>/agent-walk/round-N/report.md` whose verdict is PASS, its sha that
 *                   report's `sha:` line — or, when the manifest already says `walk: agent-pass …`,
 *                   that line's date and sha (agent-walk's precondition table). --no-walk is the
 *                   `end=none|touched` sign-off at HEAD, with no walker.
 * --signoff human   ship §At sign-off: `> ✅ SIGNED OFF <date> — <sha> · by <name>: "<words>"` (+ the
 *                   `🛑 PR HELD` line when --hold or the manifest's `hold:` is set), the §Plan cut,
 *                   the `git rm`. The manifest's PASS row is /builder:signoff's — pass it as --set;
 *                   the commit defaults to `docs(<key>): condense <feature> at sign-off`.
 * --ship            ship §At ship: the archive collision check first, then the header flipped to
 *                   SHIPPED (PR form with --pr, agent form with --into), `git rm` MANIFEST.md, the
 *                   workspace removed, a program parent's `child:` line set to shipped (its
 *                   PROGRAM.md flipped and archived when every child has shipped), `git mv` into
 *                   `<registry>/_archive/`, one commit. Refuses unless `verify: READY`; --into also
 *                   refuses until <branch> is merged into this branch. --merged is the form for a
 *                   feature whose code already reached the target with no ship (a manual merge, a
 *                   `build: here` feature, a PR merged before ship ran): `✅ SHIPPED <date> — merged
 *                   <sha>`, written on the target, refused unless <sha> is in the target (merge_into,
 *                   or --into) and in this branch — a header naming a merge that isn't there lies.
 *
 * What stays with the skill (judgment): whether the walk passed at all (agent-walk §3 reads the
 * report); the human's name and verbatim words, and whether this is a PASS (/builder:signoff); that
 * the PR is open and which number it is (`gh pr view` — ask, never guess); the manifest's PASS row
 * for a human sign-off over an agent pass (verify READY at HEAD or not).
 *
 * Safe to re-run: each step looks before it writes — a header already in place, a §Plan already
 * gone, a PLAN.md already removed, a folder already archived — and a call whose result already
 * landed prints `already applied` / `already shipped` and commits nothing.
 */
import { existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname, basename, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openFeature, headings, read, writeAtomic, git, shortHead, today, parseArgs, cli, posix, repoRoot, workspaceDir, setManifestKeys } from './feature-core.mjs'
import { advance } from './advance.mjs'
import { parseManifest, isSet } from './manifest.mjs'
import { parseTestPlan } from './profile.mjs'
import { loadConfig } from './config.mjs'
import { ARCHIVE } from './registry.mjs'

/** SPEC text without its `## Plan` section — cut by the heading (fence-aware), never to EOF past a later section. */
export function stripPlan(spec) {
  const lines = String(spec).split('\n')
  const h2 = headings(spec).filter((h) => h.level <= 2)
  const plan = h2.find((h) => h.level === 2 && h.title.trim() === 'Plan')
  if (!plan) return spec
  const next = h2.find((h) => h.i > plan.i)
  const head = lines.slice(0, plan.i)
  while (head.length && head.at(-1).trim() === '') head.pop()
  const tail = next ? lines.slice(next.i) : []
  return [...head, ...(tail.length ? ['', ...tail] : [])].join('\n').replace(/\n*$/, '\n')
}

const SIGNOFF_LINE = /^> (✅ SIGNED OFF|🤖 AGENT SIGNED OFF|🤖 AGENT-VERIFIED|✅ SHIPPED|✅ CLOSED|✖ DROPPED)/
const HOLD_LINE = /^> 🛑 PR HELD/

/** SPEC text with `lines` as the header line(s) right under the title, replacing any earlier sign-off / hold line. */
export function setHeader(spec, lines) {
  const all = String(spec).split('\n')
  const t = all.findIndex((l) => /^# /.test(l))
  if (t < 0) throw new Error('SPEC.md has no "# " title line')
  let j = t + 1
  const keep = []
  while (j < all.length && all[j].startsWith('>')) {
    if (!SIGNOFF_LINE.test(all[j]) && !HOLD_LINE.test(all[j])) keep.push(all[j])
    j++
  }
  return [...all.slice(0, t + 1), ...lines, ...keep, ...all.slice(j)].join('\n')
}

const unquote = (v) => String(v ?? '').replace(/^"(.*)"$/, '$1')

/** The newest round-N report with `verdict: PASS` → { n, sha } or null. */
function passingRound(ws, want) {
  const dir = join(ws, 'agent-walk')
  if (!existsSync(dir)) return null
  const rounds = readdirSync(dir)
    .map((d) => +(/^round-(\d+)$/.exec(d)?.[1] ?? NaN))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => b - a)
  for (const n of rounds) {
    if (want != null && n !== +want) continue
    const rep = read(join(dir, `round-${n}`, 'report.md'))
    if (!rep) continue
    const verdict = rep.trim().split('\n').reverse().find((l) => /^verdict:/.test(l.trim()))
    if (!/^verdict:\s*PASS\b/.test(verdict?.trim() ?? '')) continue
    return { n, sha: /^sha:\s*(\S+)/m.exec(rep)?.[1] ?? null }
  }
  return null
}

/** Write the SPEC header + §Plan cut and `git rm` PLAN.md/PARKED.md. → { out, add } */
function condenseFolder(f, headerLines) {
  const out = []
  const spec = read(f.specPath)
  if (spec == null) throw new Error(`no SPEC.md in ${f.dir}`)
  const next = setHeader(stripPlan(spec), headerLines)
  if (next !== spec) {
    writeAtomic(f.specPath, next)
    out.push(`SPEC: ${headings(spec).some((h) => h.level === 2 && h.title.trim() === 'Plan') ? '§Plan index stripped · ' : ''}header written`)
  } else out.push('SPEC: already condensed')
  const add = [f.specPath]
  for (const name of ['PLAN.md', 'PARKED.md']) {
    const p = join(f.dir, name)
    add.push(p)
    if (existsSync(p)) {
      git(f.root, ['rm', '-q', '-f', '--', posix(relative(f.root, p))])
      out.push(`${name}: removed`)
    } else if (name === 'PLAN.md') out.push('PLAN.md: already removed (or never written — a converted folder keeps its own docs)')
  }
  return { out, add }
}

function signoffAgent(f, a) {
  const ws = f.ws({ create: false })
  const prior = /^agent-pass\s+(\S+)\s+(\S+)/.exec(f.manifest.walk ?? '')
  let header, walk
  if (a['no-walk']) {
    const end = parseTestPlan(f.manifest).levers.end
    const sha = prior?.[2] ?? shortHead(f.root)
    const date = prior?.[1] ?? today()
    header = `> 🤖 AGENT SIGNED OFF — no walk (tests: end=${end}) — not human-tested · ${date} — ${sha}`
    walk = `agent-pass ${date} ${sha}`
  } else {
    const round = passingRound(ws, a.round)
    if (!round) throw new Error(`no passing agent walk round in ${join(ws, 'agent-walk')}${a.round ? ` (round ${a.round})` : ''} — AGENT-PASS needs a report ending \`verdict: PASS\``)
    const sha = prior?.[2] ?? a.sha ?? round.sha
    if (!sha) throw new Error(`round-${round.n}/report.md has no \`sha:\` line — pass --sha`)
    const date = prior?.[1] ?? today()
    header = `> 🤖 AGENT SIGNED OFF ${date} — ${sha} · agent walk round ${round.n} · not human-tested · evidence: .builder/${f.feature}/agent-walk/round-${round.n}/`
    walk = `agent-pass ${date} ${sha}`
  }
  const { out, add } = condenseFolder(f, [header])
  const r = advance(f, {
    sets: [['walk', walk], ['state', 'signed-off'], ['verify', 'none'], ['next', `/builder:verify --path ${f.rel}`], ...sets(a)],
    unsets: a.unset ?? [],
    head: true,
    ledger: a.ledger ?? [],
    add: [...add, ...(a.add ?? [])],
    commit: a.commit ?? 'docs({key}): {feature} agent signed off (not human-tested)',
    body: a.body,
    trailers: a.trailer ?? [],
    noCommit: !!a['no-commit'],
  })
  return [...out, ...r.lines]
}

function signoffHuman(f, a) {
  if (!a.name || !a.words) throw new Error('--signoff human needs --name and --words (the human\'s own, verbatim)')
  const sha = a.sha ?? shortHead(f.root)
  const date = a.date ?? today()
  const hold = a.hold ?? (isSet(f.manifest.hold) ? unquote(f.manifest.hold) : null)
  const lines = [`> ✅ SIGNED OFF ${date} — ${sha} · by ${a.name}: "${a.words}"`, ...(hold ? [`> 🛑 PR HELD (${date}): "${hold}"`] : [])]
  const { out, add } = condenseFolder(f, lines)
  const r = advance(f, {
    sets: sets(a),
    unsets: a.unset ?? [],
    head: !!a.head,
    ledger: a.ledger ?? [],
    add: [...add, ...(a.add ?? [])],
    commit: a.commit ?? 'docs({key}): condense {feature} at sign-off',
    body: a.body,
    trailers: a.trailer ?? [],
    noCommit: !!a['no-commit'],
  })
  return [...out, ...r.lines]
}

/** The feature even when an interrupted ship already moved it: { f, src, arch, moved }. */
function openForShip(folderArg) {
  const src = resolve(folderArg)
  const root = repoRoot(existsSync(src) ? src : dirname(src))
  const cfg = loadConfig(root)
  const registry = cfg.ok ? cfg.registry : 'docs/features'
  const feature = basename(src)
  const arch = join(root, registry, ARCHIVE, feature)
  if (existsSync(src)) {
    const f = openFeature(src)
    return { f, src, arch, moved: false, registry }
  }
  if (!existsSync(arch)) throw new Error(`no such feature folder: ${src}`)
  const f = { root, dir: src, rel: posix(relative(root, src)), feature, key: feature, cfg: cfg.ok ? cfg : null, manifest: {}, manifestPath: join(src, 'MANIFEST.md'), specPath: join(arch, 'SPEC.md'), ws: (o) => workspaceDir(root, feature, o) }
  return { f, src, arch, moved: true, registry }
}

export function ship(a) {
  const { f, src, arch, moved, registry } = openForShip(a._[0])
  const out = []
  const merged = a.merged ? String(a.merged) : null
  const subject = merged ? `docs({key}): {feature} shipped — merged ${merged}` : a.into ? 'docs({key}): {feature} shipped into ' + a.into : a.pr ? `docs({key}): {feature} shipped in PR #${String(a.pr).replace(/^#/, '')}` : null
  if (!subject) throw new Error('--ship needs --pr <N> (the open PR), --into <branch> (agent form) or --merged <sha> (already in the target)')
  if (a.commit) throw new Error('--ship writes its own subject (ship §At ship) — drop --commit')
  const progDirs = programParents(f.root, registry, f.feature)

  // An earlier run that died after `git rm MANIFEST.md` left a flipped header and no manifest: carry on.
  const resumed = !moved && !existsSync(f.manifestPath) && /^> ✅ SHIPPED/m.test(read(f.specPath) ?? '')
  if (!moved) {
    if (existsSync(arch)) throw new Error(`${posix(relative(f.root, arch))} already exists — a second folder of that name would make "has it shipped?" answer for the wrong feature. Nothing was touched.`)
    if (!resumed && !/^READY\b/.test(f.manifest.verify ?? '')) throw new Error(`verify is not READY (verify: ${f.manifest.verify ?? 'absent'}) — ship §At ship runs only on a READY feature`)
    if (!resumed && merged) {
      const target = a.into ?? f.cfg?.mergeInto ?? 'main'
      if (git(f.root, ['rev-parse', '--verify', '--quiet', `${merged}^{commit}`], { allowFail: true }) === null) throw new Error(`${merged} is not a commit here — pass the sha that brought the feature into ${target}`)
      if (git(f.root, ['merge-base', '--is-ancestor', merged, target], { allowFail: true }) === null) throw new Error(`${merged} is not in ${target} — --merged ships only a feature whose code is already in the target. Nothing was touched.`)
      if (git(f.root, ['merge-base', '--is-ancestor', merged, 'HEAD'], { allowFail: true }) === null) throw new Error(`${merged} is not in this branch — run it on ${target}. Nothing was touched.`)
    } else if (!resumed && a.into && git(f.root, ['merge-base', '--is-ancestor', a.into, 'HEAD'], { allowFail: true }) === null)
      throw new Error(`${a.into} is not merged into this branch — merge ${a.into} into this branch first (resume AGENT-MODE.md §Ship in agent mode)`)

    // 1. the header
    const spec = read(f.specPath)
    const lines = spec.split('\n')
    const t = lines.findIndex((l) => /^# /.test(l))
    let j = t + 1
    let sign = null
    while (j < lines.length && lines[j].startsWith('>')) {
      if (/^> (✅ SIGNED OFF|🤖 AGENT SIGNED OFF|✅ SHIPPED)/.test(lines[j])) sign ??= lines[j]
      j++
    }
    if (!sign) throw new Error('SPEC.md has no sign-off header line — the sign-off condense comes first')
    if (!sign.startsWith('> ✅ SHIPPED')) {
      const ticket = isSet(f.manifest.ticket) ? f.manifest.ticket : 'no ticket'
      // Who signed it carries over as it was: a human's name and words, or the agent's walk round. The
      // PR form is only ever a human's (an agent never opens a PR); the merge forms can be either.
      const human = /· by (.+?): "(.*)"\s*$/.exec(sign)
      const round = /agent walk round (\d+)/.exec(sign)?.[1]
      const by = sign.startsWith('> ✅ SIGNED OFF') && human ? `signed off by ${human[1]}: "${human[2]}"` : `🤖 agent signed off (${round ? `walk round ${round}` : 'no walk'}), not human-tested`
      if (!merged && !a.into && !human) throw new Error(`cannot read the signer and words from: ${sign}`)
      const where = merged ? `merged ${merged}` : a.into ? `merged into ${a.into}` : `PR #${String(a.pr).replace(/^#/, '')}`
      const shipped = `> ✅ SHIPPED ${today()} — ${where} · ${ticket} · ${by}`
      writeAtomic(f.specPath, setHeader(spec, [shipped]))
      out.push('SPEC: header flipped to SHIPPED')
    }
    // 2. the manifest
    if (existsSync(f.manifestPath)) {
      git(f.root, ['rm', '-q', '-f', '--', posix(relative(f.root, f.manifestPath))])
      out.push('MANIFEST.md: removed')
    }
  }
  // 3. the workspace
  const ws = f.ws({ create: false })
  if (existsSync(ws)) {
    rmSync(ws, { recursive: true, force: true })
    out.push(`workspace: removed ${ws}`)
  }
  // 4. a program parent
  const extra = []
  for (const dir of progDirs) {
    const mp = join(dir, 'MANIFEST.md')
    const text = read(mp)
    const next = text.replace(new RegExp(`^child:\\s*${f.feature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s.*)?$`, 'm'), `child: ${f.feature} — shipped`)
    if (next !== text) {
      writeAtomic(mp, next)
      out.push(`program ${basename(dir)}: child ${f.feature} — shipped`)
    }
    extra.push(mp)
    const kids = parseManifest(next).children ?? []
    const pp = join(dir, 'PROGRAM.md')
    // Every child ended — shipped, or closed / dropped by /builder:archive — ends the program.
    if (kids.length && kids.every((c) => /—\s*(shipped|closed|dropped)\b/.test(c)) && existsSync(pp)) {
      const prog = read(pp)
      const others = ['closed', 'dropped'].map((k) => [k, kids.filter((c) => new RegExp(`—\\s*${k}\\b`).test(c)).length]).filter(([, n]) => n)
      const tail = others.length ? `every child ended (${others.map(([k, n]) => `${n} ${k}`).join(', ')})` : 'every child shipped'
      const flipped = setHeader(prog, [`> ✅ SHIPPED ${today()} — ${tail} · last: ${f.feature}`])
      if (flipped !== prog) writeAtomic(pp, flipped)
      const parch = join(f.root, registry, ARCHIVE, basename(dir))
      if (!existsSync(parch)) {
        mkdirSync(dirname(parch), { recursive: true })
        git(f.root, ['add', '-A', '--', posix(relative(f.root, dir))])
        git(f.root, ['mv', posix(relative(f.root, dir)), posix(relative(f.root, parch))])
        out.push(`program ${basename(dir)}: ${tail} — PROGRAM.md flipped, archived`)
      }
      extra.push(dir, parch)
    }
  }
  // 5. archive
  if (!moved) {
    mkdirSync(dirname(arch), { recursive: true })
    git(f.root, ['add', '-A', '--', posix(relative(f.root, src))])
    git(f.root, ['mv', posix(relative(f.root, src)), posix(relative(f.root, arch))])
    out.push(`archived: ${posix(relative(f.root, arch))}`)
  }
  // the commit
  const paths = [src, arch, ...extra].map((p) => posix(relative(f.root, p)))
  const pending = git(f.root, ['status', '--porcelain', '--', ...paths.filter((p) => existsSync(join(f.root, p)) || git(f.root, ['cat-file', '-e', `HEAD:${p}`], { allowFail: true }) !== null)])
  const subj = subject.replaceAll('{key}', f.key).replaceAll('{feature}', f.feature)
  if (!pending) {
    out.push(`already shipped: ${shortHead(f.root)} ${git(f.root, ['log', '-1', '--format=%s'])}`)
    return out
  }
  if (a['no-commit']) return [...out, 'commit: skipped (--no-commit)']
  const r = advance({ ...f, manifestPath: arch }, { add: [src, arch, ...extra], commit: subj, body: a.body, trailers: a.trailer ?? [], ledger: [] })
  return [...out, ...r.lines]
}

/** Folders in the registry whose MANIFEST.md has a `child: <feature>` line. */
function programParents(root, registry, feature) {
  const base = join(root, registry)
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !/^[_.]/.test(e.name) && e.name !== feature)
    .map((e) => join(base, e.name))
    .filter((d) => new RegExp(`^child:\\s*${feature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'm').test(read(join(d, 'MANIFEST.md')) ?? ''))
}

const sets = (a) =>
  (a.set ?? []).map((s) => {
    const m = /^([a-z][a-z-]*)=(.*)$/s.exec(s)
    if (!m) throw new Error(`--set wants key=value (got: ${s})`)
    return [m[1], m[2]]
  })

async function main(argv) {
  const a = parseArgs(argv, { repeat: ['set', 'unset', 'ledger', 'add', 'trailer'], bool: ['head', 'no-commit', 'no-walk', 'ship'] })
  if (!a._[0] || (!a.signoff && !a.ship)) {
    console.error('usage: condense.mjs <folder> --signoff agent [--round N] [--no-walk] | --signoff human --name N --words W [--sha S] [--hold R] | --ship (--pr N | --into <branch> | --merged <sha> [--into <branch>])')
    return 2
  }
  sets(a)
  let lines
  if (a.ship) lines = ship(a)
  else if (a.signoff === 'agent') lines = signoffAgent(openFeature(a._[0]), a)
  else if (a.signoff === 'human') lines = signoffHuman(openFeature(a._[0]), a)
  else throw new Error(`--signoff is agent or human (got: ${a.signoff})`)
  for (const l of lines) console.log(l)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli(main)
