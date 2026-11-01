#!/usr/bin/env node
/**
 * docs — every doc section one step reads, printed in one call, instead of grepping REFERENCE's
 * headings and `sed`-ing line ranges in two or three calls per session.
 *
 *   node <builder>/scripts/docs.mjs <step> [--prompts] [--no-config] [--path <folder>]
 *   node <builder>/scripts/docs.mjs --list
 *   node <builder>/scripts/docs.mjs section <file> "<heading>"   (one section, printed as the bundles print it)
 *   node <builder>/scripts/docs.mjs config-key <key>   (one front-matter block of the repo's .claude/builder.md —
 *                                                       `verify`, `agent_walk` — which fleet-setup leaves out)
 *   node <builder>/scripts/docs.mjs fleet-config <step>   (the config cut to what that fleet step acts on, alone —
 *                                                       the second of a fleet session's two first reads; a step is
 *                                                       build|plan|resume|walk-lane|agent-walk|verify|ship)
 *
 * Each section is printed whole, under a `--- <file> §<heading> (lines a–b)` line. A whole file
 * (EXECUTION.md, CONVERSATION.md, PLAN-FORMAT.md) is printed whole. A section nested inside another
 * one the step also reads is printed once. The project config (`.claude/builder.md`, every step's
 * first read) comes last unless --no-config; --prompts adds build's four prompt templates. The fleet's
 * build steps print only the config the build acts on (`configForBuild`), and `--path <folder>` makes
 * fleet-build lever-aware: under `tests: … review=end` it leaves out EXECUTION §3 Review the task.
 *
 * The map is built from each skill's own "read / load REFERENCE §X" lines — STEPS below names the
 * line it came from. A section that no longer exists fails the call (exit 1, naming it), so a
 * renamed heading is caught by the test suite, not by a model paging for it.
 *
 * Read-only; safe to run any number of times.
 */
import { existsSync, realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILDER, read, headings, mdSection, normTitle, repoRoot, parseArgs, cli, posix } from './feature-core.mjs'
import { parseManifest } from './manifest.mjs'
import { parseTestPlan } from './profile.mjs'

const REF = 'skills/resume/REFERENCE.md'
const R = (...names) => names.map((n) => [REF, n])
const FILE = (p) => [p, null]
const CONFIG = ['<config>', null]
const CONFIG_BUILD = ['<config-build>', null]

