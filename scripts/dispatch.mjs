#!/usr/bin/env node
/**
 * dispatch — render a subagent's whole prompt into the workspace, so the Agent call's prompt is one
 * line ("Read <file> and do what it says") plus, at most, one paragraph only the controller knows.
 *
 *   node <builder>/scripts/dispatch.mjs <kind> <folder> [--task N] [--round N] [--context "<one paragraph>"]
 *        [--findings "<verbatim>" | --findings-file <path>] [--base <sha>] [--head <sha>] [--phase N] [--final]
 *        [--model haiku|sonnet|opus]   override the printed default (an implementer's is recorded; rounds 4–5 escalate from it)
 *
 * kinds and what each fills (skills/build/prompts/*.md, build SKILL §Composing the brief and
 * §Dispatch, review, fix, EXECUTION.md §1–5, agent-walk SKILL §2):
 *
 *   implementer --task N   writes <WS>/task-N-brief.md — the task block exactly as scripts/task-brief
 *                          cuts it, then the SPEC sections it implements (its app's section, §Testing,
 *                          §Decisions, §Schema & API changes for a schema task, the §Findings rows
 *                          marked `build-time risk` that name it), §Contract verbatim with whether it is
 *                          frozen, the Recipe: line resolved to a path, the config's §Global
 *                          constraints verbatim with <TICKET> replaced (the craft skills are the
 *                          prompt's, with when to read each) — then
 *                          renders prompts/implementer.md: the task name, the app, the commit
 *                          instruction from the app's `commit:` mode (with the plan's commit subject),
 *                          the working directory, the report path, and a Context line (task i of n,
 *                          its phase and goal, your
 *                          --context). Records the task's BASE (HEAD now) the first time.
 *      --round R           a fix round (fresh at rounds 4–5; rounds 1–3 send the resumed implementer
 *                          the same file): the findings verbatim, receiving-code-review first, and from
 *                          round 3 systematic-debugging; from round 4 the "you own it now" framing.
 *   implementer --final    the final review's ONE fix wave: <WS>/final-fix-brief.md (the findings — by
 *                          default from <WS>/final-review.md —, §Contract, the
 *                          constraints) and the implementer template across the in-scope apps.
 *   task-review --task N   generates the review package BASE..HEAD (the recorded BASE, never HEAD~1)
 *                          and renders prompts/task-reviewer.md with §Contract verbatim and its status.
 *      --phase N           review=app: one review of the phase's whole diff, every brief and report.
 *   re-review --task N --round R   the scoped re-review: FIX_BASE = the head the previous review saw
 *                          (recorded when it was rendered), the fix diff, the findings verbatim.
 *      --final             the one scoped re-review of the final review's fix wave.
 *   final-review           review-package <merge-base with the target> HEAD → review-final.diff;
 *                          the ledger's deferred-minor and parked lines; the SPEC path; the
 *                          description from SPEC §Idea's Why and the manifest's apps.
 *   walk-batch <folder>…   one walker for a fleet walk batch (agent-walk §Batched walks): every
 *                          feature's walk.md, scope and report, walked together by screen.
 *   agent-walk             the walker's brief exactly as agent-walk §2 lists it: walk.md, the driver
 *                          verbatim (or the no-driver rule), §Environment landmines, the round's output
 *                          directory and report contract, the scope `end` sets; from round 3, the items
 *                          that failed last round, with systematic-debugging.
 *
 *   next <folder> --after-implement N   the step after task N's implementer reported DONE: under a
 *                          test plan that reviews tasks (review=slice…), task N's review exactly as
 *                          `task-review --task N` (under `slice+second`, on a task whose block names
 *                          §Contract or §Schema, a `second review:` line first); otherwise the close below with the line
 *                          `Task N: complete (commits <base7>..<head7>, no task review (tests: review=<v>))`.
 *   next <folder> --close N --ledger "<line>"   EXECUTION §5 in one call: the ledger line (advance.mjs
 *                          --ledger), the commit-tier request (`verify.mjs request <worktree> HEAD --tier
 *                          commit`), `verify.mjs verdict <branch>` printed verbatim, then the
 *                          implementer render of the next task N's ## Phases row lists that has no
 *                          `Task M: complete` ledger line (with
 *                          --context) — or, when N is its phase's last, `phase <P> closes — build
 *                          §Phase close` and no render. A red verdict (exit 1) renders nothing and
 *                          names the implementer command to run once it is acted on (at a phase's
 *                          end: the red line, then the phase-close line); exits 3, 4, 5, 6 and 75
 *                          render as usual; any other exit is an error. Each part is skipped,
 *                          printing `already applied`, when done before (a `Task N: complete` ledger
 *                          line; a commit-tier request for HEAD's sha), so a re-run after a crash
 *                          finishes only what is missing; a re-run with a different ledger line
 *                          keeps the first one. A --ledger line not starting `Task N: complete` is
 *                          refused (exit 2). A pause request ($BUILDER_FLEET_DIR/requests/<feature>.pause)
 *                          renders nothing and prints `paused — <its first line>`. Judgement stays the orchestrator's: whether
 *                          findings need a fix round, whether a verdict's regression needs a fix dispatch.
 *                          BUILDER_VERIFY_BIN overrides the verify client (tests stub it).
 *
 * Findings travel as files. Every review kind tells its reviewer to write its report to a workspace
 * file — <WS>/task-N-review.md, review-phase-N.md, task-N-re-review-R.md, final-review.md,
 * final-re-review.md — and prints it as `findings: <path>`. The next fix round and re-review take
 * `--findings-file <that path>`: the report is embedded verbatim with one line scoping it to its open
 * findings (Critical, Important, ❌ — or NOT ADDRESSED and new breakage); `--findings "<text>"`
 * alongside adds the controller's own (a ⚠️ item it confirmed).
 *
 * Prints one line per fact, every path relative to the repo root: the file it wrote, the findings
 * file, and the Agent call on one line — subagent_type, the model tier (modelFor: EXECUTION §Model
 * selection as a table, the fix-loop escalation included), description and prompt.
 *
 * What stays with the orchestrator (judgment): a model above the one printed when a task needs it
 * (EXECUTION §Model selection — an escalation, never a routine dispatch); interfaces and rulings from earlier tasks, and an Environment landmine that applies
 * (--context); a ⚠️ item it confirmed (--findings); whether a finding enters the loop (a plan-mandated
 * ruling, a finding it overrules — say so in --context);
 * batching small same-shape tasks into one dispatch.
 *
 * Safe to re-run: the same arguments render the same file, and the recorded BASE and reviewed heads
 * (`<WS>/dispatch-state.json`) are written once and reused — a re-render after a crash, or after
 * later commits, describes the same range.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BUILDER, openFeature, read, writeAtomic, git, mdSection, configSection, tableRows, parseArgs, cli } from './feature-core.mjs'
import { slices } from './plan-slices.mjs'
import { parseTestPlan } from './profile.mjs'
import { isSet } from './manifest.mjs'
import { advance } from './advance.mjs'
import { openLedger } from './verify/ledger.mjs'
import { mainRoot } from './verify/git.mjs'

const PROMPTS = join(BUILDER, 'skills', 'build', 'prompts')
const CRAFT = {
  TDD_PATH: 'test-driven-development',
  DEBUGGING_PATH: 'systematic-debugging',
  REVIEW_PATH: 'receiving-code-review',
  VERIFICATION_PATH: 'verification-before-completion',
}
const skillPath = (name) => join(BUILDER, 'skills', name, 'SKILL.md')
const KINDS = ['implementer', 'task-review', 're-review', 'final-review', 'agent-walk']

const TIERS = ['haiku', 'sonnet', 'opus']
const tierUp = (m) => TIERS[Math.min(TIERS.indexOf(m) + 1, TIERS.length - 1)]

/**
 * EXECUTION §Model selection as a table — the tier the Agent call names, so a routine dispatch never
 * reads that section. `tiny` is the plan's `Recipe: … · tiny` (a mechanical one-file edit); `models`
 * the test plan's lever. Implementers: the standard tier, the cheapest when tiny or under `economy`,
 * the most capable under `strong`; rounds 1–3 resume the same agent, rounds 4–5 go one tier up. There
 * is no floor here: the orchestrator raises with `--model` (build §Dispatch's raise rule — never lower). Reviews: the standard tier, the cheapest for
 * a tiny task's diff, the most capable under `strong`. The final review and the walker: the most capable.
 */
