import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { leanRepo, run as runScript, git, readText, SCRIPTS } from './fixtures/lean-repo.mjs'
import { promptOf, fill, taskBlock, modelFor } from '../dispatch.mjs'

const BUILDER = join(SCRIPTS, '..')
const WS = (r) => join(r.root, '.builder', r.feature)
const PLACEHOLDER = /\[(?:MODEL|BRIEF_FILE|APP|COMMIT_INSTRUCTION|GLOBAL_CONSTRAINTS|TDD_PATH|DEBUGGING_PATH|REVIEW_PATH|VERIFICATION_PATH|REPORT_FILE|SPEC_CONTRACT|BASE_SHA|HEAD_SHA|DIFF_FILE|FINDINGS|FIX_BASE_SHA|DESCRIPTION|SPEC_PATH|DEFERRED_AND_PARKED|FINDINGS_FILE|directory|task name|One line on where)\b/
/** The CLI run, remembering where it ran: dispatch prints paths relative to the repo root. */
const run = (script, args, opts = {}) => ({ ...runScript(script, args, opts), cwd: opts.cwd ?? process.cwd() })
const pathFrom = (res) => {
  const p = /^wrote (\S+)/m.exec(res.stdout)?.[1]
  return p && resolve(res.cwd, p)
}
const rel = (r, p) => relative(r.root, p)
const commitTask = (r, file = 'src/cli.mjs', msg = 'feat(note-tags): add --tag and tagged list lines') => {
  mkdirSync(join(r.root, 'src'), { recursive: true })
  writeFileSync(join(r.root, file), `// ${msg} ${Math.random()}\n`)
  git(r.root, 'add', file)
  git(r.root, 'commit', '-qm', msg)
  return git(r.root, 'rev-parse', '--short', 'HEAD')
}

test('promptOf: the prompt body of a skills/build/prompts template, de-indented, the description line too', () => {
  const p = promptOf(readFileSync(join(BUILDER, 'skills', 'build', 'prompts', 'implementer.md'), 'utf8'))
  assert.equal(p.description, 'Implement Task N: [task name]')
  assert.match(p.body, /^You are implementing Task N: \[task name\]\n/)
  assert.match(p.body, /\n## Report format\n/)
  assert.doesNotMatch(p.body, /^ {4}\S/m)
})

test('fill: named placeholders only — the reviewer\'s own output brackets stay', () => {
  const body = 'Read [BRIEF_FILE]\n[GLOBAL_CONSTRAINTS — pasted\nverbatim]\n**Task quality:** [Approved | Needs fixes]'
  assert.equal(fill(body, { BRIEF_FILE: '/b.md', GLOBAL_CONSTRAINTS: '- one\n- two' }), 'Read /b.md\n- one\n- two\n**Task quality:** [Approved | Needs fixes]')
  assert.throws(() => fill('[REPORT_FILE]', {}), /REPORT_FILE/)
})

test('taskBlock: one task from its heading to the next Task heading, a fenced heading skipped — task-brief\'s rule', () => {
  const plan = '# P\n\n### Task 1: a\nx\n```md\n### Task 2: in a fence\n```\n### Task 2: b\ny\n### Task 10: c\nz\n'
  assert.equal(taskBlock(plan, 1), '### Task 1: a\nx\n```md\n### Task 2: in a fence\n```')
  assert.equal(taskBlock(plan, 1).includes('### Task 2: b'), false)
  assert.equal(taskBlock(plan, 10), '### Task 10: c\nz')
  assert.equal(taskBlock(plan, 3), null)
})

test('dispatch implementer: the brief (task + SPEC sections + §Contract + recipe + constraints) and the full prompt (+ craft skills), nothing left unfilled', () => {
  const r = leanRepo('note-tags')
  const out = run('dispatch.mjs', ['implementer', r.rel, '--task', '1', '--context', 'Tasks 2 and 3 build on parse/tagsOf/line — use exactly those names.'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  const file = pathFrom(out)
  assert.equal(file, join(WS(r), 'dispatch-implementer-task-1.md'))
  assert.match(out.stdout, /description: Implement Task 1: Tag parsing, `add --tag`, and the tagged `list` line/)
  assert.match(out.stdout, /prompt: Read .*dispatch-implementer-task-1\.md and do what it says\./)
  // The Agent call's prompt names the file absolutely (Read wants an absolute path); the wrote line stays relative.
  assert.ok(agentCall(out).prompt.includes(`Read ${file} and`), agentCall(out).prompt)
  assert.match(out.stdout, /^wrote \.builder\//m)
  const p = readText(file)
  assert.doesNotMatch(p, PLACEHOLDER)
  assert.match(p, /^You are implementing Task 1: Tag parsing, `add --tag`, and the tagged `list` line\n/)
  assert.match(p, new RegExp(`Read your task brief first: ${join(WS(r), 'task-1-brief.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(p, /Task 1 of 3 · Phase 1 \(notes\) — `add --tag` stores validated/)
  assert.match(p, /Tasks 2 and 3 build on parse\/tagsOf\/line/)
  assert.match(p, /\*\*App: notes\.\*\*/)
  assert.match(p, /4\. Commit your work — exactly one commit for this task, code and tests together\. Subject: `feat\(note-tags\): add --tag and tagged list lines`\./)
  assert.match(p, new RegExp(`Work from: ${r.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`))
  for (const s of ['test-driven-development', 'systematic-debugging', 'receiving-code-review', 'verification-before-completion']) {
    const sp = join(BUILDER, 'skills', s, 'SKILL.md')
    assert.ok(p.includes(`**${sp}**`), s)
    assert.ok(existsSync(sp))
  }
  // A hang is capped portably: cap.mjs, never GNU `timeout` (macOS has none — a benchmark lost 24m to it).
  assert.ok(p.includes(`node ${join(BUILDER, 'scripts', 'cap.mjs')} 120 '<command>'`), 'the cap command, with its absolute path')
  assert.doesNotMatch(p, /wrap it in `timeout/)
  // The constraints close the brief, once — the prompt points at them rather than repeating them.
  assert.doesNotMatch(p, /- No dependencies\. Node's own modules only\./)
  assert.match(p, /Read it\s+with the Read tool, in one call — never `cat` or `sed` it/)
  assert.match(p, new RegExp(`Write your full report to ${join(WS(r), 'task-1-report.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`))

  const brief = readText(join(WS(r), 'task-1-brief.md'))
  assert.match(brief, /^### Task 1: Tag parsing/)
  assert.doesNotMatch(brief, /### Task 2:/)
  assert.match(brief, /\n## notes\n/)
  assert.match(brief, /\n## Testing\n/)
  assert.match(brief, /\n## Decisions\n[\s\S]*\| D17 \|/)
  assert.doesNotMatch(brief, /\n## Schema & API changes\n/)
  assert.doesNotMatch(brief, /\| F2 \|/)
  assert.match(brief, /## §Contract — not frozen yet\n/)
  assert.match(brief, /\| `notes tags` \| notes/)
  assert.ok(!brief.includes('## The craft skills') && !brief.includes(join(BUILDER, 'skills', 'systematic-debugging', 'SKILL.md')), 'the craft skills are the prompt\'s, not repeated in the brief')
  assert.match(brief, /## Read first — the recipe\n\n.*test-driven-development/)
  assert.match(brief, /## Global constraints \(the project config's, verbatim\)\n\n- No dependencies\. Node's own modules only\.\n- The CLI entry stays `src\/cli\.mjs`/)
  const state = JSON.parse(readText(join(WS(r), 'dispatch-state.json')))
  assert.equal(state.tasks['1'].base, git(r.root, 'rev-parse', '--short', 'HEAD'))
})

test('dispatch implementer: a build-time risk row naming the task rides into its brief; a schema task gets §Schema & API changes', () => {
  const r = leanRepo('note-tags')
  run('dispatch.mjs', ['implementer', r.rel, '--task', '2'], { cwd: r.root })
  const b2 = readText(join(WS(r), 'task-2-brief.md'))
  assert.match(b2, /## Findings & risks — build-time risks for this task\n[\s\S]*\| F2 \| build-time risk/)
  assert.doesNotMatch(b2, /\| F1 \|/)
  run('dispatch.mjs', ['implementer', r.rel, '--task', '1'], { cwd: r.root })
  assert.doesNotMatch(readText(join(WS(r), 'task-1-brief.md')), /F2 \| build-time risk/)
})

test('dispatch implementer: frozen contract, and commit: manual each change the prompt the way build says', () => {
  const r = leanRepo('note-tags')
  const mf = join(r.folder, 'MANIFEST.md')
  writeFileSync(mf, readText(mf).replace('contract: none', 'contract: frozen 2026-10-23'))
  const cfg = join(r.root, '.claude', 'builder.md')
  writeFileSync(cfg, readText(cfg).replace('commit: auto', 'commit: manual'))
  const out = run('dispatch.mjs', ['implementer', r.rel, '--task', '3'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  const p = readText(pathFrom(out))
  assert.match(p, /4\. 🔴 `git add` your work and STOP — stage it and propose the commit message in your report\. Do NOT run `git commit`:\n?\s*a commit in this app is the human's to approve\. Propose: `feat\(note-tags\): show tags and the tags command`\./)
  assert.match(readText(join(WS(r), 'task-3-brief.md')), /## §Contract — FROZEN 2026-10-23\n[\s\S]*the shape is fixed: a mismatch is reported, never worked around/)
})

test('dispatch implementer --round 4: a fresh implementer one tier up, with the findings and the craft skills to read', () => {
  const r = leanRepo('note-tags')
  run('dispatch.mjs', ['implementer', r.rel, '--task', '1'], { cwd: r.root })
  const out = run('dispatch.mjs', ['implementer', r.rel, '--task', '1', '--round', '4', '--findings', '- list prints a trailing space\n- tags ignores rm'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  const p = readText(pathFrom(out))
  assert.match(pathFrom(out), /dispatch-implementer-task-1-round-4\.md$/)
  assert.match(p, /A prior implementer attempted this task 3 times; you own it now\. Read the report file for what was tried\./)
  assert.match(p, /- list prints a trailing space\n- tags ignores rm/)
  assert.ok(p.includes(join(BUILDER, 'skills', 'systematic-debugging', 'SKILL.md') + ' now'))
  assert.match(out.stdout, /model: opus \(one tier above sonnet, round 4\) · /, 'one tier above the task\'s sonnet')
})

test('dispatch task-review: the review package is generated from the recorded BASE; §Contract verbatim; re-render is identical', () => {
  const r = leanRepo('note-tags')
  run('dispatch.mjs', ['implementer', r.rel, '--task', '1'], { cwd: r.root })
  const base = git(r.root, 'rev-parse', '--short', 'HEAD')
  const head = commitTask(r)
  const out = run('dispatch.mjs', ['task-review', r.rel, '--task', '1'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  const file = pathFrom(out)
  const p = readText(file)
  assert.doesNotMatch(p, PLACEHOLDER)
  const diff = join(WS(r), `review-${base}..${head}.diff`)
  assert.ok(existsSync(diff))
  assert.match(readText(diff), /^# Review package: /)
  assert.match(p, new RegExp(`\\*\\*App:\\*\\* notes  \\*\\*Base:\\*\\* ${base}  \\*\\*Head:\\*\\* ${head}`))
  assert.ok(p.includes(`**Diff file:** ${diff}`))
  assert.match(p, /\| `notes add <words…> \[--tag <t>\]…` \| notes/)
  assert.match(p, /Contract status: not frozen yet/)
  assert.match(p, /\*\*Task quality:\*\* \[Approved \| Needs fixes\]/)
  assert.match(out.stdout, /description: Review Task 1 \(spec \+ quality\)/)
  commitTask(r, 'src/other.mjs', 'unrelated later commit')
  const again = run('dispatch.mjs', ['task-review', r.rel, '--task', '1'], { cwd: r.root })
  assert.equal(readText(pathFrom(again)), p)
})

test('dispatch task-review: no recorded BASE and no --base → refused, naming the fix', () => {
  const r = leanRepo('note-tags')
  const out = run('dispatch.mjs', ['task-review', r.rel, '--task', '2'], { cwd: r.root })
  assert.equal(out.status, 1)
  assert.match(out.stderr, /no BASE recorded for task 2 — pass --base <sha>/)
})

test('dispatch re-review --round 1: fix base = the head the review saw; findings verbatim; the fix diff', () => {
  const r = leanRepo('note-tags')
  run('dispatch.mjs', ['implementer', r.rel, '--task', '1'], { cwd: r.root })
  const reviewed = commitTask(r)
  run('dispatch.mjs', ['task-review', r.rel, '--task', '1'], { cwd: r.root })
  const fixed = commitTask(r, 'src/cli.mjs', 'fix(note-tags): review round 1')
  const out = run('dispatch.mjs', ['re-review', r.rel, '--task', '1', '--round', '1', '--findings', '- **Important:** list prints a trailing space (src/cli.mjs:20)'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  const p = readText(pathFrom(out))
  assert.doesNotMatch(p, PLACEHOLDER)
  assert.match(p, new RegExp(`\\*\\*Fix base:\\*\\* ${reviewed} \\(the head the previous review saw\\)\n\\*\\*Head:\\*\\* ${fixed}`))
  assert.match(p, /- \*\*Important:\*\* list prints a trailing space/)
  assert.ok(existsSync(join(WS(r), `review-${reviewed}..${fixed}.diff`)))
  assert.match(out.stdout, /description: Re-review Task 1 fix round 1/)
  const noFindings = run('dispatch.mjs', ['re-review', r.rel, '--task', '1', '--round', '2'], { cwd: r.root })
  assert.equal(noFindings.status, 1)
})

test('dispatch: findings travel as files — each review names its findings file, the fix round and re-review take --findings-file, scoped to the open findings', () => {
  const r = leanRepo('note-tags')
  const ws = WS(r)
  run('dispatch.mjs', ['implementer', r.rel, '--task', '1'], { cwd: r.root })
  commitTask(r)
  const rev = run('dispatch.mjs', ['task-review', r.rel, '--task', '1'], { cwd: r.root })
  assert.equal(rev.status, 0, rev.stderr)
  const reviewFile = join(ws, 'task-1-review.md')
  assert.ok(rev.stdout.includes(`findings: ${rel(r, reviewFile)}`))
  const rp = readText(pathFrom(rev))
  assert.ok(rp.includes(`**Write the same report to ${reviewFile}**`))
  // the reviewer wrote its report; the fix round embeds it verbatim, scoped
  writeFileSync(reviewFile, '### Spec compliance\n\n- ✅ Spec compliant\n\n### Issues\n\n#### Important (Should Fix)\n\n- src/cli.mjs:20 — list prints a trailing space\n\n#### Minor (Nice to Have)\n\n- naming\n')
  const fix = run('dispatch.mjs', ['implementer', r.rel, '--task', '1', '--round', '1', '--findings-file', reviewFile, '--findings', '- ⚠️ confirmed: rm does not drop tags (src/store.mjs:9)'], { cwd: r.root })
  assert.equal(fix.status, 0, fix.stderr)
  const fp = readText(pathFrom(fix))
  assert.match(pathFrom(fix), /dispatch-implementer-task-1-round-1\.md$/)
  assert.ok(fp.includes(`From ${reviewFile} (verbatim):`))
  assert.match(fp, /Critical and Important issues and its ❌ spec-compliance items/)
  assert.match(fp, /- src\/cli\.mjs:20 — list prints a trailing space/)
  assert.match(fp, /Added by the controller:\n\n- ⚠️ confirmed: rm does not drop tags/)
  // Every --findings is kept, in order — the last one alone once dropped a security finding.
  const two = run('dispatch.mjs', ['implementer', r.rel, '--task', '1', '--round', '1', '--findings-file', reviewFile, '--findings', '- ⚠️ first: rm does not drop tags', '--findings', '- ⚠️ second: a member can read drafts'], { cwd: r.root })
  assert.equal(two.status, 0, two.stderr)
  assert.match(readText(pathFrom(two)), /Added by the controller:\n\n- ⚠️ first: rm does not drop tags\n\n- ⚠️ second: a member can read drafts/)
  const files = run('dispatch.mjs', ['implementer', r.rel, '--task', '1', '--round', '1', '--findings-file', reviewFile, '--findings-file', reviewFile], { cwd: r.root })
  assert.notEqual(files.status, 0)
  assert.match(files.stderr, /one --findings-file per dispatch/)
  commitTask(r, 'src/cli.mjs', 'fix(note-tags): review round 1')
  const rr = run('dispatch.mjs', ['re-review', r.rel, '--task', '1', '--round', '1', '--findings-file', reviewFile], { cwd: r.root })
  assert.equal(rr.status, 0, rr.stderr)
  const rrp = readText(pathFrom(rr))
  assert.doesNotMatch(rrp, PLACEHOLDER)
  assert.ok(rrp.includes('- src/cli.mjs:20 — list prints a trailing space'))
  assert.ok(rr.stdout.includes(`findings: ${rel(r, join(ws, 'task-1-re-review-1.md'))}`))
  assert.ok(rrp.includes(`**Write your full report to ${join(ws, 'task-1-re-review-1.md')}**`))
  // a findings file that is missing or empty is refused, naming the fix
  const none = run('dispatch.mjs', ['implementer', r.rel, '--task', '1', '--round', '2', '--findings-file', join(ws, 'task-1-re-review-1.md')], { cwd: r.root })
  assert.equal(none.status, 1)
  assert.match(none.stderr, /no findings in .*task-1-re-review-1\.md/)
})

test('dispatch final-review: the feature\'s own folder (PLAN, SPEC, MANIFEST) is in the stat but not the diff', () => {
  const r = leanRepo('note-tags')
  commitTask(r)
  writeFileSync(join(r.folder, 'PLAN.md'), readText(join(r.folder, 'PLAN.md')) + '\nPLAN-ONLY-MARKER\n')
  git(r.root, 'add', '-A')
  git(r.root, 'commit', '-qm', 'docs: plan')
  assert.equal(run('dispatch.mjs', ['final-review', r.rel], { cwd: r.root }).status, 0)
  const diff = readText(join(WS(r), 'review-final.diff'))
  assert.match(diff, /## Files changed[\s\S]*PLAN\.md/)
  assert.match(diff, /\(left out of the diff: docs\/features\/note-tags\)/)
  assert.match(diff, /\+\/\/ feat\(note-tags\)/)
  assert.doesNotMatch(diff, /PLAN-ONLY-MARKER/)
})

test('dispatch implementer --final: the final review\'s one fix wave from final-review.md; the re-review --final reads its brief', () => {
  const r = leanRepo('note-tags')
  const ws = WS(r)
  commitTask(r)
  assert.equal(run('dispatch.mjs', ['implementer', r.rel, '--final'], { cwd: r.root }).status, 1, 'no final review recorded yet')
  const fr = run('dispatch.mjs', ['final-review', r.rel], { cwd: r.root })
  assert.ok(fr.stdout.includes(`findings: ${rel(r, join(ws, 'final-review.md'))}`))
  assert.ok(readText(pathFrom(fr)).includes(`**Write your full report to ${join(ws, 'final-review.md')}**`))
  writeFileSync(join(ws, 'final-review.md'), '### Issues\n#### Important (Should Fix)\n- src/cli.mjs:3 — tags not sorted\n')
  const out = run('dispatch.mjs', ['implementer', r.rel, '--final'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  assert.match(pathFrom(out), /dispatch-implementer-final-fix\.md$/)
  const p = readText(pathFrom(out))
  assert.doesNotMatch(p, PLACEHOLDER)
  assert.match(p, /^You are implementing the final review's fixes for note-tags\n/)
  assert.match(p, /you are the ONE fix wave/)
  assert.match(p, /Subject: `fix\(note-tags\): final review findings`/)
  assert.ok(p.includes(join(ws, 'final-fix-report.md')))
  const brief = readText(join(ws, 'final-fix-brief.md'))
  assert.match(brief, /- src\/cli\.mjs:3 — tags not sorted/)
  assert.match(brief, /## §Contract — /)
  assert.match(brief, /## Global constraints \(the project config's, verbatim\)/)
  commitTask(r, 'src/cli.mjs', 'fix(note-tags): final review findings')
  const rr = run('dispatch.mjs', ['re-review', r.rel, '--final', '--round', '1', '--findings-file', join(ws, 'final-review.md')], { cwd: r.root })
  assert.equal(rr.status, 0, rr.stderr)
  const rrp = readText(pathFrom(rr))
  assert.ok(rrp.includes(`Read the task brief: ${join(ws, 'final-fix-brief.md')}`))
  assert.ok(rr.stdout.includes(`findings: ${rel(r, join(ws, 'final-re-review.md'))}`))
})

test('dispatch final-review: merge-base..HEAD package, the ledger\'s deferred and parked lines, the SPEC path, the Why', () => {
  const r = leanRepo('note-tags')
  const ws = WS(r)
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'progress.md'), '# builder ledger — plan: docs/features/note-tags/PLAN.md\nTask 1: complete (commits a..b, review clean)\nTask 1: minor (deferred): show calls tagsOf twice\nTask 2: parked — trailing newline — Ruling: matches today\n')
  const base = git(r.root, 'merge-base', 'main', 'HEAD').slice(0, 7)
  commitTask(r)
  const out = run('dispatch.mjs', ['final-review', r.rel], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  const p = readText(pathFrom(out))
  assert.doesNotMatch(p, PLACEHOLDER)
  assert.match(p, /Task 1: minor \(deferred\): show calls tagsOf twice\nTask 2: parked — trailing newline/)
  assert.doesNotMatch(p, /Task 1: complete/)
  assert.ok(p.includes(`The spec: ${join(r.folder, 'SPEC.md')}.`))
  assert.match(p, /Notes in the `notes` CLI are a flat list today/)
  assert.match(p, /Apps: notes\./)
  assert.ok(p.includes(`**Diff file:** ${join(ws, 'review-final.diff')}`))
  assert.match(readText(join(ws, 'review-final.diff')), new RegExp(`^# Review package: ${base}`))
  assert.match(out.stdout, /model: opus/)
})

test('dispatch agent-walk: round N+1, walk=risk scope, the driver verbatim, the report contract', () => {
  const r = leanRepo('note-tags')
  const mf = join(r.folder, 'MANIFEST.md')
  writeFileSync(mf, readText(mf).replace('tests: slice=own end=risk review=end', 'tests: walk=risk review=end'))
  const ws = WS(r)
  mkdirSync(join(ws, 'agent-walk', 'round-1'), { recursive: true })
  writeFileSync(join(ws, 'agent-walk', 'round-1', 'report.md'), 'sha: abc\n')
  writeFileSync(join(ws, 'walk.md'), '# note-tags — walk script\n')
  const out = run('dispatch.mjs', ['agent-walk', r.rel], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  const p = readText(pathFrom(out))
  assert.match(pathFrom(out), /dispatch-agent-walk-round-2\.md$/)
  assert.ok(p.includes(`Read in full: ${join(ws, 'walk.md')}`))
  assert.match(p, /the CLI itself — run `node src\/cli\.mjs …` with Bash against a scratch NOTES_FILE and read what it prints/)
  assert.match(p, /every `\[risk\]` item and every step of the `## Cross-app \(verify E2E\)` section/)
  assert.match(p, /\(tests: walk=risk\)/)
  assert.match(p, /Run no tests — no test suite, no build\./)
  assert.ok(p.includes(join(ws, 'agent-walk', 'round-2') + '/'))
  assert.match(p, /first line `sha: <HEAD at walk start>`/)
  assert.match(p, /`verdict: PASS` or `verdict: PROBLEMS \(<k>\)`/)
  assert.match(p, /Never edit code, never commit, never touch the manifest or the SPEC\./)
  assert.match(p, /The project config has no §Environment landmines section\./)
  assert.match(out.stdout, /description: Agent walk round 2/)
})

test('dispatch agent-walk: round 3+ names systematic-debugging for what failed last round; no driver → UNVERIFIABLE rule; walk=none refused', () => {
  const r = leanRepo('note-tags')
  const ws = WS(r)
  writeFileSync(join(r.root, '.claude', 'builder.md'), readText(join(r.root, '.claude', 'builder.md')).replace(/^  driver: .*\n/m, ''))
  for (const n of [1, 2]) {
    mkdirSync(join(ws, 'agent-walk', `round-${n}`), { recursive: true })
    writeFileSync(join(ws, 'agent-walk', `round-${n}`, 'report.md'), 'sha: abc\n\n| # | App | Item | Result | Evidence |\n|---|---|---|---|---|\n| 3 | notes | list --tag home | FAIL — expected line 1, saw both | 03.txt |\n| 4 | notes | show | PASS | 04.txt |\n\nverdict: PROBLEMS (1)\n')
  }
  writeFileSync(join(ws, 'walk.md'), '# w\n')
  const p = readText(pathFrom(run('dispatch.mjs', ['agent-walk', r.rel], { cwd: r.root })))
  assert.ok(p.includes(join(BUILDER, 'skills', 'systematic-debugging', 'SKILL.md')))
  assert.match(p, /- 3 · notes · list --tag home/)
  assert.doesNotMatch(p, /- 4 · notes · show/)
  assert.match(p, /there is no UI driver: exercise each item through its endpoints, the server log and the database, and mark any item that can only be checked by looking at the screen `UNVERIFIABLE`/)
  const mf = join(r.folder, 'MANIFEST.md')
  writeFileSync(mf, readText(mf).replace('tests: slice=own end=risk review=end', 'tests: walk=none review=end'))
  const out = run('dispatch.mjs', ['agent-walk', r.rel], { cwd: r.root })
  assert.equal(out.status, 1)
  assert.match(out.stderr, /no walker under walk=none/)
})

test('dispatch: usage and unknown kinds', () => {
  const r = leanRepo('note-tags')
  assert.equal(run('dispatch.mjs', [], { cwd: r.root }).status, 2)
  assert.equal(run('dispatch.mjs', ['reviewer', r.rel], { cwd: r.root }).status, 2)
  assert.equal(run('dispatch.mjs', ['implementer', r.rel], { cwd: r.root }).status, 1)
})

test('dispatch agent-walk: round 2 walks only what failed, carries the passes with the diff since, and says walk by screen', () => {
  const r = leanRepo('note-tags')
  const ws = WS(r)
  const sha = git(r.root, 'rev-parse', '--short', 'HEAD')
  mkdirSync(join(ws, 'agent-walk', 'round-1'), { recursive: true })
  writeFileSync(join(ws, 'agent-walk', 'round-1', 'report.md'), `sha: ${sha}\n\n| # | App | Item | Result | Evidence |\n|---|---|---|---|---|\n| 1 | notes | add | PASS | 01.txt |\n| 3 | notes | list --tag home | FAIL — expected line 1, saw both | 03.txt |\n| 4 | notes | show | PASS | 04.txt |\n\nverdict: PROBLEMS (1)\n`)
  writeFileSync(join(ws, 'walk.md'), '# w\n')
  writeFileSync(join(r.root, 'fix.txt'), 'the fix\n')
  git(r.root, 'add', 'fix.txt')
  git(r.root, 'commit', '-qm', 'fix list --tag')
  const p = readText(pathFrom(run('dispatch.mjs', ['agent-walk', r.rel], { cwd: r.root })))
  assert.match(p, /## Round 2: walk only what the fix could change/)
  assert.match(p, /- 3 · notes · list --tag home — was FAIL — expected line 1, saw both/)
  assert.match(p, new RegExp(`Passed in round 1 at ${sha}: 1, 4\\. Re-walk one only when the fix since then changes code it exercises`))
  assert.match(p, /PASS \(carried from round 1 @ [0-9a-f]+\)/)
  assert.match(p, /fix\.txt/)
  assert.match(p, /\*\*Walk by screen\.\*\*/)
  assert.doesNotMatch(p, /systematic-debugging/, 'round 2 is a first re-walk, not yet a debugging round')
})

test('dispatch walk-batch: one brief for several features — every walk script, each report in its own round, walked by screen', () => {
  const a = leanRepo('note-tags')
  const b = leanRepo('note-tags')
  for (const r of [a, b]) {
    mkdirSync(WS(r), { recursive: true })
    writeFileSync(join(WS(r), 'walk.md'), '# w\n')
  }
  const walkRoot = mkdtempSync(join(tmpdir(), 'walk-'))
  execFileSync('git', ['init', '-q'], { cwd: walkRoot })
  const out = run('dispatch.mjs', ['walk-batch', a.folder, b.folder], { cwd: walkRoot })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /description: Agent walk — batch of 2/)
  const p = readText(pathFrom(out))
  assert.match(p, /You are the agent walker for 2 features at once/)
  assert.match(p, /## Walk by screen, across every feature/)
  for (const r of [a, b]) {
    assert.ok(p.includes(join(WS(r), 'walk.md')))
    assert.ok(p.includes(join(WS(r), 'agent-walk', 'round-1', 'report.md')))
  }
  assert.match(p, /An item fails in the feature whose walk script lists it/)
})

test('dispatch: every build dispatch names the agent it runs as — builder\'s lean agents, a recipe only the Skill tool reaches, the config\'s override', () => {
  const r = leanRepo('note-tags')
  const typeOf = (out) => /subagent_type: (\S+)/.exec(out.stdout)?.[1]
  const impl = run('dispatch.mjs', ['implementer', r.rel, '--task', '1'], { cwd: r.root })
  assert.equal(impl.status, 0, impl.stderr)
  assert.equal(typeOf(impl), 'builder:implementer', 'a builder-skill recipe is read by path')
  assert.match(impl.stdout, /^Agent call — subagent_type: builder:implementer · model: \S+ \([^)]+\) · /m)
  commitTask(r)
  assert.equal(typeOf(run('dispatch.mjs', ['task-review', r.rel, '--task', '1'], { cwd: r.root })), 'builder:reviewer')

  // A companion skill the project ships is resolved to its path; one it doesn't needs the Skill tool.
  const plan = join(r.folder, 'PLAN.md')
  const text = readText(plan)
  writeFileSync(plan, text.replace('Recipe: builder:test-driven-development\n', 'Recipe: house-cli\n'))
  assert.equal(typeOf(run('dispatch.mjs', ['implementer', r.rel, '--task', '1'], { cwd: r.root })), 'builder:implementer-skills')
  mkdirSync(join(r.root, '.claude', 'skills', 'house-cli'), { recursive: true })
  writeFileSync(join(r.root, '.claude', 'skills', 'house-cli', 'SKILL.md'), '# house cli\n')
  assert.equal(typeOf(run('dispatch.mjs', ['implementer', r.rel, '--task', '1'], { cwd: r.root })), 'builder:implementer')
  assert.match(readText(join(WS(r), 'task-1-brief.md')), /\.claude\/skills\/house-cli\/SKILL\.md {2}\(Recipe: house-cli — the project's companion skill; read it with the Read tool\)/)
  // A recipe that drives an MCP server needs an agent that has one.
  writeFileSync(join(r.root, '.claude', 'skills', 'house-cli', 'SKILL.md'), '# house cli\nLook components up with mcp__shadcn__search_items first.\n')
  assert.equal(typeOf(run('dispatch.mjs', ['implementer', r.rel, '--task', '1'], { cwd: r.root })), 'general-purpose')

  // agent_types opts back out.
  const cfg = join(r.root, '.claude', 'builder.md')
  writeFileSync(cfg, readText(cfg).replace(/^registry:/m, 'agent_types: general-purpose\nregistry:'))
  const gp = run('dispatch.mjs', ['implementer', r.rel, '--task', '1'], { cwd: r.root })
  assert.equal(typeOf(gp), 'general-purpose')
  assert.doesNotMatch(gp.stdout, /if this session has no agent/)
})

// ---- next: the bookkeeping between dispatches in one call -----------------------------------------

/** A lean repo with task 1 implemented (BASE recorded, one commit) and a stub verify.mjs that logs its calls. */
function nextRepo() {
  const r = leanRepo('note-tags')
  const stubDir = mkdtempSync(join(tmpdir(), 'verify-stub-'))
  const log = join(stubDir, 'calls.jsonl')
  const stub = join(stubDir, 'verify.mjs')
  const url = (p) => new URL(`file://${join(SCRIPTS, p)}`).href
  writeFileSync(
    stub,
    [
      `import { appendFileSync } from 'node:fs'`,
      `import { openLedger } from '${url('verify/ledger.mjs')}'`,
      `import { git, mainRoot } from '${url('verify/git.mjs')}'`,
      `const [cmd, ...rest] = process.argv.slice(2)`,
      `appendFileSync(process.env.STUB_LOG, JSON.stringify([cmd, ...rest]) + '\\n')`,
      `if (cmd === 'request') {`,
      `  const wt = rest[0]`,
      `  const req = openLedger(mainRoot(wt)).newRequest({ worktree: wt, branch: git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), sha: git(wt, 'rev-parse', rest[1]), tier: rest[rest.indexOf('--tier') + 1] })`,
      `  console.log(req.id)`,
      `}`,
      `if (cmd === 'verdict') {`,
      `  if (process.env.STUB_VERDICT_ERR) console.error(process.env.STUB_VERDICT_ERR)`,
      `  console.log(process.env.STUB_VERDICT_OUT ?? 'verify ' + rest[0] + ': no verdict')`,
      `  process.exit(+(process.env.STUB_VERDICT_EXIT ?? 5))`,
      `}`,
    ].join('\n') + '\n',
  )
  run('dispatch.mjs', ['implementer', r.rel, '--task', '1'], { cwd: r.root })
  commitTask(r)
  const env = { BUILDER_VERIFY_BIN: stub, STUB_LOG: log }
  return {
    r,
    next: (args, more = {}) => run('dispatch.mjs', ['next', r.rel, ...args], { cwd: r.root, env: { ...env, ...more } }),
    ledger: () => (existsSync(join(WS(r), 'progress.md')) ? readText(join(WS(r), 'progress.md')) : ''),
    stubCalls: (cmd) => (existsSync(log) ? readText(log).trim().split('\n').map((l) => JSON.parse(l)) : []).filter((c) => c[0] === cmd),
    setTests: (v) => {
      const mf = join(r.folder, 'MANIFEST.md')
      writeFileSync(mf, readText(mf).replace(/^tests: .*$/m, `tests: ${v}`))
    },
  }
}

test('next --close writes the ledger, files the request, prints the verdict and the next Agent call', () => {
  const { r, next, ledger, stubCalls } = nextRepo()
  const res = next(['--close', '1', '--ledger', 'Task 1: complete (commits aaaaaaa..bbbbbbb, review clean)'])
  assert.equal(res.status, 0, res.stderr)
  assert.match(ledger(), /^Task 1: complete \(commits aaaaaaa\.\.bbbbbbb, review clean\)$/m)
  const reqs = stubCalls('request')
  assert.equal(reqs.length, 1)
  assert.deepEqual(reqs[0], ['request', r.root, 'HEAD', '--tier', 'commit'])
  assert.deepEqual(stubCalls('verdict')[0], ['verdict', `builder/${r.feature}`])
  assert.match(res.stdout, /^verify builder\/note-tags: no verdict$/m)
  assert.match(res.stdout, /dispatch-implementer-task-2\.md/)
  assert.match(res.stdout, /Read .* and do what it says/)
  assert.match(res.stdout, /description: Implement Task 2: /)
})

test('next --close --model renders the next implementer on that model', () => {
  const { next } = nextRepo()
  const res = next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)', '--model', 'opus'])
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual([agentCall(res).model, agentCall(res).why], ['opus', '--model'])
})

test('next --close run twice writes one ledger line and one request', () => {
  const { next, ledger, stubCalls } = nextRepo()
  next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)'])
  const res = next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)'])
  assert.equal(res.status, 0, res.stderr)
  assert.equal((ledger().match(/^Task 1: complete/gm) ?? []).length, 1)
  assert.equal(stubCalls('request').length, 1)
  assert.match(res.stdout, /^ledger: already applied/m)
  assert.match(res.stdout, /^verify request: already applied/m)
  assert.equal(stubCalls('verdict').length, 2, 'the verdict is read every time')
  assert.match(res.stdout, /dispatch-implementer-task-2\.md/)
})

test('next --close on the last task of a phase renders no brief across the boundary', () => {
  const { next } = nextRepo()
  const lastTaskOfPhase1 = 2
  const res = next(['--close', String(lastTaskOfPhase1), '--ledger', `Task ${lastTaskOfPhase1}: complete (commits a..b, review clean)`])
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /^phase 1 closes — build §Phase close$/m)
  assert.doesNotMatch(res.stdout, /dispatch-implementer-task-\d+\.md/)
  assert.doesNotMatch(res.stdout, /Agent call/)
})

test('next --after-implement renders the review when the test plan reviews tasks', () => {
  const { next, ledger, stubCalls, setTests } = nextRepo()
  setTests('slice=own end=risk review=slice')
  const res = next(['--after-implement', '1'])
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /task-1-review/)
  assert.match(res.stdout, /description: Review Task 1 \(spec \+ quality\)/)
  assert.doesNotMatch(ledger(), /Task 1: complete/)
  assert.equal(stubCalls('request').length, 0)
})

test('next --after-implement closes with the no-review line when the test plan sets none', () => {
  const { r, next, ledger, stubCalls, setTests } = nextRepo()
  setTests('review=app')
  const base = JSON.parse(readText(join(WS(r), 'dispatch-state.json'))).tasks['1'].base
  const head = git(r.root, 'rev-parse', '--short', 'HEAD')
  const res = next(['--after-implement', '1'])
  assert.equal(res.status, 0, res.stderr)
  assert.match(ledger(), /^Task 1: complete \(commits \w+\.\.\w+, no task review \(tests: review=app\)\)$/m)
  assert.ok(ledger().includes(`Task 1: complete (commits ${base}..${head}, no task review (tests: review=app))`))
  assert.equal(stubCalls('request').length, 1)
  assert.match(res.stdout, /dispatch-implementer-task-2\.md/)
})

test('next: usage', () => {
  const { next } = nextRepo()
  assert.equal(next([]).status, 2)
  assert.equal(next(['--close', '1']).status, 2, '--close needs its --ledger line')
})

test('next --close on a batch: members ledgered first, then closing the first renders none of them and writes no second line', () => {
  // EXECUTION's task loop: a batch (tasks 1 and 2 in one dispatch) ledgers every member complete, then closes the first with next.
  const { r, next, ledger } = nextRepo()
  const member = run('advance.mjs', [r.rel, '--ledger', 'Task 2: complete (commits a..b, review clean — batched with Task 1)'], { cwd: r.root })
  assert.equal(member.status, 0, member.stderr)
  const res = next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean — batch of Tasks 1–2)'])
  assert.equal(res.status, 0, res.stderr)
  assert.doesNotMatch(res.stdout, /dispatch-implementer-task-2\.md/, 'a ledgered batch member is never dispatched again')
  assert.match(res.stdout, /^phase 1 closes — build §Phase close$/m)
  assert.equal((ledger().match(/^Task 2: complete/gm) ?? []).length, 1)
  assert.equal((ledger().match(/^Task 1: complete/gm) ?? []).length, 1)
})

test('next --close follows the phase table, not task numbers: the next member of the same phase, then the phase-close line', () => {
  const { r, next } = nextRepo()
  const plan = join(r.folder, 'PLAN.md')
  writeFileSync(plan, readText(plan).replace(/^\| 1 \| notes \| 1–2 \|/m, '| 1 | notes | 1, 3 |').replace(/^\| 2 \| notes \| 3 \|/m, '| 2 | notes | 2 |'))
  const one = next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)'])
  assert.equal(one.status, 0, one.stderr)
  assert.match(one.stdout, /dispatch-implementer-task-3\.md/)
  assert.doesNotMatch(one.stdout, /dispatch-implementer-task-2\.md/)
  const three = next(['--close', '3', '--ledger', 'Task 3: complete (commits a..b, review clean)'])
  assert.match(three.stdout, /^phase 1 closes — build §Phase close$/m)
  assert.doesNotMatch(three.stdout, /Agent call/)
})

test('next --close on a red verdict renders no brief and records no BASE; green, pending and env-broken render', () => {
  const { r, next } = nextRepo()
  const red = next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)'], { STUB_VERDICT_EXIT: '1', STUB_VERDICT_OUT: 'verify commit abc1234 builder/note-tags: RED · 1 regression · 3s' })
  assert.equal(red.status, 0, red.stderr)
  assert.match(red.stdout, /^verify commit abc1234 builder\/note-tags: RED/m)
  assert.match(red.stdout, new RegExp(`^verdict red — act on it \\(EXECUTION §5\\), then dispatch\\.mjs implementer ${r.rel} --task 2$`, 'm'))
  assert.doesNotMatch(red.stdout, /Agent call/)
  assert.equal(JSON.parse(readText(join(WS(r), 'dispatch-state.json'))).tasks['2'], undefined)
  for (const [code, out] of [['0', 'verify commit abc1234 builder/note-tags: GREEN · 3s'], ['75', 'verify builder/note-tags: pending (commit running)'], ['3', 'verify commit abc1234 builder/note-tags: ENV-BROKEN · 1 broken · 3s']]) {
    const res = next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)'], { STUB_VERDICT_EXIT: code, STUB_VERDICT_OUT: out })
    assert.equal(res.status, 0, `${code}: ${res.stderr}`)
    assert.ok(res.stdout.includes(out), code)
    assert.match(res.stdout, /dispatch-implementer-task-2\.md/, code)
  }
})

test('next --close: any other verify exit is an error carrying its stderr', () => {
  const { next } = nextRepo()
  const res = next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)'], { STUB_VERDICT_EXIT: '7', STUB_VERDICT_ERR: 'boom from verify' })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /exit 7/)
  assert.match(res.stderr, /boom from verify/)
  assert.doesNotMatch(res.stdout, /Agent call/)
})

test('next forwards --context to the next implementer render', () => {
  const { r, next } = nextRepo()
  next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)', '--context', 'Task 2 reuses tagsOf from task 1.'])
  assert.match(readText(join(WS(r), 'dispatch-implementer-task-2.md')), /Task 2 reuses tagsOf from task 1\./)
})

test('next --close: a red verdict on the last task of a phase prints the red line, then the phase-close line', () => {
  const { next } = nextRepo()
  const res = next(['--close', '2', '--ledger', 'Task 2: complete (commits a..b, review clean)'], { STUB_VERDICT_EXIT: '1', STUB_VERDICT_OUT: 'verify commit abc1234 builder/note-tags: RED · 1 regression · 3s' })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /^verdict red — act on it \(EXECUTION §5\)\nphase 1 closes — build §Phase close$/m)
  assert.doesNotMatch(res.stdout, /Agent call/)
})

test('next --close: verify exits 4 (conflict) and 6 (cancelled) print verbatim and render as pending', () => {
  const { next } = nextRepo()
  for (const [code, out] of [['4', 'verify commit abc1234 builder/note-tags: CONFLICT · 3s'], ['6', 'verify commit abc1234 builder/note-tags: CANCELLED · 0s']]) {
    const res = next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)'], { STUB_VERDICT_EXIT: code, STUB_VERDICT_OUT: out })
    assert.equal(res.status, 0, `${code}: ${res.stderr}`)
    assert.ok(res.stdout.includes(out), code)
    assert.match(res.stdout, /dispatch-implementer-task-2\.md/, code)
  }
})

test('next --close refuses a --ledger line that is not `Task <N>: complete …` for that N (exit 2), writing nothing', () => {
  const { next, ledger, stubCalls } = nextRepo()
  for (const line of ['x', 'Task 2: complete (commits a..b, review clean)', 'Task 1: done']) {
    const res = next(['--close', '1', '--ledger', line])
    assert.equal(res.status, 2, line)
    assert.match(res.stderr, /Task 1: complete/, line)
  }
  assert.doesNotMatch(ledger(), /^Task 1/m)
  assert.equal(stubCalls('request').length, 0)
})

test('next --close skips a phase member the ledger already calls complete — a batched task is never rendered again', () => {
  const { r, next } = nextRepo()
  next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)'], { STUB_VERDICT_EXIT: '1' })  // red: no render yet
  appendFileSync(join(WS(r), 'progress.md'), 'Task 2: complete (commits a..b, review clean)\n')
  const res = next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)'])
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /^phase 1 closes — build §Phase close$/m)
  assert.doesNotMatch(res.stdout, /dispatch-implementer-task-2\.md/)
  assert.doesNotMatch(res.stdout, /Agent call/)
})

test('next --close under a pause request renders nothing and prints `paused — <the pause file\'s first line>`', () => {
  const { r, next, ledger } = nextRepo()
  const fleetDir = mkdtempSync(join(tmpdir(), 'fleet-dir-'))
  mkdirSync(join(fleetDir, 'requests'))
  writeFileSync(join(fleetDir, 'requests', `${r.feature}.pause`), 'requested 2026-10-31T09:00:00Z\nsecond line\n')
  const res = next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)'], { BUILDER_FLEET_DIR: fleetDir })
  assert.equal(res.status, 0, res.stderr)
  assert.match(ledger(), /^Task 1: complete/m, 'the finished task is still ledgered')
  assert.match(res.stdout, /^paused — requested 2026-10-31T09:00:00Z$/m)
  assert.doesNotMatch(res.stdout, /Agent call|dispatch-implementer-task-2\.md|phase 1 closes/)
  // BUILDER_FLEET_DIR unset: the checkout's own .builder/fleet/requests/<feature>.pause
  mkdirSync(join(r.root, '.builder', 'fleet', 'requests'), { recursive: true })
  writeFileSync(join(r.root, '.builder', 'fleet', 'requests', `${r.feature}.pause`), 'requested here\n')
  const local = next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)'], { BUILDER_FLEET_DIR: '' })
  assert.match(local.stdout, /^paused — requested here$/m)
  assert.doesNotMatch(local.stdout, /Agent call/)
})

test('next --close past the fleet run\'s deadline closes the task but renders nothing, and says where the next run resumes', () => {
  const { next, ledger, stubCalls } = nextRepo()
  const past = new Date(Date.now() - 60000).toISOString()
  const res = next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)'], { BUILDER_RUN_DEADLINE: past })
  assert.equal(res.status, 0, res.stderr)
  assert.match(ledger(), /^Task 1: complete/m, 'the finished task is ledgered first')
  assert.equal(stubCalls('request').length, 1, 'and its commit-tier request filed')
  assert.match(res.stdout, /^time up — this run passed its time budget \(.+\): .*resumes at Task 2 from the ledger$/m)
  assert.doesNotMatch(res.stdout, /Agent call|dispatch-implementer-task-2\.md/)
  // Before the deadline, or with none set, it renders as usual.
  const { next: next2 } = nextRepo()
  const ok = next2(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)'], { BUILDER_RUN_DEADLINE: new Date(Date.now() + 3600000).toISOString() })
  assert.match(ok.stdout, /dispatch-implementer-task-2\.md/)
  assert.doesNotMatch(ok.stdout, /time up/)
})

test('next --after-implement under review=slice+second names the second review on a §Contract or §Schema task, and only there', () => {
  const { r, next, setTests } = nextRepo()
  setTests('slice=own end=risk review=slice+second')
  const plain = next(['--after-implement', '1'])
  assert.equal(plain.status, 0, plain.stderr)
  assert.match(plain.stdout, /description: Review Task 1/)
  assert.doesNotMatch(plain.stdout, /second review/i)
  const plan = join(r.folder, 'PLAN.md')
  writeFileSync(plan, readText(plan).replace('### Task 1: Tag parsing, `add --tag`, and the tagged `list` line\n', '### Task 1: Tag parsing, `add --tag`, and the tagged `list` line\nProduces: the SPEC §Schema & API changes row for the tags field.\n'))
  const touched = next(['--after-implement', '1'])
  assert.equal(touched.status, 0, touched.stderr)
  assert.match(touched.stdout, /description: Review Task 1/)
  assert.equal((touched.stdout.match(/^second review: .*$/gm) ?? []).length, 1)
  assert.match(touched.stdout, /^second review: Task 1 touches §Contract or §Schema & API changes/m)
  setTests('slice=own end=risk review=slice')
  assert.doesNotMatch(next(['--after-implement', '1']).stdout, /second review/i, 'plain slice: no second review')
})

// ---- one line per fact: relative paths, one Agent-call line with its model ------------------------

/** The one `Agent call —` line → { subagent_type, model, description, prompt }; throws unless there is exactly one. */
const agentCall = (res) => {
  const lines = res.stdout.split('\n').filter((l) => /^Agent call\b/.test(l))
  assert.equal(lines.length, 1, `exactly one Agent-call line:\n${res.stdout}`)
  assert.doesNotMatch(res.stdout, /^ {2}(subagent_type|model|prompt):/m, 'no continuation lines')
  const m = /^Agent call — subagent_type: (\S+) · model: (\S+) \(([^)]+)\) · description: (.+) · prompt: (Read \S+ and do what it says\.)$/.exec(lines[0])
  assert.ok(m, `the Agent-call line's shape: ${lines[0]}`)
  return { subagent_type: m[1], model: m[2], why: m[3], description: m[4], prompt: m[5] }
}

/** Every path a dispatch prints is relative to the repo root — except the Agent call's prompt, absolute for Read — and no `brief:` line. */
const assertCompact = (r, res) => {
  assert.equal(res.status, 0, res.stderr)
  const rest = res.stdout.replace(/ · prompt: Read \S+ and do what it says\./g, '')
  assert.ok(!rest.includes(r.root), `no absolute path but the prompt's:\n${res.stdout}`)
  for (const m of res.stdout.matchAll(/ · prompt: Read (\S+) and/g)) assert.ok(m[1].startsWith('/'), `the prompt's path is absolute: ${m[1]}`)
  assert.doesNotMatch(res.stdout, /^brief:/m)
  assert.doesNotMatch(res.stdout, /^\s*\//m)
}

test('modelFor: EXECUTION §Model selection as a table — every kind, the tiny recipe, the fix-loop escalation and the models lever', () => {
  const cases = [
    // [kind, opts, model]
    ['implementer', {}, 'sonnet'], // integration and judgment: a standard model (the mid-tier floor)
    ['implementer', { tiny: true }, 'haiku'], // Recipe says tiny: the cheapest tier
    ['implementer', { round: 1 }, 'sonnet'], // rounds 1–3 resume the same implementer
    ['implementer', { round: 3 }, 'sonnet'],
    ['implementer', { round: 4 }, 'opus'], // rounds 4–5: one tier above the implementer that got stuck
    ['implementer', { round: 5 }, 'opus'],
    ['implementer', { tiny: true, round: 2 }, 'haiku'],
    ['implementer', { tiny: true, round: 4 }, 'sonnet'],
    ['implementer', { models: 'economy' }, 'haiku'], // integration drops to the cheapest tier
    ['implementer', { models: 'economy', round: 4 }, 'sonnet'],
    ['implementer', { models: 'strong' }, 'opus'], // integration on the most capable
    ['implementer', { models: 'strong', round: 4 }, 'opus'], // nothing above the top
    ['implementer', { models: 'strong', tiny: true }, 'haiku'], // mechanical stays the cheapest
    ['final-fix', {}, 'sonnet'], // a standard model at least: the wave spans the branch
    ['final-fix', { models: 'economy' }, 'sonnet'],
    ['final-fix', { models: 'strong' }, 'opus'],
    ['task-review', {}, 'sonnet'], // reviews: mid-tier floor
    ['task-review', { tiny: true }, 'haiku'], // tiny: the cheapest tier that can read a diff
    ['task-review', { models: 'economy' }, 'sonnet'],
    ['task-review', { models: 'strong' }, 'opus'], // strong: every review on the most capable
    ['task-review', { models: 'strong', tiny: true }, 'opus'],
    ['phase-review', {}, 'sonnet'],
    ['phase-review', { models: 'strong' }, 'opus'],
    ['re-review', {}, 'sonnet'], // cheap-to-mid for a small fix diff, at the reviewers' mid-tier floor
    ['re-review', { round: 5 }, 'sonnet'],
    ['re-review', { models: 'strong' }, 'opus'],
    ['final-review', {}, 'opus'], // the most capable available
    ['final-review', { models: 'economy' }, 'opus'],
    ['agent-walk', {}, 'opus'], // REFERENCE §Agent model tiering
    ['walk-batch', {}, 'opus'],
  ]
  for (const [kind, opts, model] of cases) assert.equal(modelFor({ kind, ...opts }), model, `${kind} ${JSON.stringify(opts)}`)
  assert.throws(() => modelFor({ kind: 'nope' }), /no model tier for kind nope/)
})

test('dispatch: every kind prints paths relative to the repo root, no brief: line, and one Agent-call line naming subagent_type and the model §Model selection picks', () => {
  const r = leanRepo('note-tags')
  const ws = WS(r)
  const call = (args, check = {}) => {
    const res = run('dispatch.mjs', args, { cwd: r.root })
    assertCompact(r, res)
    const a = agentCall(res)
    for (const [k, v] of Object.entries(check)) assert.equal(a[k], v, `${args.join(' ')} → ${k}`)
    assert.ok(existsSync(resolve(r.root, /^Read (\S+)/.exec(a.prompt)[1])), 'the prompt names the file, absolutely')
    return { res, a }
  }
  const { res: impl } = call(['implementer', r.rel, '--task', '1'], { subagent_type: 'builder:implementer', model: 'sonnet', prompt: `Read ${join(ws, 'dispatch-implementer-task-1.md')} and do what it says.` })
  assert.match(impl.stdout, /^wrote \.builder\/note-tags\/dispatch-implementer-task-1\.md · BASE [0-9a-f]{7} recorded for task 1$/m)
  call(['implementer', r.rel, '--task', '2'], { model: 'haiku' }) // Recipe: … · tiny
  commitTask(r)
  const { res: rev } = call(['task-review', r.rel, '--task', '1'], { subagent_type: 'builder:reviewer', model: 'sonnet' })
  assert.match(rev.stdout, /^findings: \.builder\/note-tags\/task-1-review\.md$/m)
  writeFileSync(join(ws, 'task-1-review.md'), '#### Important\n- src/cli.mjs:1 — x\n')
  for (const n of [1, 2, 3]) call(['implementer', r.rel, '--task', '1', '--round', String(n), '--findings-file', join(ws, 'task-1-review.md')], { model: 'sonnet' })
  call(['implementer', r.rel, '--task', '1', '--round', '4', '--findings-file', join(ws, 'task-1-review.md')], { model: 'opus' })
  call(['implementer', r.rel, '--task', '2', '--round', '4', '--findings', '- y'], { model: 'sonnet' })
  commitTask(r, 'src/cli.mjs', 'fix(note-tags): round 1')
  call(['re-review', r.rel, '--task', '1', '--round', '1', '--findings-file', join(ws, 'task-1-review.md')], { subagent_type: 'builder:reviewer', model: 'sonnet' })
  call(['task-review', r.rel, '--phase', '1'], { subagent_type: 'builder:reviewer', model: 'sonnet' })
  call(['final-review', r.rel], { subagent_type: 'builder:reviewer', model: 'opus' })
  writeFileSync(join(ws, 'final-review.md'), '#### Important\n- src/cli.mjs:3 — z\n')
  call(['implementer', r.rel, '--final'], { subagent_type: 'builder:implementer', model: 'sonnet' })
  commitTask(r, 'src/cli.mjs', 'fix(note-tags): final')
  call(['re-review', r.rel, '--final', '--round', '1', '--findings-file', join(ws, 'final-review.md')], { model: 'sonnet' })
  writeFileSync(join(ws, 'walk.md'), '# w\n')
  call(['agent-walk', r.rel], { subagent_type: 'general-purpose', model: 'opus' })

  // the models lever moves the tier exactly as §Model selection's economy / strong lines say
  const mf = join(r.folder, 'MANIFEST.md')
  writeFileSync(mf, readText(mf).replace(/^tests: .*$/m, 'tests: walk=risk review=slice models=strong'))
  call(['implementer', r.rel, '--task', '1'], { model: 'opus' })
  call(['task-review', r.rel, '--task', '1'], { model: 'opus' })
  writeFileSync(mf, readText(mf).replace(/^tests: .*$/m, 'tests: walk=risk review=slice models=economy'))
  call(['implementer', r.rel, '--task', '1'], { model: 'haiku' })
  call(['task-review', r.rel, '--task', '1'], { model: 'sonnet' })
})

test('dispatch walk-batch: one Agent-call line on the most capable model, paths relative to the walk root', () => {
  const a = leanRepo('note-tags')
  mkdirSync(WS(a), { recursive: true })
  writeFileSync(join(WS(a), 'walk.md'), '# w\n')
  const walkRoot = realpathSync(mkdtempSync(join(tmpdir(), 'walk-')))
  execFileSync('git', ['init', '-q'], { cwd: walkRoot })
  const res = run('dispatch.mjs', ['walk-batch', a.folder], { cwd: walkRoot })
  assertCompact({ root: walkRoot }, res)
  const call = agentCall(res)
  assert.equal(call.subagent_type, 'general-purpose')
  assert.equal(call.model, 'opus')
  assert.match(call.prompt, /^Read \/\S*\/\.builder\/_walk\/dispatch-walk-batch\.md and do what it says\.$/)
})

test('next --close mid-phase: at most 6 lines — the ledger, the request, the verdict, the file written, the Agent call', () => {
  const { r, next } = nextRepo()
  const res = next(['--close', '1', '--ledger', 'Task 1: complete (commits a..b, review clean)'], { STUB_VERDICT_EXIT: '0', STUB_VERDICT_OUT: 'verify commit abc1234 builder/note-tags: GREEN · 3s' })
  assertCompact(r, res)
  const lines = res.stdout.trimEnd().split('\n')
  assert.ok(lines.length <= 6, `≤ 6 lines, got ${lines.length}:\n${res.stdout}`)
  assert.equal(lines[0], 'ledger: +1 line')
  assert.equal(agentCall(res).model, 'haiku', 'task 2 is tiny')
})

test('dispatch: the printed model says why — the default and its reason, the tiny recipe', () => {
  const r = leanRepo('note-tags')
  const one = agentCall(run('dispatch.mjs', ['implementer', r.rel, '--task', '1'], { cwd: r.root }))
  assert.deepEqual([one.model, one.why], ['sonnet', 'default'])
  const two = agentCall(run('dispatch.mjs', ['implementer', r.rel, '--task', '2'], { cwd: r.root }))
  assert.deepEqual([two.model, two.why], ['haiku', 'default — tiny'])
  assert.match(run('dispatch.mjs', ['implementer', r.rel, '--task', '2'], { cwd: r.root }).stdout, / · model: haiku \(default — tiny\) · /)
})

test('dispatch: --model overrides the printed model and is recorded; rounds 1–3 name it, rounds 4–5 escalate from it', () => {
  const r = leanRepo('note-tags')
  const ws = WS(r)
  const over = agentCall(run('dispatch.mjs', ['implementer', r.rel, '--task', '2', '--model', 'sonnet'], { cwd: r.root }))
  assert.deepEqual([over.model, over.why], ['sonnet', '--model'])
  assert.equal(JSON.parse(readText(join(ws, 'dispatch-state.json'))).tasks['2'].model, 'sonnet', 'the model that ran is recorded')
  const r1 = agentCall(run('dispatch.mjs', ['implementer', r.rel, '--task', '2', '--round', '1', '--findings', '- x'], { cwd: r.root }))
  assert.equal(r1.model, 'sonnet', 'a resumed round names the model that ran')
  const r4 = agentCall(run('dispatch.mjs', ['implementer', r.rel, '--task', '2', '--round', '4', '--findings', '- x'], { cwd: r.root }))
  assert.deepEqual([r4.model, r4.why], ['opus', 'one tier above sonnet, round 4'])
  // no override: the default is recorded, and escalation starts from it
  run('dispatch.mjs', ['implementer', r.rel, '--task', '1'], { cwd: r.root })
  assert.equal(JSON.parse(readText(join(ws, 'dispatch-state.json'))).tasks['1'].model, 'sonnet')
  // a bad tier is refused
  const bad = run('dispatch.mjs', ['implementer', r.rel, '--task', '1', '--model', 'gpt'], { cwd: r.root })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /--model must be one of haiku, sonnet, opus/)
})

test('dispatch: --model is raise-only — a tier below the default is refused for the final review, the agent walk and an implementer', () => {
  const r = leanRepo('note-tags')
  commitTask(r)
  const ws = WS(r)
  mkdirSync(join(ws, 'agent-walk', 'round-1'), { recursive: true })
  writeFileSync(join(ws, 'agent-walk', 'round-1', 'report.md'), 'sha: abc\n')
  writeFileSync(join(ws, 'walk.md'), '# note-tags — walk script\n')
  for (const [args, low] of [[['final-review', r.rel], 'sonnet'], [['agent-walk', r.rel], 'haiku'], [['implementer', r.rel, '--task', '1'], 'haiku']]) {
    const bad = run('dispatch.mjs', [...args, '--model', low], { cwd: r.root })
    assert.equal(bad.status, 1, `${args[0]} --model ${low}`)
    assert.match(bad.stderr, /--model only raises/, args[0])
  }
  // the default tier itself, or above it, is accepted
  assert.equal(run('dispatch.mjs', ['final-review', r.rel, '--model', 'opus'], { cwd: r.root }).status, 0)
  assert.equal(agentCall(run('dispatch.mjs', ['implementer', r.rel, '--task', '1', '--model', 'opus'], { cwd: r.root })).model, 'opus')
})

test('dispatch implementer: the brief carries the config\'s §Environment landmines and the ledger\'s env notes; with neither it carries neither', () => {
  const bare = leanRepo('note-tags')
  assert.equal(run('dispatch.mjs', ['implementer', bare.rel, '--task', '1'], { cwd: bare.root }).status, 0)
  const b0 = readText(join(WS(bare), 'task-1-brief.md'))
  assert.doesNotMatch(b0, /Environment landmines|Environment notes/)

  const r = leanRepo('note-tags')
  const cfg = join(r.root, '.claude', 'builder.md')
  writeFileSync(cfg, `${readText(cfg).replace(/\s+$/, '')}\n\n## Environment landmines\n\n- Port 5432 is the dev DB; never run tests against it.\n`)
  mkdirSync(WS(r), { recursive: true })
  // The ledger is append-only: completions, rulings and minors follow the env notes with no closing heading.
  writeFileSync(join(WS(r), 'progress.md'), `# builder ledger — plan: ${r.rel}/PLAN.md\n\n## env notes (the orchestrator's)\n- node 20 needs --experimental-vm-modules for the suite\n- the seed script must run before the first test\nTask 1: complete (commit abc1234)\nRuling: R1 — not an env note\n- Task 2: minor (deferred): not an env note\n`)
  const out = run('dispatch.mjs', ['implementer', r.rel, '--task', '1'], { cwd: r.root })
  assert.equal(out.status, 0, out.stderr)
  const b = readText(join(WS(r), 'task-1-brief.md'))
  assert.match(b, /## Environment landmines \(the project config's, verbatim\)\n\n- Port 5432 is the dev DB; never run tests against it\./)
  assert.match(b, /## Environment notes \(the ledger's\)\n\n- node 20 needs --experimental-vm-modules for the suite\n- the seed script must run before the first test\n/)
  assert.doesNotMatch(b, /not an env note|Task 1: complete/)
})

test('dispatch implementer: env notes written later in the build reach the brief — every bullet under any env notes heading', () => {
  const r = leanRepo('note-tags')
  mkdirSync(WS(r), { recursive: true })
  writeFileSync(
    join(WS(r), 'progress.md'),
    `# builder ledger — plan: ${r.rel}/PLAN.md\n\n## env notes\n- the seed script must run before the first test\nTask 1: complete (commit abc1234)\n- Task 2: minor (deferred): not an env note\n\n## env notes (found in task 2)\n- port 4100 is taken by the walk env; the suite uses 4200\n  (set PORT=4200)\nTask 2: complete (commit def5678)\n`,
  )
  assert.equal(run('dispatch.mjs', ['implementer', r.rel, '--task', '1'], { cwd: r.root }).status, 0)
  const b = readText(join(WS(r), 'task-1-brief.md'))
  assert.match(b, /## Environment notes \(the ledger's\)\n\n- the seed script must run before the first test\n- port 4100 is taken by the walk env; the suite uses 4200\n {2}\(set PORT=4200\)\n/)
  assert.doesNotMatch(b, /not an env note|Task 2: complete/)
})

test('dispatch implementer: the ledger\'s env notes are capped in the brief, pointing at the ledger for the rest', () => {
  const r = leanRepo('note-tags')
  mkdirSync(WS(r), { recursive: true })
  const notes = Array.from({ length: 60 }, (_, i) => `- note ${i}: ${'x'.repeat(60)}`).join('\n')
  writeFileSync(join(WS(r), 'progress.md'), `# builder ledger — plan: ${r.rel}/PLAN.md\n\n## env notes\n${notes}\n`)
  assert.equal(run('dispatch.mjs', ['implementer', r.rel, '--task', '1'], { cwd: r.root }).status, 0)
  const b = readText(join(WS(r), 'task-1-brief.md'))
  const block = b.slice(b.indexOf("## Environment notes (the ledger's)"))
  assert.match(block, /- note 0:/)
  assert.doesNotMatch(block, /- note 59:/)
  assert.match(block, /… see the ledger/)
  assert.ok(block.split('\n\n')[1].length <= 2100, `${block.split('\n\n')[1].length}`)
})