/** step → [file, section|null (= the whole file)] — and the skill line each list comes from. */
export const STEPS = {
  // brainstorm SKILL: "the conversation reads only the four sections CONVERSATION.md names" — §Sizes and
  // §The classifier at sizing, §The review at §Confirm, §Walk readiness at the small path's look.
  brainstorm: [FILE('skills/brainstorm/CONVERSATION.md'), ...R('Sizes', 'The classifier', 'The review', 'Walk readiness'), CONFIG],
  // intake SKILL: CONVERSATION.md, the config, "the four sections CONVERSATION.md names", §Prototype mode for a design ref.
  intake: [FILE('skills/brainstorm/CONVERSATION.md'), ...R('Sizes', 'The classifier', 'The review', 'Walk readiness', 'Prototype mode'), CONFIG],
  // spec SKILL: "REFERENCE §SPEC.md, §MANIFEST.md and §PROGRAM.md hold every shape this step produces",
  // §Prototype mode step 5, §The review (the design approval), §The two-way footer.
  spec: [...R('SPEC.md', 'MANIFEST.md', 'PROGRAM.md', 'Prototype mode', 'The review', 'The two-way footer'), CONFIG],
  // brainstorm SKILL §Spec under --auto: spec's own steps, in the same turn, with no Skill handoff.
  'spec-auto': [FILE('skills/spec/SKILL.md'), ...R('SPEC.md', 'MANIFEST.md', 'PROGRAM.md', 'The two-way footer'), CONFIG],
  // align SKILL: §Prototype mode's "Then align …", §SPEC.md, §Contract and the contract freeze, §Continuing on "go".
  align: [...R('Prototype mode', 'SPEC.md', 'Contract and the contract freeze', 'Continuing on "go"'), CONFIG],
  // audit SKILL: §SPEC.md, §Apps, §Contract and the contract freeze, §MANIFEST.md, §Prototype mode,
  // §Agent model tiering; SURFACE-CHECK.md for surfaces; §The review's delta form, the footer.
  audit: [...R('SPEC.md', 'MANIFEST.md', 'Prototype mode', 'Agent model tiering', 'The review', 'The two-way footer', 'Continuing on "go"'), FILE('skills/resume/SURFACE-CHECK.md'), CONFIG],
  // plan SKILL: PLAN-FORMAT.md · REFERENCE (§Sizes · §Contract and the contract freeze · §MANIFEST.md · §Branch and ticket),
  // §The review (the go-ahead's recap), §Flags (--here), §Continuing on "go".
  plan: [FILE('skills/plan/PLAN-FORMAT.md'), ...R('Sizes', 'Contract and the contract freeze', 'MANIFEST.md', 'Branch and ticket', 'The review', 'Flags', 'Continuing on "go"'), CONFIG],
  // plan SKILL under --agent-walk: the same less §The review (no recap is printed), §Flags and §Continuing on "go"
  // (nobody answers), and no config — `fleet-config plan` prints it in its own call. Each ≤ 30,000 chars (one Bash
  // output), where `plan` is over it.
  'plan-agent': [FILE('skills/plan/PLAN-FORMAT.md'), ...R('Sizes', 'Contract and the contract freeze', 'MANIFEST.md', 'Branch and ticket')],
  // build SKILL: EXECUTION.md first, then REFERENCE (§Contract and the contract freeze · §PLAN.md · §SPEC.md ·
  // §MANIFEST.md · §Branch and ticket), and §The verifier, §Walk readiness, §The craft skills where it cites them.
  build: [FILE('skills/build/EXECUTION.md'), ...R('Contract and the contract freeze', 'PLAN.md', 'SPEC.md', 'MANIFEST.md', 'Branch and ticket', 'The verifier', 'Walk readiness', 'The craft skills'), CONFIG],
  // fleet-build: build SKILL "Under the fleet (`BUILDER_FLEET_DIR` is set): read … fleet-build instead" — EXECUTION §The task loop (its
  // five steps; §3 only when the plan reviews — OMIT below), REFERENCE §Contract and the contract freeze · §PLAN.md ·
  // §The verifier, AGENT-MODE §Agent mode in the build lane (the rest of AGENT-MODE is resume-agent's).
  // Left out (≤ 30,000 chars) for `docs.mjs section`: EXECUTION §Setup, §Model selection, §The final whole-branch
  // review, §Finish, §Common rationalizations; REFERENCE §SPEC.md, §MANIFEST.md, §Walk readiness.
  // The fleet's first read is two Bash calls, each ≤ 30,000 chars (one Bash output): `fleet-build --no-config`,
  // then `fleet-setup` — EXECUTION §Setup and the config the build acts on, printed there once.
  'fleet-build': [['skills/build/EXECUTION.md', 'The task loop'], ...R('Contract and the contract freeze', 'PLAN.md', 'The verifier'), ['skills/resume/AGENT-MODE.md', 'Agent mode in the build lane'], CONFIG_BUILD],
  'fleet-setup': [['skills/build/EXECUTION.md', 'Setup'], CONFIG_BUILD],
  // resume SKILL, `state: building` + `ready: pending` (the fleet's walk lane): "run REFERENCE §Walk readiness,
  // then the build's walk script and `state: built`" — build SKILL §When the last phase signs.
  'walk-lane': [...R('Walk readiness'), ['skills/build/SKILL.md', 'When the last phase signs'], CONFIG],
  // agent-walk SKILL: "Condense exactly as builder:ship §At sign-off does", REFERENCE §How a park reads,
  // §The park record, §Agent model tiering, and §Walk readiness (a batched walk runs it once for the batch).
  'agent-walk': [['skills/ship/SKILL.md', 'At sign-off'], ...R('Condense', 'How a park reads', 'The park record', 'Agent model tiering', 'Walk readiness'), CONFIG],
  // verify SKILL: REFERENCE §The verifier, §The two-way footer, §Continuing on "go".
  verify: [...R('The verifier', 'The two-way footer', 'Continuing on "go"'), CONFIG],
  // signoff SKILL: REFERENCE §Condense's sign-off row, §Walk readiness (step 1b), §The two-way footer.
  signoff: [['skills/ship/SKILL.md', 'At sign-off'], ...R('Condense', 'Walk readiness', 'The two-way footer', 'Continuing on "go"'), CONFIG],
  // ship SKILL: "REFERENCE §Condense says what each writes".
  ship: [...R('Condense', 'Continuing on "go"'), CONFIG],
  // archive SKILL: §Condense (what SHIPPED, CLOSED and DROPPED mean), §Before a picker (its one confirmation).
  archive: [...R('Condense', 'Before a picker'), CONFIG],
  // revise SKILL: §Contract and the contract freeze (the one way a frozen contract re-opens), §SPEC.md.
  revise: [...R('Contract and the contract freeze', 'SPEC.md', 'The review', 'Continuing on "go"'), CONFIG],
  // resume SKILL: §Flags, §MANIFEST.md, §Condense (state detection), §The two-way footer, §Continuing on "go".
  resume: [...R('Flags', 'MANIFEST.md', 'Condense', 'The two-way footer', 'Continuing on "go"'), CONFIG],
  // resume SKILL: under --agent-walk, §Flags, §MANIFEST.md and AGENT-MODE.md — one Bash output (≤ 30,000 chars); the
  // config is `fleet-config resume`, its own call. Left
  // out for `docs.mjs section`: §The two-way footer and §Continuing on "go" (no human reads an unattended footer, and
  // nobody says go), §Condense (a fleet feature always has a MANIFEST; agent-walk and ship print it where they condense).
  'resume-agent': [...R('Flags', 'MANIFEST.md'), FILE('skills/resume/AGENT-MODE.md')],
}