export function modelFor({ kind, tiny = false, round = 0, models = 'default' }) {
  const strong = models === 'strong'
  switch (kind) {
    case 'implementer': {
      const base = tiny || models === 'economy' ? 'haiku' : strong ? 'opus' : 'sonnet'
      return round >= 4 ? tierUp(base) : base
    }
    case 'final-fix':
      return strong ? 'opus' : 'sonnet'
    case 'task-review':
      return strong ? 'opus' : tiny ? 'haiku' : 'sonnet'
    case 'phase-review':
    case 're-review':
      return strong ? 'opus' : 'sonnet'
    case 'final-review':
    case 'agent-walk':
    case 'walk-batch':
      return 'opus'
    default:
      throw new Error(`no model tier for kind ${kind}`)
  }
}
const modelsLever = (f) => parseTestPlan(f.manifest).levers.models ?? 'default'
/** Why the default is what it is — printed beside the model, so the orchestrator sees what to weigh before raising it. */
const defaultWhy = ({ tiny = false, models = 'default' } = {}) => ['default', tiny && 'tiny', models !== 'default' && `models=${models}`].filter(Boolean).join(' — ')
/** `--model <m>` — the orchestrator's override of the printed default; a tier name or refused. */
const overrideOf = (a) => {
  if (a.model == null) return null
  if (!TIERS.includes(a.model)) throw new Error(`--model must be one of ${TIERS.join(', ')} (got ${a.model})`)
  return a.model
}
/** `--model` only raises: a tier below the one this dispatch would name is refused (build §Dispatch — never lower it). */
const raiseOnly = (override, model, kind) => {
  if (override && TIERS.indexOf(override) < TIERS.indexOf(model)) throw new Error(`--model only raises: ${kind} runs on ${model} at least (got ${override})`)
  return override
}

/** A prompts/*.md template → { description, body } — the `prompt: |` block, de-indented. */
export function promptOf(md) {
  const fence = /```\n([\s\S]*?)\n```/.exec(md)
  if (!fence) throw new Error('template has no fenced Subagent block')
  const lines = fence[1].split('\n')
  const description = /description:\s*"(.*)"/.exec(fence[1])?.[1] ?? null
  const at = lines.findIndex((l) => /^\s*prompt:\s*\|\s*$/.test(l))
  if (at < 0) throw new Error('template has no `prompt: |` line')
  const body = lines.slice(at + 1)
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length))
  return { description, body: body.map((l) => l.slice(indent)).join('\n').replace(/\s+$/, '') + '\n' }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Replace the named placeholders — `[NAME]` or `[NAME — a note that may wrap lines]` — and nothing
 * else: the reviewer templates carry bracketed output forms (`[Approved | Needs fixes]`) that stay.
 * A name whose value is missing throws, so a template that grows a placeholder is caught, not shipped.
 */
export function fill(body, values) {
  let out = body
  const names = [...new Set([...body.matchAll(/\[([A-Z][A-Z_]{2,})(?:\s—[^\]]*)?\]/g)].map((m) => m[1]))]
  for (const name of names) {
    if (values[name] == null) throw new Error(`template placeholder [${name}] has no value — the template changed; teach dispatch.mjs what fills it`)
    out = out.replace(new RegExp(`\\[${esc(name)}(?:\\s—[^\\]]*)?\\]`, 'g'), () => values[name])
  }
  return out
}

