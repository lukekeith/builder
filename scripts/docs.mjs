#!/usr/bin/env node
/**
 * docs — every doc section one step reads, printed in one call, instead of grepping REFERENCE's
 * headings and `sed`-ing line ranges in two or three calls per session.
 *
 *   node <builder>/scripts/docs.mjs <step> [--prompts] [--no-config]
 *   node <builder>/scripts/docs.mjs --list
 *
 * Each section is printed whole, under a `--- <file> §<heading> (lines a–b)` line. A whole file
 * (EXECUTION.md, CONVERSATION.md, PLAN-FORMAT.md) is printed whole. A section nested inside another
 * one the step also reads is printed once. The project config (`.claude/builder.md`, every step's
 * first read) comes last unless --no-config; --prompts adds build's four prompt templates.
 *
 * The map is built from each skill's own "read / load REFERENCE §X" lines — STEPS below names the
 * line it came from. A section that no longer exists fails the call (exit 1, naming it), so a
 * renamed heading is caught by the test suite, not by a model paging for it.
 *
 * Read-only; safe to run any number of times.
 */
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BUILDER, read, headings, mdSection, normTitle, repoRoot, parseArgs, cli, posix } from './feature-core.mjs'

const REF = 'skills/resume/REFERENCE.md'
const R = (...names) => names.map((n) => [REF, n])
const FILE = (p) => [p, null]
const CONFIG = ['<config>', null]

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
  // build SKILL: EXECUTION.md first, then REFERENCE (§Contract and the contract freeze · §PLAN.md · §SPEC.md ·
  // §MANIFEST.md · §Branch and ticket), and §Quality gates, §Walk readiness, §The craft skills where it cites them.
  build: [FILE('skills/build/EXECUTION.md'), ...R('Contract and the contract freeze', 'PLAN.md', 'SPEC.md', 'MANIFEST.md', 'Branch and ticket', 'Quality gates — the mechanism', 'Walk readiness', 'The craft skills'), CONFIG],
  // resume SKILL, `state: building` + `ready: pending` (the fleet's walk lane): "run REFERENCE §Walk readiness,
  // then the build's walk script and `state: built`" — build SKILL §When the last phase signs.
  'walk-lane': [...R('Walk readiness'), ['skills/build/SKILL.md', 'When the last phase signs'], CONFIG],
  // agent-walk SKILL: "Condense exactly as builder:ship §At sign-off does", REFERENCE §How a park reads,
  // §The park record, §Agent model tiering.
  'agent-walk': [['skills/ship/SKILL.md', 'At sign-off'], ...R('Condense', 'How a park reads', 'The park record', 'Agent model tiering'), CONFIG],
  // verify SKILL: REFERENCE §Quality gates (— the mechanism), §The two-way footer, §Continuing on "go".
  verify: [...R('Quality gates — the mechanism', 'The two-way footer', 'Continuing on "go"'), CONFIG],
  // signoff SKILL: REFERENCE §Condense's sign-off row, §Walk readiness (step 1b), §The two-way footer.
  signoff: [['skills/ship/SKILL.md', 'At sign-off'], ...R('Condense', 'Walk readiness', 'The two-way footer', 'Continuing on "go"'), CONFIG],
  // ship SKILL: "REFERENCE §Condense says what each writes".
  ship: [...R('Condense', 'Continuing on "go"'), CONFIG],
  // revise SKILL: §Contract and the contract freeze (the one way a frozen contract re-opens), §SPEC.md.
  revise: [...R('Contract and the contract freeze', 'SPEC.md', 'The review', 'Continuing on "go"'), CONFIG],
  // resume SKILL: §Flags, §MANIFEST.md, §Condense (state detection), §The two-way footer, §Continuing on "go".
  resume: [...R('Flags', 'MANIFEST.md', 'Condense', 'The two-way footer', 'Continuing on "go"'), CONFIG],
  // resume SKILL §`--agent-walk`: under --agent-walk, the same plus AGENT-MODE.md.
  'resume-agent': [...R('Flags', 'MANIFEST.md', 'Condense', 'The two-way footer', 'Continuing on "go"'), FILE('skills/resume/AGENT-MODE.md'), CONFIG],
}

const PROMPT_FILES = ['implementer.md', 'task-reviewer.md', 're-review.md', 'final-reviewer.md'].map((f) => FILE(`skills/build/prompts/${f}`))

/**
 * Resolve a step's list → { sections: [{ label, text }], missing: [label] }. Sections are de-duplicated:
 * one that sits inside another selected section of the same file is dropped.
 */
export function bundle(step, { config = true, prompts = false, root = process.cwd() } = {}) {
  const list = [...STEPS[step]]
  if (prompts) list.splice(list.findIndex((x) => x === CONFIG), 0, ...PROMPT_FILES)
  const found = []
  const missing = []
  for (const [file, name] of list) {
    if (file === '<config>') {
      if (!config) continue
      const p = join(root, '.claude', 'builder.md')
      const text = read(p)
      found.push(text ? { file: p, label: '.claude/builder.md (the project config)', text: text.replace(/\s+$/, ''), whole: true } : { file: p, label: '.claude/builder.md', text: '(no .claude/builder.md here — /builder:init writes it)', whole: true })
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
    found.push({ file: abs, label: `${file} §${normTitle(s.title)} (lines ${s.start + 1}–${s.end})`, text: s.text, start: s.start, end: s.end })
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
  const step = a._[0]
  if (!step || !STEPS[step]) {
    console.error(`usage: docs.mjs <${Object.keys(STEPS).join('|')}> [--prompts] [--no-config] · docs.mjs --list`)
    return 2
  }
  const b = bundle(step, { config: !a['no-config'], prompts: !!a.prompts, root: repoRoot(process.cwd()) })
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli(main)