/** step → the sections to cut out of it for a feature's test plan (`--path`): [file, section, why]. */
const OMIT = {
  // EXECUTION §3 is the task review (review=slice) and the phase review (review=app); review=end runs neither.
  'fleet-build': (levers) => (levers.review === 'end' ? [['skills/build/EXECUTION.md', '3. Review the task', 'review=end: no task or phase review']] : []),
}

/**
 * What each fleet step acts on in the config: the front-matter blocks it drops (the verifier and the fleet
 * read `verify:` and `agent_walk:` themselves) and the `## ` sections it keeps. `docs.mjs fleet-config <step>`.
 *   build  — the task loop: §House rules, §Environment landmines, §Standing traps (fleet-setup prints it).
 *   plan   — writing PLAN.md: §Verification (the phase tier per app), §Global constraints (the plan header),
 *            §House rules (the phase skeleton), §Companion skills (Recipe: lines), §Standing traps.
 *   resume — routing, the walk lane and the park: `agent_walk:` kept; §Walk readiness, §Environment landmines,
 *            §Standing traps. The steps it runs (audit, verify, ship…) print their own config.
 *   walk-lane  — REFERENCE §Walk readiness (`agent_walk.start`/`smoke`/`env`, migrations against `base_branch`) and
 *                build §When the last phase signs (walk.md's facts): `agent_walk:` kept; §Walk readiness (and its
 *                notes), §Environment landmines, §Standing traps.
 *   agent-walk — the `agent_walk:` precondition, driver, batch and smoke; §Walk readiness for a batch; §Environment
 *                landmines verbatim into the walker's prompt; `registry`/`apps` for the condense; §Standing traps.
 *   verify     — every front-matter block (`verify:`, `apps:` with `released_artifact`/`commit:`, `registry`);
 *                §Verification, §Global constraints, §House rules, §Environment landmines, §Quality gates, and
 *                §Walk readiness (item 4's clean-database re-apply needs its migrations path and commands).
 *   ship       — `registry`, `merge_into`, `base_branch`, `apps` for REFERENCE §Condense; §Standing traps and §House
 *                rules (the lesson), §Companion skills (the ticket command).
 */
export const FLEET_CONFIG = {
  build: { drop: /^(verify|agent_walk):/, sections: ['House rules', 'Environment landmines', 'Standing traps'] },
  plan: { drop: /^(verify|agent_walk):/, sections: ['Verification', 'Global constraints', 'House rules', 'Companion skills', 'Standing traps'] },
  resume: { drop: /^verify:/, sections: ['Walk readiness', 'Environment landmines', 'Standing traps'] },
  'walk-lane': { drop: /^verify:/, sections: ['Walk readiness', 'Walk readiness notes', 'Environment landmines', 'Standing traps'] },
  'agent-walk': { drop: /^verify:/, sections: ['Walk readiness', 'Walk readiness notes', 'Environment landmines', 'Standing traps'] },
  verify: { drop: null, sections: ['Verification', 'Global constraints', 'House rules', 'Environment landmines', 'Quality gates', 'Walk readiness'] },
  ship: { drop: /^(verify|agent_walk):/, sections: ['Standing traps', 'House rules', 'Companion skills'] },
}