/** One task's text — from its heading to the next `Task <n>` heading at any level outside a ``` fence, or EOF. task-brief's rule. */
export function taskBlock(planText, n) {
  const out = []
  let infence = false
  let intask = false
  for (const line of planText.split('\n')) {
    if (/^```/.test(line)) infence = !infence
    else if (!infence && /^#+[ \t]+Task[ \t]+[0-9]+/.test(line)) intask = new RegExp(`^#+[ \\t]+Task[ \\t]+${n}([^0-9]|$)`).test(line)
    if (intask) out.push(line)
  }
  while (out.length && out.at(-1).trim() === '') out.pop()
  return out.length ? out.join('\n') : null
}

// ---- the workspace state: recorded BASEs and reviewed heads --------------------------------------

const statePath = (ws) => join(ws, 'dispatch-state.json')
const loadState = (ws) => {
  try {
    return JSON.parse(readFileSync(statePath(ws), 'utf8'))
  } catch {
    return { tasks: {} }
  }
}
const saveState = (ws, s) => writeAtomic(statePath(ws), JSON.stringify(s, null, 2) + '\n')
const short = (root, ref) => git(root, ['rev-parse', '--short', ref])

function reviewPackage(f, base, head, out) {
  execFileSync(join(BUILDER, 'scripts', 'review-package'), [base, head, out], { cwd: f.root, stdio: ['ignore', 'pipe', 'pipe'] })
  return out
}

// ---- pieces every kind shares --------------------------------------------------------------------

function contractOf(f) {
  const spec = read(f.specPath) ?? ''
  const c = mdSection(spec, 'Contract', { level: 2 })
  const v = f.manifest.contract ?? 'none'
  const frozen = /^frozen\b/.test(v)
  // `contract: none` with rows in §Contract is a contract nobody has frozen yet (single-app repos write none)
  const status = frozen ? `FROZEN ${v.replace(/^frozen\s*/, '')}` : tableRows(c?.body ?? '').length ? 'not frozen yet' : 'none — no producer change'
  const rule = frozen
    ? 'The producer\'s phase has closed: the shape is fixed: a mismatch is reported, never worked around.'
    : 'The producer implements exactly this shape; each consumer codes against exactly it.'
  return { body: c?.body ?? '(SPEC.md has no §Contract section)', status, rule, frozen }
}

function constraints(f) {
  const g = configSection(f.cfg, 'Global constraints')
  if (!g.trim()) throw new Error('the project config has no ## Global constraints section — every brief carries it verbatim (/builder:init --update)')
  return g.replaceAll('<TICKET>', f.key).replace(/\s+$/, '')
}

const craftValues = () => Object.fromEntries(Object.entries(CRAFT).map(([k, v]) => [k, skillPath(v)]))

function planOf(f) {
  const plan = read(f.planPath)
  if (!plan) throw new Error(`no PLAN.md in ${f.dir}`)
  return { plan, tasks: slices(plan) }
}

function taskOf(f, n) {
  if (!n) throw new Error('--task N is required for this kind')
  const { plan, tasks } = planOf(f)
  const t = tasks.find((x) => x.n === +n)
  const block = taskBlock(plan, +n)
  if (!t || !block) throw new Error(`task ${n} not found in ${f.planPath} (no heading matching 'Task ${n}')`)
  return { plan, tasks, t, block }
}

/**
 * The Recipe: line → the path to read first, else verbatim. Resolved: a builder skill, a REFERENCE
 * section, or the project's own `.claude/skills/<name>/SKILL.md`. `path: false` means the
 * implementer can only reach it through the Skill tool — the one case it runs as implementer-skills.
 */
function recipeOf(block, root = null) {
  const raw = /^\s*[-*]*\s*\**Recipe:?\**:?\s*(.+)$/m.exec(block)?.[1]?.trim()
  if (!raw) return null
  const tiny = /·\s*tiny\b/.test(raw)
  const name = raw.replace(/\s*·\s*tiny\b.*$/, '').replace(/`/g, '').trim()
  const skill = /^(?:builder:)?([a-z0-9-]+)$/.exec(name)?.[1]
  if (skill && existsSync(skillPath(skill))) return { text: `${skillPath(skill)}  (Recipe: ${raw})`, tiny, path: true }
  const ref = /REFERENCE\s*(§.*)$/.exec(name)
  if (ref) return { text: `${join(BUILDER, 'skills', 'resume', 'REFERENCE.md')} ${ref[1]}  (Recipe: ${raw})`, tiny, path: true }
  const own = root && /^[\w.-]+$/.test(name) ? join(root, '.claude', 'skills', name, 'SKILL.md') : null
  // A project skill that drives an MCP server (`mcp__<server>__<tool>`) needs an agent that has it.
  if (own && existsSync(own)) return { text: `${own}  (Recipe: ${raw} — the project's companion skill; read it with the Read tool)`, tiny, path: true, mcp: /\bmcp__\w/.test(read(own) ?? '') }
  return { text: `${raw} — the project's companion skill (the config's §Companion skills)`, tiny, path: false }
}

/** A task whose recipe uses MCP tools: the project's own implementer when it named one, else general-purpose — builder's lean agents carry no MCP. */
const mcpAgent = (f) => {
  const t = agentTypeOf(f, 'implementer')
  return t.startsWith('builder:') ? 'general-purpose' : t
}

/** The subagent_type a build dispatch runs as — the config's agent_types (builder's lean agents by default). */
const agentTypeOf = (f, kind) => f.cfg?.agentTypes?.[kind] ?? { implementer: 'builder:implementer', 'implementer-skills': 'builder:implementer-skills', reviewer: 'builder:reviewer' }[kind] ?? 'general-purpose'

const ENV_NOTES_CAP = 2000
/**
 * The `- ` bullets directly under every `## env notes` (or `## env notes (…)`) heading in the ledger, in
 * order — a note found late in the build gets a heading of its own further down. The ledger is append-only,
 * so under each heading the first non-bullet line (a completion, a ruling) ends its bullets; an indented line
 * continues a bullet. Capped at ENV_NOTES_CAP chars, whole bullets, with a pointer to the ledger for the rest.
 */
function envNotesOf(ledger) {
  const lines = String(ledger).split('\n')
  const out = []
  for (let at = 0; at < lines.length; at++) {
    if (!/^##\s+env notes(\s*\(.*\))?\s*$/i.test(lines[at])) continue
    let i = at + 1
    while (i < lines.length && !lines[i].trim()) i++
    let any = false
    for (; i < lines.length; i++) {
      const l = lines[i]
      if (/^- /.test(l) || (any && /^\s+\S/.test(l))) {
        out.push(l)
        any = true
      } else break
    }
    at = i - 1
  }
  if (!out.length) return ''
  let kept = ''
  for (const [k, l] of out.entries()) {
    if (/^- /.test(l) && k && (kept + '\n' + l).length > ENV_NOTES_CAP) return `${kept}\n… see the ledger (progress.md §env notes) for the rest`
    kept = kept ? `${kept}\n${l}` : l
  }
  return kept.trim()
}

/** The brief: the task block + build §Composing the brief's four blocks, in order. */

function composeBrief(f, n, block, app) {
  const spec = read(f.specPath) ?? ''
  const sec = (name) => mdSection(spec, name, { level: 2 })?.text
  const parts = [block, '', '---', '', '# What this task implements — from SPEC.md', '']
  const appSec = (f.cfg?.appNames ?? [app]).filter((a) => a.toLowerCase() === String(app).toLowerCase()).map((a) => sec(a)).find(Boolean)
  if (appSec) parts.push(appSec, '')
  if (/\bSC\d+\b|\bschema\b|\bmigrations?\b/i.test(block)) {
    const s = sec('Schema & API changes')
    if (s) parts.push(s, '')
  }
  for (const name of ['Testing', 'Decisions']) {
    const s = sec(name)
    if (s) parts.push(s, '')
  }
  const findings = mdSection(spec, 'Findings', { level: 2 })
  const risky = tableRows(findings?.body ?? '').filter((r) => /build-time risk/i.test(r.join(' ')) && new RegExp(`\\b(Task\\s*${n}|T${n})\\b`).test(r.join(' ')))
  if (risky.length) parts.push('## Findings & risks — build-time risks for this task', '', '| # | Finding | Resolution |', '|---|---|---|', ...risky.map((r) => `| ${r.join(' | ')} |`), '')
  const c = contractOf(f)
  parts.push(`## §Contract — ${c.status}`, '', c.body, '', c.rule, '')
  const recipe = recipeOf(block, f.root)
  if (recipe) parts.push('## Read first — the recipe', '', recipe.text, '')
  // Environment facts ride in the brief, so the orchestrator's --context needn't carry them.
  const landmines = configSection(f.cfg, 'Environment landmines').trim()
  if (landmines) parts.push("## Environment landmines (the project config's, verbatim)", '', landmines, '')
  const envNotes = envNotesOf(read(join(f.ws(), 'progress.md')) ?? '')
  if (envNotes) parts.push("## Environment notes (the ledger's)", '', envNotes, '')
  // The craft skills are not repeated here: the implementer's prompt names each with when to read it.
  parts.push("## Global constraints (the project config's, verbatim)", '', constraints(f), '')
  return parts.join('\n')
}

const commitTexts = () => {
  const md = readFileSync(join(PROMPTS, 'implementer.md'), 'utf8').replace(/\s+/g, ' ')
  const auto = /`commit: auto`:\s*\*"([^"]+)"\*/.exec(md)?.[1]
  const manual = /`commit: manual`:\s*(🔴\s*)?\*"([^"]+)"\*/.exec(md)
  if (!auto || !manual) throw new Error('prompts/implementer.md no longer states the commit: auto / commit: manual texts — teach dispatch.mjs')
  return { auto, manual: `${manual[1] ?? ''}${manual[2]}` }
}

/** The scope line a findings FILE carries: a reviewer's whole report, of which only the open findings are in the round. */
export const FILE_SCOPE =
  'The open findings are, in the review report below: its Critical and Important issues and its ❌ spec-compliance items — or, in a re-review report, every finding marked NOT ADDRESSED and any new Critical or Important breakage. Minor issues, Strengths and out-of-scope observations are not in this round.'

function findingsOf(a) {
  const file = a['findings-file']
  if (file != null) {
    const text = read(file)
    if (!text || !text.trim()) throw new Error(`no findings in ${file} — the reviewer writes its report there (the dispatch's findings: line); pass the file it names`)
    const parts = [FILE_SCOPE, '', `From ${file} (verbatim):`, '', text.replace(/\s+$/, '')]
    if (a.findings?.trim()) parts.push('', 'Added by the controller:', '', a.findings.replace(/\s+$/, ''))
    return parts.join('\n')
  }
  const text = a.findings
  if (!text || !text.trim()) throw new Error('this dispatch carries the open findings verbatim — pass --findings-file <the review\'s findings file> or --findings "<text>"')
  return text.replace(/\s+$/, '')
}