/** The config cut to what one fleet step acts on: the front matter less its dropped blocks and comments, then the kept sections. */
export function configFor(step, text) {
  const { drop, sections } = FLEET_CONFIG[step]
  const lines = String(text).split('\n')
  const close = lines[0] === '---' ? lines.indexOf('---', 1) : -1
  const fm = []
  let dropping = false
  for (const line of close > 0 ? lines.slice(0, close + 1) : []) {
    if (/^[A-Za-z_][\w-]*:/.test(line) || line === '---') dropping = !!drop?.test(line)
    if (dropping || /^\s*#/.test(line) || !line.trim()) continue
    fm.push(line)
  }
  const body = close > 0 ? lines.slice(close + 1).join('\n') : String(text)
  const secs = sections.map((n) => mdSection(body, n, { level: 2 })?.text).filter((t, i, all) => t && all.indexOf(t) === i)
  return [fm.join('\n'), ...secs].filter(Boolean).join('\n\n')
}

/**
 * The config cut to what the build loop acts on: the frontmatter without its `verify:` and `agent_walk:`
 * blocks (the verifier and the fleet read those) or its comments, then §House rules, §Environment
 * landmines and §Standing traps when present. §Global constraints, §Quality gates and §Walk readiness are
 * left to the briefs, the verifier and the walk lane that use them.
 */
export const configForBuild = (text) => configFor('build', text)

/** One top-level front-matter block (`<key>:` and its indented lines) of a config's text, or null. */
export function configKey(text, key) {
  const lines = String(text).split('\n')
  const close = lines[0] === '---' ? lines.indexOf('---', 1) : -1
  const fm = lines.slice(1, close > 0 ? close : 0)
  const at = fm.findIndex((l) => l.startsWith(`${key}:`))
  if (at < 0) return null
  let end = at + 1
  while (end < fm.length && !/^[A-Za-z_][\w-]*:/.test(fm[end])) end++
  return fm.slice(at, end).join('\n').replace(/\s+$/, '')
}

const PROMPT_FILES = ['implementer.md', 'task-reviewer.md', 're-review.md', 'final-reviewer.md'].map((f) => FILE(`skills/build/prompts/${f}`))

/**
 * Resolve a step's list → { sections: [{ label, text }], missing: [label] }. Sections are de-duplicated:
 * one that sits inside another selected section of the same file is dropped.
 */
export function bundle(step, { config = true, prompts = false, root = process.cwd(), path = null } = {}) {
  const list = [...STEPS[step]]
  if (prompts) list.splice(list.findIndex((x) => x === CONFIG || x === CONFIG_BUILD), 0, ...PROMPT_FILES)
  const manifest = path && OMIT[step] ? read(join(resolve(root, path), 'MANIFEST.md')) : null
  const omit = manifest ? OMIT[step](parseTestPlan(parseManifest(manifest)).levers) : []
  const found = []
  const missing = []
  for (const [file, name] of list) {
    if (file === '<config>' || file === '<config-build>') {
      if (!config) continue
      const p = join(root, '.claude', 'builder.md')
      const text = read(p)
      const build = file === '<config-build>'
      found.push(text ? { file: p, label: `.claude/builder.md (the project config${build ? ' — the part the build acts on' : ''})`, text: (build ? configForBuild(text) : text).replace(/\s+$/, ''), whole: true } : { file: p, label: '.claude/builder.md', text: '(no .claude/builder.md here — /builder:init writes it)', whole: true })
      continue
    }
    const abs = join(BUILDER, file)
    const text = read(abs)
    if (text == null) {
      missing.push(file)
      continue
    }
    if (name == null) {
      found.push({ file: abs, label: file, text: text.replace(/\s+$/, ''), whole: true })
      continue
    }
    const s = mdSection(text, name)
    if (!s) {
      missing.push(`${file} §${name}`)
      continue
    }
    let body = s.text
    const cut = []
    for (const [f, n, why] of omit) {
      const o = f === file ? mdSection(text, n) : null
      if (!o || o.start <= s.start || o.end > s.end) continue
      body = body.replace(`${text.split('\n').slice(o.start, o.end).join('\n')}`, '')
      cut.push(`§${normTitle(o.title)} (${why})`)
    }
    found.push({ file: abs, label: `${file} §${normTitle(s.title)} (lines ${s.start + 1}–${s.end})${cut.length ? ` — without ${cut.join(', ')}` : ''}`, text: body, start: s.start, end: s.end })
  }
  const inside = (a, b) => a !== b && a.file === b.file && !b.whole && !a.whole && a.start >= b.start && a.end <= b.end
  const sections = found
    .filter((a) => !found.some((b) => inside(a, b)))
    .map((b) => {
      const kids = found.filter((a) => inside(a, b)).map((a) => `§${normTitle(mdSection(read(a.file), a.label.replace(/^.*§| \(lines.*$/g, '')).title)}`)
      return kids.length ? { ...b, label: `${b.label} — includes ${kids.join(', ')}` } : b
    })
  return { sections, missing }
}

const describe = (step) =>
  STEPS[step].map(([file, name]) => (file === '<config>' ? '.claude/builder.md' : name ? `${file.replace('skills/resume/', '')} §${name}` : file)).join(' · ')

async function main(argv) {
  const a = parseArgs(argv, { bool: ['prompts', 'no-config', 'list'] })
  if (a.list) {
    for (const step of Object.keys(STEPS)) console.log(`${step.padEnd(11)} ${describe(step)}`)
    return 0
  }
  if (a._[0] === 'section') {
    const [, file, name] = a._
    if (!file || !name) {
      console.error('usage: docs.mjs section <file> "<heading>"')
      return 2
    }
    const abs = join(BUILDER, file)
    const s = mdSection(read(abs) ?? '', name)
    if (!s) {
      console.error(`builder: docs section: not found in ${BUILDER}: ${file} §${name}`)
      return 1
    }
    process.stdout.write([`--- ${file} §${normTitle(s.title)} (lines ${s.start + 1}–${s.end})`, '', s.text, ''].join('\n'))
    return 0
  }
  if (a._[0] === 'fleet-config') {
    const step = a._[1]
    if (!FLEET_CONFIG[step]) {
      console.error(`usage: docs.mjs fleet-config <${Object.keys(FLEET_CONFIG).join('|')}>`)
      return 2
    }
    const text = read(join(repoRoot(process.cwd()), '.claude', 'builder.md'))
    const out = text ? configFor(step, text) : '(no .claude/builder.md here — /builder:init writes it)'
    process.stdout.write([`--- .claude/builder.md (the project config — the part ${step} acts on)`, '', out, ''].join('\n'))
    return 0
  }
  if (a._[0] === 'config-key') {
    const key = a._[1]
    if (!key) {
      console.error('usage: docs.mjs config-key <key>')
      return 2
    }
    const block = configKey(read(join(repoRoot(process.cwd()), '.claude', 'builder.md')) ?? '', key)
    if (!block) {
      console.error(`builder: docs config-key: no ${key}: block in .claude/builder.md's front matter`)
      return 1
    }
    process.stdout.write([`--- .claude/builder.md ${key}:`, '', block, ''].join('\n'))
    return 0
  }
  const step = a._[0]
  if (!step || !STEPS[step]) {
    console.error(`usage: docs.mjs <${Object.keys(STEPS).join('|')}> [--prompts] [--no-config] [--path <folder>] · docs.mjs --list`)
    return 2
  }
  const b = bundle(step, { config: !a['no-config'], prompts: !!a.prompts, root: repoRoot(process.cwd()), path: a.path ?? null })
  if (b.missing.length) {
    console.error(`builder: docs ${step}: not found in ${BUILDER}: ${b.missing.join(' · ')}`)
    return 1
  }
  const kb = Math.round(b.sections.reduce((n, s) => n + Buffer.byteLength(s.text), 0) / 1024)
  const out = [`# builder docs: ${step} — ${b.sections.length} sections, ${kb} KB (from ${BUILDER})`, '']
  for (const s of b.sections) out.push(`--- ${s.label}`, '', s.text, '')
  process.stdout.write(out.join('\n'))
  return 0
}

if ((() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()) cli(main)