/** Where a reviewer writes its report — the file a fix round passes as --findings-file. */
const findingsPath = (ws, name) => join(ws, `${name}.md`)

// ---- the kinds -----------------------------------------------------------------------------------

/** The final review's ONE fix wave (EXECUTION.md §The final whole-branch review): its own brief, the implementer template. */
function finalFix(f, a, ws) {
  const st = loadState(ws)
  if (!st.final?.reviewed?.[0]) throw new Error('no final review recorded — dispatch final-review first')
  const findings = findingsOf({ ...a, 'findings-file': a['findings-file'] ?? (a.findings ? undefined : findingsPath(ws, 'final-review')) })
  const c = contractOf(f)
  const apps = isSet(f.manifest.apps) ? f.manifest.apps.split('+').map((x) => x.trim()) : (f.cfg?.appNames ?? [])
  const briefPath = join(ws, 'final-fix-brief.md')
  const brief = [
    `# ${f.feature} — the final whole-branch review's fix wave`,
    '',
    `The spec: ${f.specPath} — §Apps, §Contract, §Decisions and §Testing are what the code must satisfy.`,
    '',
    '## The findings',
    '',
    findings,
    '',
    `## §Contract — ${c.status}`,
    '',
    c.body,
    '',
    c.rule,
    '',
    "## Global constraints (the project config's, verbatim)",
    '',
    constraints(f),
    '',
  ].join('\n')
  writeAtomic(briefPath, brief)
  const reportPath = join(ws, 'final-fix-report.md')
  const texts = commitTexts()
  const modes = apps.map((n) => [n, f.cfg?.apps.find((x) => x.name === n)?.commit ?? 'auto'])
  const subject = `fix(${f.key}): final review findings`
  const commit = modes.every(([, m]) => m !== 'manual')
    ? `${texts.auto.replace(/exactly one commit for this task/, 'one commit per app you fix')} Subject: \`${subject}\`.`
    : modes.map(([n, m]) => `In ${n}: ${m === 'manual' ? `${texts.manual} Propose: \`${subject}\`.` : `${texts.auto.replace(/exactly one commit for this task/, 'one commit for this app')} Subject: \`${subject}\`.`}`).join(' ')
  const ctx = [
    `The final whole-branch review of ${f.feature} returned findings; you are the ONE fix wave — every finding in the brief, in one pass. There is no second wave.`,
    `Read ${skillPath(CRAFT.REVIEW_PATH)} BEFORE fixing anything: findings are evaluated, not obeyed — a wrong one gets a reasoned push-back in your report.`,
  ]
  if (a.context) ctx.push('', a.context.trim())
  const tpl = promptOf(readFileSync(join(PROMPTS, 'implementer.md'), 'utf8'))
  let body = tpl.body.replaceAll('Task N: [task name]', `the final review's fixes for ${f.feature}`).replaceAll('[directory]', f.root)
  body = body.replace(/\[One line on where this fits\.[^\]]*\]/, () => ctx.join('\n'))
  body = fill(body, {
    BRIEF_FILE: briefPath,
    APP: `each finding's own app (${apps.join(', ')}) — a fix stays inside the app its finding names`,
    COMMIT_INSTRUCTION: commit,
    REPORT_FILE: reportPath,
    ...craftValues(),
  })
  return { file: join(ws, 'dispatch-implementer-final-fix.md'), body, description: `Fix the final review's findings: ${f.feature}`, model: modelFor({ kind: 'final-fix', models: modelsLever(f) }), agentType: agentTypeOf(f, 'implementer') }
}

function implementer(f, a, ws) {
  if (a.final) return finalFix(f, a, ws)
  const { tasks, t, block } = taskOf(f, a.task)
  const n = t.n
  const round = a.round ? +a.round : 0
  const st = loadState(ws)
  const rec = (st.tasks[n] ??= {})
  if (a.base) rec.base = short(f.root, a.base)
  rec.base ??= short(f.root, 'HEAD')
  // The model: the task's implementer records what it ran on (the default, or --model); a resumed
  // round 1–3 names it again; rounds 4–5 go one tier above it (§Model selection's escalation).
  const recipe = recipeOf(block, f.root)
  const lever = { tiny: !!recipe?.tiny, models: modelsLever(f) }
  const dflt = modelFor({ kind: 'implementer', ...lever })
  let model, why
  if (round >= 4) {
    const ran = rec.model ?? dflt
    ;[model, why] = [tierUp(ran), `one tier above ${ran}, round ${round}`]
  } else if (round) {
    ;[model, why] = rec.model ? [rec.model, rec.model === dflt ? defaultWhy(lever) : 'the model that ran the task'] : [dflt, defaultWhy(lever)]
  } else [model, why] = [dflt, defaultWhy(lever)]
  const override = raiseOnly(overrideOf(a), model, 'this implementer')
  if (override) [model, why] = [override, '--model']
  if (!round) rec.model = model
  saveState(ws, st)

  const briefPath = join(ws, `task-${n}-brief.md`)
  writeAtomic(briefPath, composeBrief(f, n, block, t.app) + '\n')
  const reportPath = join(ws, `task-${n}-report.md`)
  const app = f.cfg?.apps.find((x) => x.name === t.app)
  const texts = commitTexts()
  const subject = /\*\*Step \d+:\s*Commit\*\*\s*[—–-]\s*`([^`]+)`/.exec(block)?.[1]
  const manual = app?.commit === 'manual'
  const commit = manual ? `${texts.manual}${subject ? ` Propose: \`${subject}\`.` : ''}` : `${texts.auto}${subject ? ` Subject: \`${subject}\`.` : ''}`
  const phaseRow = phaseGoal(read(f.planPath), t.phase ?? null, n)
  const ctx = [`Task ${n} of ${tasks.length} · Phase ${phaseRow.phase ?? '?'} (${t.app})${phaseRow.goal ? ` — ${phaseRow.goal}` : ''}.`]
  if (round) {
    ctx.push('')
    ctx.push(round >= 4 ? `A prior implementer attempted this task ${round - 1} times; you own it now. Read the report file for what was tried.` : `Fix round ${round}/5 of this task — the report file holds what was done so far.`)
    ctx.push(`Read ${skillPath(CRAFT.REVIEW_PATH)} BEFORE fixing anything: findings are evaluated, not obeyed — a wrong one gets a reasoned push-back.`)
    if (round >= 3) ctx.push(`Read ${skillPath(CRAFT.DEBUGGING_PATH)} now: a finding that survives fix rounds is a symptom — find its cause first.`)
    ctx.push('', 'Open findings (verbatim):', '', findingsOf(a), '', `Fix them, re-run the tests covering the amended code, append a fix report to ${reportPath}, and reply with the short contract.`)
  }
  if (a.context) ctx.push('', a.context.trim())

  const tpl = promptOf(readFileSync(join(PROMPTS, 'implementer.md'), 'utf8'))
  let body = tpl.body.replaceAll('Task N:', `Task ${n}:`).replaceAll('[task name]', t.name).replaceAll('[directory]', f.root)
  body = body.replace(/\[One line on where this fits\.[^\]]*\]/, () => ctx.join('\n'))
  body = fill(body, { BRIEF_FILE: briefPath, APP: t.app, COMMIT_INSTRUCTION: commit, REPORT_FILE: reportPath, ...craftValues() })
  return {
    file: join(ws, `dispatch-implementer-task-${n}${round ? `-round-${round}` : ''}.md`),
    agentType: recipe?.mcp ? mcpAgent(f) : agentTypeOf(f, recipe && !recipe.path ? 'implementer-skills' : 'implementer'),
    body,
    // A fix round says so — the fleet's meter tells a fix from an implementer by this description.
    description: round ? `Fix Task ${n} round ${round}: ${t.name}` : tpl.description.replace('Task N', `Task ${n}`).replace('[task name]', t.name),
    model,
    why,
    note: `BASE ${rec.base} recorded for task ${n}`,
  }
}

function phaseGoal(plan, phase, n) {
  const sec = mdSection(plan ?? '', 'Phases', { level: 2 })
  for (const r of tableRows(sec?.body ?? '')) {
    const [p, , tasks, goal] = r
    const inRow = (tasks ?? '').split(/[,\s]+/).some((part) => {
      const m = /^(\d+)(?:[-–](\d+))?$/.exec(part)
      return m && n >= +m[1] && n <= +(m[2] ?? m[1])
    })
    if (inRow || (phase != null && +p === phase && !tasks)) return { phase: +p, goal }
  }
  return { phase, goal: null }
}

function taskReview(f, a, ws) {
  const st = loadState(ws)
  const c = contractOf(f)
  const tpl = promptOf(readFileSync(join(PROMPTS, 'task-reviewer.md'), 'utf8'))
  if (a.phase) {
    const { tasks } = planOf(f)
    const members = tasks.filter((t) => phaseGoal(read(f.planPath), t.phase, t.n).phase === +a.phase)
    if (!members.length) throw new Error(`phase ${a.phase} has no tasks in the ## Phases table`)
    const base = a.base ? short(f.root, a.base) : st.tasks[members[0].n]?.base
    if (!base) throw new Error(`no BASE recorded for task ${members[0].n} (phase ${a.phase}'s first) — pass --base <sha>`)
    const key = `phase-${a.phase}`
    const rec = (st.phases ??= {})[key] ?? { base }
    rec.head ??= a.head ? short(f.root, a.head) : short(f.root, 'HEAD')
    st.phases[key] = rec
    saveState(ws, st)
    const diff = reviewPackage(f, rec.base, rec.head, join(ws, `review-phase-${a.phase}.diff`))
    const app = members[0].app
    const body = fill(tpl.body, {
      BRIEF_FILE: members.map((t) => join(ws, `task-${t.n}-brief.md`)).join(' · '),
      REPORT_FILE: members.map((t) => join(ws, `task-${t.n}-report.md`)).join(' · '),
      GLOBAL_CONSTRAINTS: constraints(f),
      SPEC_CONTRACT: `${c.body}\n\nContract status: ${c.status}. ${c.rule}`,
      APP: app,
      BASE_SHA: rec.base,
      HEAD_SHA: rec.head,
      DIFF_FILE: diff,
      FINDINGS_FILE: findingsPath(ws, `review-phase-${a.phase}`),
    })
    return { file: join(ws, `dispatch-task-review-phase-${a.phase}.md`), body, description: `Review phase ${a.phase} (${app}, tasks ${members.map((t) => t.n).join(', ')})`, model: modelFor({ kind: 'phase-review', models: modelsLever(f) }), findings: findingsPath(ws, `review-phase-${a.phase}`), agentType: agentTypeOf(f, 'reviewer') }
  }
  const { t } = taskOf(f, a.task)
  const rec = (st.tasks[t.n] ??= {})
  if (a.base) rec.base = short(f.root, a.base)
  if (!rec.base) throw new Error(`no BASE recorded for task ${t.n} — pass --base <sha> (the HEAD before its implementer ran)`)
  rec.reviewed ??= {}
  if (a.head) rec.reviewed[0] = short(f.root, a.head)
  rec.reviewed[0] ??= short(f.root, 'HEAD')
  saveState(ws, st)
  const head = rec.reviewed[0]
  const diff = reviewPackage(f, rec.base, head, join(ws, `review-${rec.base}..${head}.diff`))
  const brief = join(ws, `task-${t.n}-brief.md`)
  if (!existsSync(brief)) writeAtomic(brief, composeBrief(f, t.n, taskOf(f, t.n).block, t.app) + '\n')
  const body = fill(tpl.body, {
    BRIEF_FILE: brief,
    REPORT_FILE: join(ws, `task-${t.n}-report.md`),
    GLOBAL_CONSTRAINTS: constraints(f),
    SPEC_CONTRACT: `${c.body}\n\nContract status: ${c.status}. ${c.rule}`,
    APP: t.app,
    BASE_SHA: rec.base,
    HEAD_SHA: head,
    DIFF_FILE: diff,
    FINDINGS_FILE: findingsPath(ws, `task-${t.n}-review`),
  })
  const tiny = recipeOf(taskOf(f, t.n).block)?.tiny
  return { file: join(ws, `dispatch-task-review-task-${t.n}.md`), agentType: agentTypeOf(f, 'reviewer'), body, description: tpl.description.replace('Task N', `Task ${t.n}`), model: modelFor({ kind: 'task-review', tiny: !!tiny, models: modelsLever(f) }), why: defaultWhy({ tiny: !!tiny, models: modelsLever(f) }), findings: findingsPath(ws, `task-${t.n}-review`) }
}

function reReview(f, a, ws) {
  const round = +(a.round ?? 0)
  if (!round) throw new Error('--round R (1–5) is required for a re-review')
  const findings = findingsOf(a)
  const st = loadState(ws)
  const tpl = promptOf(readFileSync(join(PROMPTS, 're-review.md'), 'utf8'))
  let rec, brief, report, label
  if (a.final) {
    rec = st.final
    if (!rec?.reviewed?.[0]) throw new Error('no final review recorded — dispatch final-review first')
    brief = existsSync(join(ws, 'final-fix-brief.md')) ? join(ws, 'final-fix-brief.md') : f.specPath
    report = join(ws, 'final-fix-report.md')
    label = 'final review'
  } else {
    const { t } = taskOf(f, a.task)
    rec = st.tasks[t.n]
    if (!rec?.reviewed?.[round - 1]) throw new Error(`no review of task ${t.n} recorded before round ${round} — dispatch ${round === 1 ? 'task-review' : `re-review --round ${round - 1}`} first`)
    brief = join(ws, `task-${t.n}-brief.md`)
    report = join(ws, `task-${t.n}-report.md`)
    label = `Task ${t.n}`
  }
  const fixBase = rec.reviewed[round - 1]
  if (a.head) rec.reviewed[round] = short(f.root, a.head)
  rec.reviewed[round] ??= short(f.root, 'HEAD')
  saveState(ws, st)
  const head = rec.reviewed[round]
  const diff = reviewPackage(f, fixBase, head, join(ws, `review-${fixBase}..${head}.diff`))
  const out = findingsPath(ws, a.final ? 'final-re-review' : `task-${a.task}-re-review-${round}`)
  const body = fill(tpl.body, { BRIEF_FILE: brief, FINDINGS: findings, REPORT_FILE: report, FIX_BASE_SHA: fixBase, HEAD_SHA: head, DIFF_FILE: diff, FINDINGS_FILE: out })
  return {
    file: join(ws, `dispatch-re-review-${a.final ? 'final' : `task-${a.task}`}-round-${round}.md`),
    body,
    description: a.final ? `Re-review the final review's fix wave` : tpl.description.replace('Task N', label).replace('round R', `round ${round}`),
    model: modelFor({ kind: 're-review', round, models: modelsLever(f) }),
    findings: out,
    agentType: agentTypeOf(f, 'reviewer'),
  }
}

function finalReview(f, a, ws) {
  const st = loadState(ws)
  const target = [f.manifest.target, f.cfg?.mergeInto, f.cfg?.baseBranch].find(isSet) ?? 'main'
  const rec = (st.final ??= {})
  if (a.base) rec.base = short(f.root, a.base)
  rec.base ??= (git(f.root, ['merge-base', target, 'HEAD'], { allowFail: true }) ?? '').slice(0, 7) || null
  if (!rec.base) throw new Error(`no merge-base with ${target} — pass --base <sha>`)
  rec.reviewed ??= {}
  if (a.head) rec.reviewed[0] = short(f.root, a.head)
  rec.reviewed[0] ??= short(f.root, 'HEAD')
  saveState(ws, st)
  const head = rec.reviewed[0]
  const diff = reviewPackage(f, rec.base, head, join(ws, 'review-final.diff'))
  const ledger = read(join(ws, 'progress.md')) ?? ''
  const carried = ledger.split('\n').filter((l) => /minor \(deferred\)|\bparked\b/i.test(l))
  const spec = read(f.specPath) ?? ''
  const idea = mdSection(spec, 'Idea', { level: 2 }) ?? mdSection(spec, 'Overview', { level: 2 })
  const why = (idea?.body ?? '').split(/\n\s*\n/).find((p) => /^\*\*Why\.?\*\*/.test(p.trim())) ?? (idea?.body ?? '').split(/\n\s*\n/)[0] ?? ''
  const apps = isSet(f.manifest.apps) ? f.manifest.apps.split('+').join(', ') : (f.cfg?.appNames ?? []).join(', ')
  const desc = [why.replace(/^\*\*Why\.?\*\*\s*/, '').replace(/\s*\n\s*/g, ' ').trim(), `Apps: ${apps}.`, a.context?.trim()].filter(Boolean).join(' ')
  const tpl = promptOf(readFileSync(join(PROMPTS, 'final-reviewer.md'), 'utf8'))
  const body = fill(tpl.body, {
    DESCRIPTION: desc,
    SPEC_PATH: f.specPath,
    DEFERRED_AND_PARKED: carried.length ? carried.join('\n') : 'None — the ledger has no deferred-minor or parked lines.',
    DIFF_FILE: diff,
    BASE_SHA: rec.base,
    HEAD_SHA: head,
    FINDINGS_FILE: findingsPath(ws, 'final-review'),
  })
  return { file: join(ws, 'dispatch-final-review.md'), body, description: tpl.description.replace('<feature>', f.feature), model: modelFor({ kind: 'final-review' }), findings: findingsPath(ws, 'final-review'), agentType: agentTypeOf(f, 'reviewer') }
}

/**
 * A round after the first walks only what the fix could have changed: the items the last round
 * failed, plus any it passed whose code the fix touched. Every other pass is carried — its row copied
 * with `PASS (carried from round <n-1> @ <sha>)` and its evidence — so a one-item fix is a one-item
 * walk, not the whole scope again. No readable last report → the whole scope, as round 1.
 */
export function rewalkScope(f, dir, n) {
  if (n < 2) return []
  const prev = read(join(dir, `round-${n - 1}`, 'report.md'))
  if (!prev) return []
  const sha = /^sha:\s*(\S+)/m.exec(prev)?.[1] ?? null
  const rows = tableRows(prev).filter((r) => r[0] && !/^#$/.test(r[0]))
  const failed = rows.filter((r) => !/^PASS\b/i.test(r[3] ?? ''))
  const passed = rows.filter((r) => /^PASS\b/i.test(r[3] ?? ''))
  let diff = ''
  if (sha) {
    try {
      diff = execFileSync('git', ['diff', '--stat', `${sha}..HEAD`], { cwd: f.root, encoding: 'utf8' }).trim()
    } catch {}
  }
  const out = ['', `## Round ${n}: walk only what the fix could change`, '']
  out.push(failed.length ? `Walk these — round ${n - 1} did not pass them:` : `Round ${n - 1} failed nothing by row — walk the scope above.`)
  if (failed.length) out.push('', ...failed.map((r) => `- ${r[0]} · ${r[1]} · ${r[2]} — was ${r[3]}`))
  if (passed.length) {
    out.push(
      '',
      `Passed in round ${n - 1}${sha ? ` at ${sha}` : ''}: ${passed.map((r) => r[0]).join(', ')}. Re-walk one only when the fix since then changes code it exercises — read the diff below and say why in its row; otherwise copy its row from round ${n - 1}'s report with Result \`PASS (carried from round ${n - 1}${sha ? ` @ ${sha}` : ''})\` and the same evidence paths.`,
    )
    if (diff) out.push('', `\`git diff --stat ${sha}..HEAD\`:`, '', '```', diff, '```')
  }
  if (n >= 3 && failed.length) out.push('', `These items have now failed after a fix. For each, read ${skillPath(CRAFT.DEBUGGING_PATH)} and look for the cause, not only the symptom.`)
  return out
}

function agentWalk(f, a, ws) {
  const walkLever = parseTestPlan(f.manifest).levers.walk
  if (walkLever === 'none') throw new Error(`no walker under walk=none — the sign-off is \`condense.mjs <folder> --signoff agent --no-walk\` (agent-walk §The test plan)`)
  const walk = join(ws, 'walk.md')
  if (!existsSync(walk)) throw new Error(`no ${walk} — the build writes it (scripts/walk-script.mjs)`)
  const dir = join(ws, 'agent-walk')
  const rounds = existsSync(dir) ? readdirSync(dir).map((d) => +(/^round-(\d+)$/.exec(d)?.[1] ?? NaN)).filter(Number.isInteger) : []
  const n = a.round ? +a.round : (rounds.length ? Math.max(...rounds) : 0) + 1
  const out = join(dir, `round-${n}`)
  const driver = f.cfg?.agentWalk?.driver
  const landmines = configSection(f.cfg, 'Environment landmines').trim()
  const lines = [
    `You are the agent walker for the feature "${f.feature}" — an independent check of a build you did not write. Work in ${f.root}: run every command from there.`,
    '',
    '## The walk script',
    '',
    `Read in full: ${walk}`,
    '',
    '## How you drive it',
    '',
    driver
      ? driver
      : 'there is no UI driver: exercise each item through its endpoints, the server log and the database, and mark any item that can only be checked by looking at the screen `UNVERIFIABLE`.',
    '',
    '## Environment landmines (the project config\'s, verbatim)',
    '',
    landmines || 'The project config has no §Environment landmines section.',
    '',
    '## What to walk',
    '',
    walkLever === 'risk'
      ? 'Work every `[risk]` item and every step of the `## Cross-app (verify E2E)` section, in order, per app — and say in the report that the other items were out of scope (tests: walk=risk).'
      : 'Work **every** item of walk.md, in order, per app — the `## Cross-app (verify E2E)` section too, when it is there.',
  ]
  lines.push(...rewalkScope(f, dir, n))
  lines.push(
    '',
    '## Rules',
    '',
    '- For each item record `PASS`, `FAIL` or `UNVERIFIABLE`, what you did, what you saw, and its evidence files — screenshots `NN-<slug>.png`, console output, the relevant server-log lines. A `FAIL` states *expected* and *saw*, one line each.',
    '- Never edit code, never commit, never touch the manifest or the SPEC.',
    '- **Walk by screen.** Group the items by the screen or component they exercise; reach each one once and check every item on it in order — one app session, one launch — recording a row per item. Relaunch, sign out or reset only when an item needs a fresh start (a first launch, a cold cache, a signed-out state), and say so in its row. Driving every item from a fresh launch is the slow way to walk a screen that holds them all.',
    '- The `## Cross-app (verify E2E)` section, when present, is walked like every other item: one report row per step, `#` = `E<k>`, App = `cross-app`, with its evidence. Verify quotes these rows instead of driving the app again, so an `E` row without evidence is a `FAIL`.',
    '- Run no tests — no test suite, no build. You judge the running app; tests are the verifier\'s. A build here rewrites what the walk env\'s dev server serves from this worktree and takes the env down mid-walk.',
    '',
    '## Output',
    '',
    `Evidence directory: ${out}/ (create it).`,
    `Report: ${join(out, 'report.md')} — first line \`sha: <HEAD at walk start>\` (\`git rev-parse --short HEAD\` before your first item: the code this round walked), then a table \`# · App · Item · Result · Evidence\`, then one line: \`verdict: PASS\` or \`verdict: PROBLEMS (<k>)\`.`,
  )
  if (a.context) lines.push('', a.context.trim())
  return { file: join(ws, `dispatch-agent-walk-round-${n}.md`), body: lines.join('\n') + '\n', description: `Agent walk round ${n}`, model: modelFor({ kind: 'agent-walk' }) }
}

/**
 * One walker for a batch of features the fleet merged into one walk branch (fleet §Batched walks):
 * every feature's walk.md and scope, its round, its own report — walked together, by screen, in one
 * session against the one env serving all of them. Written to the walk worktree's workspace.
 */
function walkBatch(features, a, root) {
  const walks = []
  for (const f of features) {
    const w = parseTestPlan(f.manifest).levers.walk
    if (w === 'none') continue // no walker: agent-walk signs it off --no-walk
    const ws = f.ws()
    const walk = join(ws, 'walk.md')
    if (!existsSync(walk)) throw new Error(`no ${walk} — the build writes it (scripts/walk-script.mjs)`)
    const dir = join(ws, 'agent-walk')
    const rounds = existsSync(dir) ? readdirSync(dir).map((d) => +(/^round-(\d+)$/.exec(d)?.[1] ?? NaN)).filter(Number.isInteger) : []
    const n = (rounds.length ? Math.max(...rounds) : 0) + 1
    walks.push({ f, walkLever: w, walk, n, out: join(dir, `round-${n}`), scope: rewalkScope(f, dir, n) })
  }
  if (!walks.length) throw new Error('no feature in this batch needs a walker (every test plan says walk=none)')
  const cfg = walks[0].f.cfg
  const driver = cfg?.agentWalk?.driver
  const landmines = configSection(cfg, 'Environment landmines').trim()
  const lines = [
    `You are the agent walker for ${walks.length} features at once — an independent check of builds you did not write. The app you drive serves the fleet's walk branch, which holds every one of them merged onto the target: one running env, every feature in it. Work in ${root}: run every command from there.`,
    '',
    '## How you drive it',
    '',
    driver || 'there is no UI driver: exercise each item through its endpoints, the server log and the database, and mark any item that can only be checked by looking at the screen `UNVERIFIABLE`.',
    '',
    "## Environment landmines (the project config's, verbatim)",
    '',
    landmines || 'The project config has no §Environment landmines section.',
    '',
    '## Walk by screen, across every feature',
    '',
    "Read every walk script below first. Then group ALL their items — whichever feature each belongs to — by the screen or component it exercises, and walk each screen once: reach it, check every item on it from every feature in order, one app session, one launch. Relaunch, sign out or reset only when an item needs a fresh start (a first launch, a cold cache, a signed-out state), and say so in its row. Driving each feature's items from a fresh start is exactly the cost this batch exists to remove.",
  ]
  for (const w of walks) {
    lines.push(
      '',
      `## ${w.f.feature} — round ${w.n}`,
      '',
      `Walk script: ${w.walk}`,
      w.walkLever === 'risk'
        ? 'Scope: every `[risk]` item and every step of the `## Cross-app (verify E2E)` section — say in the report that the other items were out of scope (tests: walk=risk).'
        : 'Scope: **every** item — the `## Cross-app (verify E2E)` section too, when it is there.',
      ...w.scope,
      '',
      `Evidence: ${w.out}/ (create it). Report: ${join(w.out, 'report.md')} — first line \`sha: <${w.f.feature}'s HEAD>\` (\`git -C ${w.f.root} rev-parse --short HEAD\` — the feature's own code, which this walk branch holds), then \`walked-in: <the walk branch's HEAD>\`, then a table \`# · App · Item · Result · Evidence\` with ${w.f.feature}'s items only, then one line: \`verdict: PASS\` or \`verdict: PROBLEMS (<k>)\`.`,
    )
  }
  lines.push(
    '',
    '## Rules',
    '',
    '- For each item record `PASS`, `FAIL` or `UNVERIFIABLE`, what you did, what you saw, and its evidence files — screenshots `NN-<slug>.png`, console output, the relevant server-log lines. A `FAIL` states *expected* and *saw*, one line each.',
    '- An item fails in the feature whose walk script lists it. When a failure looks caused by ANOTHER feature in the batch (it touches what that one changed), say so in its row — the fix is judged in the feature it fails in.',
    '- Never edit code, never commit, never touch any manifest or SPEC.',
    "- The `## Cross-app (verify E2E)` sections are walked like every other item: one row per step, `#` = `E<k>`, App = `cross-app`, with its evidence.",
    "- Run no tests — no test suite, no build. A build here rewrites what the walk env's dev server serves and takes the env down mid-walk.",
  )
  if (a.context) lines.push('', a.context.trim())
  const ws = join(root, '.builder', '_walk')
  return { file: join(ws, 'dispatch-walk-batch.md'), body: lines.join('\n') + '\n', description: `Agent walk — batch of ${walks.length}`, model: modelFor({ kind: 'walk-batch' }) }
}

// ---- next: the bookkeeping between two dispatches, in one call -----------------------------------

const verifyBin = () => process.env.BUILDER_VERIFY_BIN || join(BUILDER, 'scripts', 'verify', 'verify.mjs')

/**
 * `verify.mjs <args>` in the worktree → { out, status }, its stdout verbatim. Exits 0 green, 1 red,
 * 3 env-broken, 4 conflict, 5 none, 6 cancelled and 75 pending are answers; any other exit is an
 * error carrying its stderr.
 */
const VERIFY_ANSWERS = [0, 1, 3, 4, 5, 6, 75]
function verifyCli(root, args) {
  const r = spawnSync(process.execPath, [verifyBin(), ...args], { cwd: root, encoding: 'utf8' })
  if (r.error) throw r.error
  if (!VERIFY_ANSWERS.includes(r.status)) throw new Error(`verify.mjs ${args.join(' ')}: exit ${r.status}${r.stderr?.trim() ? ` — ${r.stderr.trim()}` : ''}${r.stdout?.trim() ? `\n${r.stdout.trim()}` : ''}`)
  return { out: (r.stdout ?? '').replace(/\s+$/, ''), status: r.status }
}

/**
 * The phase task n belongs to and the next member of that phase still to do — the ## Phases table's
 * Tasks cell decides membership, as --phase reads it; the first member after n with no
 * `Task M: complete` ledger line, as Setup's resume point picks (a batched task is never rendered again).
 */
function phaseEnd(f, n, ledgerText = '') {
  const plan = read(f.planPath)
  const { tasks } = planOf(f)
  const phaseOf = (t) => phaseGoal(plan, t.phase ?? null, t.n).phase
  const t = tasks.find((x) => x.n === n)
  if (!t) throw new Error(`task ${n} not found in ${f.planPath}`)
  const p = phaseOf(t)
  const isDone = (m) => new RegExp(`^Task ${m}: complete\\b`, 'm').test(ledgerText)
  const next = tasks.filter((x) => x.n > n && phaseOf(x) === p && !isDone(x.n)).sort((a, b) => a.n - b.n)[0]?.n ?? null
  return { phase: p, next }
}

/** `$BUILDER_FLEET_DIR/requests/<feature>.pause` (unset: the main checkout's .builder/fleet) → its first line, or null. */
function pauseRequest(f) {
  const dir = process.env.BUILDER_FLEET_DIR || join(mainRoot(f.root), '.builder', 'fleet')
  const text = read(join(dir, 'requests', `${f.feature}.pause`))
  return text == null ? null : text.split('\n')[0].trim() || '(no reason given)'
}

/** build SKILL §The test plan: `slice+second` adds a second reviewer on every task touching §Contract or §Schema & API changes. */
const SECOND_REVIEW = /§\s*Contract\b|§\s*Schema\b|\bcontract\b|\bschema\b|\bmigrations?\b|\bSC\d+\b/i

/** EXECUTION §5: the ledger line, the commit-tier request, the verdict, then the next render. → output lines and the render, if any. */
function close(f, ws, n, line, context, model) {
  const out = []
  const ledgerText = read(join(ws, 'progress.md')) ?? ''
  const done = ledgerText.split('\n').find((l) => new RegExp(`^Task ${n}: complete\\b`).test(l))
  if (done) out.push(`ledger: already applied (${done})`)
  else out.push(...advance(f, { ledger: [line] }).lines)

  const head = git(f.root, ['rev-parse', 'HEAD'])
  const filed = openLedger(mainRoot(f.root)).requests((r) => r.sha === head && r.tier === 'commit').at(-1)
  if (filed) out.push(`verify request: already applied (${filed.id}, commit ${head.slice(0, 7)})`)
  else out.push(`verify request: ${verifyCli(f.root, ['request', f.root, 'HEAD', '--tier', 'commit']).out} (commit ${head.slice(0, 7)})`)

  const branch = git(f.root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const verdict = verifyCli(f.root, ['verdict', branch])
  if (verdict.out) out.push(verdict.out)

  // A pause request (`fleet.mjs --pause`) stops the build after this task: build SKILL §Dispatch, review, fix parks it.
  const pause = pauseRequest(f)
  if (pause != null) {
    out.push(`paused — ${pause}`)
    return { lines: out, render: null }
  }

  const p = phaseEnd(f, n, read(join(ws, 'progress.md')) ?? '')
  if (p.next == null) {
    if (verdict.status === 1) out.push('verdict red — act on it (EXECUTION §5)')
    out.push(`phase ${p.phase ?? '?'} closes — build §Phase close`)
    return { lines: out, render: null }
  }
  // A red verdict is the orchestrator's to act on before the next task starts: no render, no BASE recorded.
  if (verdict.status === 1) {
    out.push(`verdict red — act on it (EXECUTION §5), then dispatch.mjs implementer ${f.rel} --task ${p.next}`)
    return { lines: out, render: null }
  }
  return { lines: out, render: implementer(f, { task: String(p.next), context, model }, ws) }
}

function next(f, a, ws) {
  if (a['after-implement'] != null) {
    const n = +a['after-implement']
    const review = parseTestPlan(f.manifest).levers.review
    if (review.startsWith('slice')) {
      const lines = []
      if (review === 'slice+second' && SECOND_REVIEW.test(taskOf(f, n).block)) lines.push(`second review: Task ${n} touches §Contract or §Schema & API changes — under review=slice+second, also dispatch a second reviewer on the most capable model (build §The test plan)`)
      return { lines, render: taskReview(f, { task: String(n) }, ws) }
    }
    const base = loadState(ws).tasks[n]?.base
    if (!base) throw new Error(`no BASE recorded for task ${n} — its implementer is rendered first (dispatch.mjs implementer --task ${n})`)
    return close(f, ws, n, `Task ${n}: complete (commits ${base}..${short(f.root, 'HEAD')}, no task review (tests: review=${review}))`, a.context, a.model)
  }
  return close(f, ws, +a.close, a.ledger, a.context, a.model)
}

/**
 * Write a render's file and print one line per fact, every path relative to the repo root: the file
 * (with the BASE it recorded), the findings file a reviewer writes, and the Agent call on one line —
 * its subagent_type (general-purpose only when the session has no agent of that type), the model tier
 * §Model selection picks (modelFor), the description and the prompt.
 */
function emit(r, root) {
  writeAtomic(r.file, r.body)
  const rel = (p) => relative(root, p) || '.'
  console.log(`wrote ${rel(r.file)}${r.note ? ` · ${r.note}` : ''}`)
  if (r.findings) console.log(`findings: ${rel(r.findings)}`)
  // The walker stays general-purpose: its driver's tools (a browser MCP, a device bridge) are the project's.
  // The prompt's path stays absolute: the agent's Read wants one, and its cwd may not be the repo root.
  console.log(`Agent call — subagent_type: ${r.agentType ?? 'general-purpose'} · model: ${r.model} (${r.why ?? 'default'}) · description: ${r.description} · prompt: Read ${r.file} and do what it says.`)
}

const RENDER = { implementer, 'task-review': taskReview, 're-review': reReview, 'final-review': finalReview, 'agent-walk': agentWalk }

async function main(argv) {
  const a = parseArgs(argv, { bool: ['final'] })
  const [kind, folder] = a._
  if (kind === 'walk-batch') {
    const folders = a._.slice(1)
    if (!folders.length) {
      console.error('usage: dispatch.mjs walk-batch <folder>… [--context "<one paragraph>"]   (run in the fleet\'s walk worktree)')
      return 2
    }
    const fs = folders.map((d) => openFeature(d))
    for (const f of fs) if (!f.cfg) throw new Error(f.cfgError)
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    emit(walkBatch(fs, a, root), root)
    return 0
  }
  if (kind === 'next') {
    const ok = folder && (/^\d+$/.test(a['after-implement'] ?? '') ? a.close == null : /^\d+$/.test(a.close ?? '') && a.ledger?.trim())
    if (!ok) {
      console.error('usage: dispatch.mjs next <folder> --after-implement N | --close N --ledger "<line>" [--context "<one paragraph>"] [--model <m>]')
      return 2
    }
    if (a.close != null && !new RegExp(`^Task ${+a.close}: complete\\b`).test(a.ledger.trim())) {
      console.error(`dispatch.mjs next --close ${a.close}: the --ledger line must start \`Task ${+a.close}: complete\` (EXECUTION §5's forms) — got: ${a.ledger.trim()}`)
      return 2
    }
    const f = openFeature(folder)
    if (!f.cfg) throw new Error(f.cfgError)
    const r = next(f, a, f.ws())
    for (const l of r.lines) console.log(l)
    // The next implementer takes --model itself (it records the model that ran); a task review is overridden here.
    const override = r.render && r.render.why !== '--model' ? raiseOnly(overrideOf(a), r.render.model, 'task-review') : null
    if (override) Object.assign(r.render, { model: override, why: '--model' })
    if (r.render) emit(r.render, f.root)
    return 0
  }
  if (!kind || !folder || !KINDS.includes(kind)) {
    console.error(`usage: dispatch.mjs <${KINDS.join('|')}> <folder> [--task N | --final] [--round N] [--context "<one paragraph>"] [--findings "<text>" | --findings-file <path>] [--base <sha>] [--head <sha>] [--phase N] [--final]`)
    return 2
  }
  const f = openFeature(folder)
  if (!f.cfg) throw new Error(f.cfgError)
  const ws = f.ws()
  const r = RENDER[kind](f, a, ws)
  const override = r.why === '--model' ? null : raiseOnly(overrideOf(a), r.model, kind)
  if (override) Object.assign(r, { model: override, why: '--model' })
  emit(r, f.root)
  return 0
}

if ((() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()) cli(main)
