import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { draftRows } from '../brainstorm-file.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
// resume's SKILL.md plus AGENT-MODE.md, which holds its --agent-walk sections since 5.0.
const resumeAll = () => read('skills/resume/SKILL.md') + '\n' + read('skills/resume/AGENT-MODE.md')

test('CONVERSATION.md carries every section the two conversation skills cite', () => {
  const c = read('skills/brainstorm/CONVERSATION.md')
  for (const s of ['The record', 'Rounds', 'Approaches', 'Confirm', 'Size and the small path', 'Steering and --auto']) assert.match(c, new RegExp(`^## ${s}$`, 'm'), s)
  for (const v of ['exploring', 'confirmed', 'sized', 'parked', 'handed-off']) assert.match(c, new RegExp(`\\b${v}\\b`), v)
  for (const v of ['open', 'settled', 'assumed', 'stated', 'confirmed', 'contradicted', 'unverifiable']) assert.match(c, new RegExp(`\\b${v}\\b`), v)
})

test('REFERENCE §SPEC.md opens with §Idea and keeps rulings operational', () => {
  const r = read('skills/resume/REFERENCE.md')
  const spec = r.slice(r.indexOf('## SPEC.md'), r.indexOf('### §Apps'))
  assert.ok(spec.indexOf('## Idea') > 0 && spec.indexOf('## Idea') < spec.indexOf('## Apps'), '§Idea comes before §Apps')
  assert.doesNotMatch(spec, /^## Overview/m)
  assert.match(spec, /In your words/)
  assert.match(spec, /Target ≤ 350 lines/)
  assert.match(spec, /why the rejected option lost/)
  assert.match(spec, /NEVER quote the user's prompt as the ruling/)
})

test('brainstorm is the exploration conversation: no REFERENCE load, no design flag, sizing after confirm', () => {
  const b = read('skills/brainstorm/SKILL.md')
  assert.match(b, /^name: brainstorm$/m)
  assert.match(b, /CONVERSATION\.md/)
  assert.doesNotMatch(b, /Load REFERENCE/)
  assert.doesNotMatch(b, /Phase 1P|Prototype mode|design\.resolver/)
  assert.match(b, /\/builder:intake/)
  assert.match(b, /\/builder:spec/)
  assert.ok(b.indexOf('## Intent') < b.indexOf('## Size'), 'intent comes before sizing')
})

test('intake verifies claims, owns prototype mode, and shares the record', () => {
  const i = read('skills/intake/SKILL.md')
  assert.match(i, /^name: intake$/m)
  assert.match(i, /CONVERSATION\.md/)
  for (const s of ['confirmed', 'contradicted', 'unverifiable', 'stated']) assert.match(i, new RegExp(`\\b${s}\\b`))
  assert.match(i, /SCOPE-SELECTION\.md/)
  assert.match(i, /source: intake/)
  assert.match(i, /\/builder:spec/)
  for (const re of [/DONE check/, /never REFERENCE wholesale/, /replaces §1–§3/, /§Prototype seams/]) assert.match(i, re)
})

test("intake's confirmed decisions become rulings; only its claims about the code leave §Decisions", () => {
  const i = read('skills/intake/SKILL.md')
  assert.match(i, /`decision`.*`requirement`.*`constraint`.*`non-goal`.*`claim`/s, 'intake tags each stated row with its kind')
  const s = read('skills/spec/SKILL.md')
  assert.match(s, /`confirmed` `decision`, `requirement`, `constraint` or `non-goal` row[^.]*§Decisions/s)
  assert.match(s, /`confirmed` `claim`[^.]*§Idea[^.]*never to §Decisions/s)
  assert.match(s, /`confirmed` row with no kind tag[\s\S]*?OPEN §Decisions row/, 'an untagged row has a defined route')
  assert.match(i, /A row without a kind is incomplete/)
  assert.doesNotMatch(s, /A `confirmed` row from intake is a fact, not a\s+choice/)
})

test('spec needs a sized record, loads REFERENCE, writes §Idea first and hands off', () => {
  const s = read('skills/spec/SKILL.md')
  assert.match(s, /^name: spec$/m)
  assert.match(s, /status: sized/)
  assert.match(s, /Load REFERENCE/)
  assert.match(s, /§Idea/)
  assert.match(s, /check-obligations\.mjs/)
  assert.match(s, /handed-off/)
  assert.match(s, /\/builder:resume --path/)
  assert.match(s, /confirmed/)
  assert.match(s, /OPEN/)
  assert.match(s, /sized xl/)
  assert.match(s, /contradicted/)
  assert.match(s, /fixed in the design/)
  assert.doesNotMatch(s, /--size xl/)
})

test('no skill routes a design ref to brainstorm; resume knows the record; help names the entries', () => {
  for (const dir of readdirSync(join(ROOT, 'skills'))) {
    const p = `skills/${dir}/SKILL.md`
    if (!existsSync(join(ROOT, p))) continue
    assert.doesNotMatch(read(p), /\/builder:brainstorm --<(design\.)?flag>/, p)
  }
  const r = resumeAll()
  assert.match(r, /brainstorm\.md/)
  assert.match(r, /\/builder:spec/)
  assert.match(r, /\/builder:intake/)
  const h = read('skills/help/SKILL.md')
  assert.match(h, /\/builder:intake/)
  assert.match(h, /\/builder:spec/)
  // The release on plugin.json is the newest one the changelog describes.
  const version = JSON.parse(read('.claude-plugin/plugin.json')).version
  assert.equal(/^## (\d+\.\d+\.\d+)$/m.exec(read('CHANGELOG.md'))?.[1], version)
  const sizeDocs = readdirSync(join(ROOT, 'skills')).map((d) => `skills/${d}/SKILL.md`).filter((p) => existsSync(join(ROOT, p)))
  for (const p of [...sizeDocs, 'skills/resume/REFERENCE.md', 'README.md']) assert.doesNotMatch(read(p), /--size\b/, p)
})

test('every status value is handled somewhere, and every section cited in CONVERSATION.md exists', () => {
  // The two readers that branch on a record's status: draftRows() (the picker and /builder:status) and
  // resume Step 1's brainstorm.md rule. exploring and confirmed have no branch of their own in either —
  // they take the fall-through back to the conversation — so that fall-through is what is asserted.
  const tmp = mkdtempSync(join(tmpdir(), 'builder-status-'))
  try {
    const statuses = { exploring: 'exploring', confirmed: 'confirmed', parked: 'parked', md: 'sized md', sm: 'sized sm', done: 'handed-off' }
    for (const [name, status] of Object.entries(statuses)) {
      mkdirSync(join(tmp, '.builder', name), { recursive: true })
      writeFileSync(join(tmp, '.builder', name, 'brainstorm.md'), `# ${name} — brainstorm\nstatus: ${status}\nsource: brainstorm\nsettled: 1 of 2\n\n## Intent\n`)
    }
    const rows = Object.fromEntries(draftRows(tmp, 'docs/features').map((r) => [r.feature, r]))
    assert.equal(rows.exploring.command, '/builder:brainstorm --path docs/features/exploring', 'exploring')
    assert.equal(rows.confirmed.command, '/builder:brainstorm --path docs/features/confirmed', 'confirmed')
    assert.match(rows.parked.state, /^parked/, 'parked')
    assert.equal(rows.md.command, '/builder:spec --path docs/features/md', 'sized md')
    assert.equal(rows.sm.command, '/builder:brainstorm --path docs/features/sm', 'sized sm')
    assert.equal(rows.done, undefined, 'handed-off is skipped')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  const r = resumeAll()
  const rule = r.slice(r.indexOf('**No registry folder, but a `.builder/<feature>/brainstorm.md`**'), r.indexOf('**No `MANIFEST.md`**'))
  assert.match(rule, /`sized md\|lg\|xl` → `\/builder:spec --path <folder>`/, 'resume: sized md+')
  assert.match(rule, /`handed-off`\s+→ nothing to resume/, 'resume: handed-off')
  assert.match(rule, /any other status →/, 'resume: exploring, confirmed, parked, sized xs|sm fall through to the conversation')
  // Real headings only: the record template's fenced `## Intent … ## Size` are not sections of the file.
  const conv = read('skills/brainstorm/CONVERSATION.md').replace(/```[\s\S]*?```/g, '')
  const headings = conv.match(/^## .+$/gm).map((h) => h.slice(3).trim())
  // A citation is a chain — `CONVERSATION §Approaches, §Confirm and §Size and the small path` — and a
  // section name may itself contain " and", so each link must START with a real heading (longest wins).
  let cited = 0
  for (const p of ['brainstorm/SKILL.md', 'intake/SKILL.md']) {
    const text = read(`skills/${p}`).replace(/\s+/g, ' ')
    for (const m of text.matchAll(/CONVERSATION §/g)) {
      let rest = text.slice(m.index + m[0].length)
      for (;;) {
        const h = headings.filter((x) => rest.startsWith(x) && !/[A-Za-z]/.test(rest[x.length] ?? '')).sort((a, b) => b.length - a.length)[0]
        assert.ok(h, `${p} cites CONVERSATION §${rest.slice(0, 40)}`)
        cited++
        rest = rest.slice(h.length)
        const link = /^(?:,| and|, and) §/.exec(rest)
        if (!link) break
        rest = rest.slice(link[0].length)
      }
    }
  }
  assert.ok(cited >= 9, `found ${cited} CONVERSATION citations`)
})

test('the classifier runs on the confirmed concept, and --auto carries a confirmed concept on to /builder:spec', () => {
  const r = read('skills/resume/REFERENCE.md')
  const cls = r.slice(r.indexOf('## The classifier'), r.indexOf('1. Does the flow'))
  assert.doesNotMatch(cls, /before any question/)
  assert.match(cls, /confirmed concept/)
  const c = read('skills/brainstorm/CONVERSATION.md')
  const auto = c.slice(c.indexOf('## Steering and --auto'))
  assert.match(auto, /Build it/)
  assert.match(auto, /\/builder:spec[^\n]*--auto/)
})

test('no picker offers a conversation in progress except resume, brainstorm and spec', () => {
  // A `layout: brainstorm` row has no spec: revise and agent say they leave them out; every other
  // picker filters on a manifest state, which a conversation has none of.
  for (const p of ['skills/revise/SKILL.md', 'skills/agent/SKILL.md']) assert.match(read(p), /`layout: brainstorm`/, p)
  const allowed = new Set(['resume', 'brainstorm', 'spec', 'revise', 'agent'])
  for (const dir of readdirSync(join(ROOT, 'skills'))) {
    const p = `skills/${dir}/SKILL.md`
    if (allowed.has(dir) || !existsSync(join(ROOT, p))) continue
    const s = read(p).replace(/\s+/g, ' ')
    for (const m of s.matchAll(/list-features\.mjs --json/g)) {
      const around = s.slice(m.index, m.index + 200)
      assert.match(around, /only the folders|manifest|manifests at|state:/, `${p}: its picker filters on a manifest`)
    }
  }
})

test('brainstorm asks one question at a time, briefed, with a marked recommendation', () => {
  const c = read('skills/brainstorm/CONVERSATION.md')
  assert.match(c, /One question per turn, by default/)
  assert.match(c, /\*\*Why it matters:\*\*/)
  assert.match(c, /\*\*What it affects:\*\*/)
  assert.match(c, /\*\*Why <the recommended label>:\*\*/)
  assert.match(c, /` \(Recommended\)` on its label/)
  assert.match(c, /never add a "something else"\s+option/)
  assert.match(c, /Several at once, only when they are independent and quick/)
  assert.doesNotMatch(c, /Ask the whole frontier each round/, 'no batch-dump of the frontier')
  assert.doesNotMatch(c, /❓ \*\*Q1/, 'no numbered prose questions')
})

test("brainstorm grounds the user's terms in the code before it plays back or asks", () => {
  const c = read('skills/brainstorm/CONVERSATION.md')
  assert.match(c, /^## Grounding$/m)
  assert.match(c, /A question is the last resort/)
  assert.match(c, /issue_date.*issueDate.*IssueDate/s, 'every spelling is searched')
  assert.match(c, /one rung at a\s+time/)
  assert.match(c, /The fast pass — seconds, every term/)
  assert.match(c, /Dig — only when 1 and 2 left a term unclear/)
  assert.ok(c.indexOf('The fast pass') < c.indexOf('Explore agent'), 'agents are the last rung, not the first')
  assert.match(c, /Several candidates.*ask with them as the options/s)
  assert.match(c, /The self-check before every question/)
  const b = read('skills/brainstorm/SKILL.md')
  assert.match(b, /Ground it in the code before your first word back/)
  assert.match(b, /Look it up yourself, fast pass first/)
  assert.doesNotMatch(b, /\*\*wait for them\*\*/, 'grounding never blocks on agents')
  assert.ok(b.indexOf('Ground it in the code') < b.indexOf('Play back the intent'), 'grounding comes before the playback')
  assert.doesNotMatch(b, /Start recon in parallel[^\n]*\n[^\n]*it never holds up this turn/, 'grounding is not the non-blocking recon')
})

test('statusline: the skill drives the installer, help names it, and vendored copies carry it', () => {
  const s = read('skills/statusline/SKILL.md')
  assert.match(s, /^name: statusline$/m)
  assert.match(s, /scripts\/statusline-install\.mjs/)
  assert.match(read('skills/help/SKILL.md'), /\/builder:statusline/)
  assert.match(read('docs/guide.md'), /^## Live progress in the status line$/m)
  for (const f of ['statusline.mjs', 'statusline-launcher.mjs', 'statusline-install.mjs']) assert.ok(existsSync(join(ROOT, 'scripts', f)), f)
})

test('agent mode: build writes the E steps, agent-walk reports them, verify quotes them only on unchanged code', () => {
  const HEAD = '## Cross-app (verify E2E)'
  const build = read('skills/build/SKILL.md')
  const walk = read('skills/agent-walk/SKILL.md')
  const verify = read('skills/verify/SKILL.md')
  for (const [name, s] of [['build', build], ['agent-walk', walk], ['verify', verify]]) assert.ok(s.includes(HEAD), `${name} names ${HEAD}`)
  assert.match(build, /Under `--agent-walk`\*\*, append the cross-app walk[\s\S]{0,300}`E1…En`/)
  assert.match(walk, /`E<k>`/)
  // Quoted only when no code changed since the agent walk's sha; otherwise only the uncovered steps run live.
  // Against the working tree, not HEAD: uncommitted edits after the walk count as changed code (I-1).
  assert.match(verify, /git diff --quiet <walk sha> -- \. ':!<registry>'/)
  assert.doesNotMatch(verify, /git diff --quiet <walk sha> HEAD/)
  // The walk sha is the one the passing round recorded, in the round its sign-off names (I-2).
  assert.match(walk, /first line `sha: <HEAD at walk start>`/)
  assert.match(verify, /the round the `🤖 AGENT SIGNED OFF … round <n>` header names/)
  assert.match(verify, /its `sha:` line/)
  assert.match(verify, /only those steps/)
  // A gate at or under its baseline is green, in verify and in the walker's brief.
  for (const s of [verify, walk]) assert.match(s, /at or under its baseline/)
  // init recon names tracked test output.
  assert.match(read('skills/init/SKILL.md'), /test-results\//)
})

test('the fleet launches detached, never as a session background task', () => {
  const fleet = read('skills/fleet/SKILL.md')
  assert.match(fleet, /fleet\.mjs <the same arguments> --detach/)
  assert.doesNotMatch(fleet, /Run with the Bash tool's `run_in_background`/)
  assert.match(read('skills/agent/SKILL.md'), /launch detached, `--detach`/)
})

test('tidy: the skill drives inventory and tidy.mjs; status shows the repo line; help names it; no skill lands on the checked-out branch', () => {
  const tidy = read('skills/tidy/SKILL.md')
  assert.match(tidy, /^name: tidy$/m)
  assert.match(tidy, /scripts\/inventory\.mjs/)
  assert.match(tidy, /scripts\/tidy\.mjs apply/)
  assert.match(tidy, /force-delete-branch/)
  assert.match(read('skills/status/SKILL.md'), /scripts\/inventory\.mjs" --summary/)
  assert.match(read('skills/help/SKILL.md'), /\/builder:tidy/)
  for (const f of ['skills/agent/SKILL.md', 'skills/fleet/SKILL.md', 'skills/resume/SKILL.md', 'skills/resume/REFERENCE.md', 'skills/help/SKILL.md', 'README.md', 'PROJECT.template.md'])
    assert.doesNotMatch(read(f), /branch (you ran it from|you're on now|the fleet was run from|it was run from)|into your current branch|merged into this branch/, f)
  for (const f of ['tidy.mjs', 'inventory.mjs', 'tidy-core.mjs']) assert.ok(existsSync(join(ROOT, 'scripts', f)), f)
})

test('the go-ahead takes a test plan and launches the fleet; resume routes an agent go-ahead to the agents', () => {
  const plan = read('skills/plan/SKILL.md')
  assert.match(plan, /profile\.mjs --recommend <folder>/)
  assert.match(plan, /profile\.mjs --cost <folder> --tests/)
  assert.match(plan, /fleet\.mjs <feature> --detach --into <target>/)
  assert.match(plan, /Walk it yourself before\s+it lands\?/)
  assert.match(plan, /\/builder:init --update/)
  assert.match(plan, /tests: slice=<v> end=<v> review=<v>/)
  assert.match(plan, /chore\(<ticket-or-feature>\): <feature> — go-ahead \(<test plan>\)/)
  // No `2. agent` footer: with agent_walk the fleet launches; without it agents can't take it.
  assert.doesNotMatch(plan, /2\. agent/)
  const resume = resumeAll()
  assert.match(resume, /^\| `state: planned` with a go-ahead, or `state: building`, \*\*and\*\* the manifest carries `target:` or an old `profile:`[^\n]*`tests:` alone is an in-chat go-ahead[^\n]*\*\*and\*\* the config has an `agent_walk:` block[^\n]*\/builder:agent --path <folder>/m)
  assert.match(read('skills/agent/SKILL.md'), /manifest carries `target:`[\s\S]{0,80}`--into <target>`/)
})

test('agents get the right target, no hand build in agent_walk projects, and the target is its own question', () => {
  const plan = read('skills/plan/SKILL.md')
  // I-1: under the fleet, the target is the --into the run was given.
  assert.match(plan, /^Invocation: [^\n]*\[--into <branch>\]/m)
  assert.match(plan, /`target: <the --into this run was given>`/)
  // I-3: the target is its own question in the same call; Other on a testing question is the rest of the levers.
  assert.match(plan, /\*\*Land on\?\*\*/)
  assert.match(plan, /`<merge_into> \(Recommended\)`/)
  assert.match(plan, /The tool.s \*Other\* on any of the three testing questions is the rest of the levers/)
  // I-2: planned + no go-ahead in an agent_walk project goes to plan's go-ahead, never a hand build.
  const resume = resumeAll()
  assert.match(resume, /^\| `state: planned` \*\*and\*\* `go-ahead: none` \*\*and\*\* the config has an `agent_walk:` block[^\n]*\/builder:plan --path <folder>/m)
  assert.match(read('skills/build/SKILL.md'), /`go-ahead: none`[^\n]*`agent_walk:` block[^\n]*\/builder:plan --path <folder>/)
  // M-5: the agent_walk row comes before the ready: pending row.
  assert.ok(resume.indexOf('**and** the config has an `agent_walk:` block, **not** under `--agent-walk`') < resume.indexOf('`state: building` **and** `ready: pending`'))
  // M-4
  assert.match(read('skills/resume/REFERENCE.md'), /plan's go-ahead footer/)
  assert.match(read('skills/help/SKILL.md'), /except the plan go-ahead, which launches agents itself/)
  // M-6
  assert.match(read('skills/agent/SKILL.md'), /without `target:` counts as `merge_into`/)
})

test('each lever is applied where the work happens: build, agent-walk, verify, revise, resume, init, status, help', () => {
  const LEVERS = /node <builder>\/scripts\/profile\.mjs --levers <folder>/
  const FLOORS = /The\s+floors\s+in\s+its\s+`floors`\s+hold\s+whatever\s+the\s+levers\s+say/
  const build = read('skills/build/SKILL.md')
  assert.match(build, LEVERS)
  assert.match(build, FLOORS)
  assert.match(build, /\*\*`end`\*\* → no task reviewer at all/)
  assert.match(build, /`slice\+second`[\s\S]{0,200}§Contract or §Schema/)
  assert.match(build, /`unruled: park`/)
  assert.match(build, /\.builder\/fleet\/requests\/<feature>\.pause/)
  assert.match(build, /revising — next: \/builder:revise --path <folder>/)
  assert.match(build, /`\[risk\]`/)
  const exec = read('skills/build/EXECUTION.md')
  const models = exec.slice(exec.indexOf('## Model selection'), exec.indexOf('## The task loop'))
  assert.match(models, /economy`[^\n]*integration tasks drop to the cheapest tier/)
  assert.match(models, /strong`[^\n]*integration tasks and every review run on the most capable model/)
  const walk = read('skills/agent-walk/SKILL.md')
  assert.match(walk, LEVERS)
  assert.match(walk, FLOORS)
  for (const v of ['end=none', 'end=touched', 'end=risk', 'end=everything', 'walk=you']) assert.ok(walk.includes(`\`${v}\``), `agent-walk names ${v}`)
  assert.match(walk, /🤖 AGENT SIGNED OFF — no walk \(tests: end=<none\|touched>\) — not human-tested/)
  assert.match(walk, /waiting for your walk — next: \/builder:resume --path <folder>/)
  assert.match(walk, /`persist=low`[^\n]*1 failed round/)
  const verify = read('skills/verify/SKILL.md')
  assert.match(verify, LEVERS)
  assert.match(verify, FLOORS)
  assert.match(verify, /`end=touched`/)
  assert.match(verify, /gate\.mjs <every\s+in-scope app> --typecheck/)
  assert.match(verify, /consumer parity\s+when a `released_artifact`/)
  const revise = read('skills/revise/SKILL.md')
  assert.match(revise, /fleet\.mjs --pause <feature>/)
  assert.match(revise, /every 30 s[^\n]*20 min/)
  assert.match(revise, /fleet\.mjs <feature> --detach --into <target>/)
  assert.match(revise, /no worktree[^\n]*in place/i)
  const resume = resumeAll()
  assert.match(resume, /^\| `blocked:` reads `waiting for your walk[^\n]*`agent_walk\.env`[^\n]*fleet\.mjs <feature> --detach --into <target>/m)
  const init = read('skills/init/SKILL.md')
  assert.match(init, /build_profile_default/)
  assert.match(read('skills/status/SKILL.md'), /\*\*Tests\*\* column[\s\S]{0,80}own · touched · end/)
  for (const f of ['skills/help/SKILL.md', 'docs/guide.md']) {
    const s = read(f)
    assert.match(s, /Testing per slice/, `${f} names the per-slice question`)
    assert.match(s, /Testing at the end/, `${f} names the end question`)
    assert.doesNotMatch(s, /\*\*Rush\*\*/, `${f} names no preset`)
    assert.match(s, /floors/, `${f} names the floors`)
    assert.match(s, /a type-check of every touched app/, `${f} names the type-check floor`)
    assert.match(s, /Change the test plan/, `${f} names the go-ahead's B`)
  }
})

test('with agent_walk set, no skill offers /builder:build as how a user builds', () => {
  // Task 8 asserts resume's planned-with-go-ahead row names /builder:agent and plan's footer has no `2. agent`;
  // this widens it to every skill and the README: no line pairs agent_walk with /builder:build unless it says never.
  const files = [...readdirSync(join(ROOT, 'skills')).map((d) => `skills/${d}/SKILL.md`).filter((f) => existsSync(join(ROOT, f))), 'README.md']
  for (const f of files)
    for (const line of read(f).split('\n'))
      if (/agent_walk/.test(line) && /\/builder:build\b/.test(line) && !/never/i.test(line)) assert.fail(`${f}: ${line}`)
})

test('thorough is today\'s pipeline, pr-ci is deferred, your walk and revise never stall', () => {
  // Ruling A: no skill or doc describes Thorough as strong models or a second reviewer.
  for (const f of ['skills/plan/SKILL.md', 'skills/help/SKILL.md', 'README.md', 'skills/init/SKILL.md'])
    assert.doesNotMatch(read(f), /\*\*Thorough\*\*[^\n]*(second reviewer|strong|most capable)/, f)
  // Ruling B: pr-ci is not offered anywhere.
  for (const f of ['skills/plan/SKILL.md', 'skills/verify/SKILL.md', 'skills/help/SKILL.md', 'README.md'])
    assert.doesNotMatch(read(f), /pr-ci/, f)
  // Important 2: your walk hands back to the fleet whatever the sign-off's verdict.
  const resume = resumeAll()
  assert.match(resume, /^\| `blocked:` reads `waiting for your walk[^\n]*whatever its verdict[^\n]*fleet\.mjs <feature> --detach --into <target>/m)
  // Important 3: pause only a live row; a worktree that isn't running is revised there with no pause.
  const revise = read('skills/revise/SKILL.md')
  assert.match(revise, /A running fleet holds the row[\s\S]{0,200}`building`, `walking` or `queued`/)
  assert.match(revise, /fleet is stopped[\s\S]{0,200}skip the pause/)
  assert.match(revise, /Revise in place\s+only when there is\s+no worktree/)
  // design §6: the agent walk checks for a pause request between rounds.
  const walk = read('skills/agent-walk/SKILL.md')
  assert.match(walk, /between rounds[\s\S]{0,200}\.builder\/fleet\/requests\/<feature>\.pause[\s\S]{0,200}revising — next: \/builder:revise --path <folder>/i)
})

test('4.9.0 final review: your walk runs in the fleet\'s worktree, pause requests are found, old and in-chat go-aheads build by hand', () => {
  const resume = resumeAll()
  const signoff = read('skills/signoff/SKILL.md')
  const agent = read('skills/agent/SKILL.md')
  const build = read('skills/build/SKILL.md')
  const walk = read('skills/agent-walk/SKILL.md')
  const revise = read('skills/revise/SKILL.md')
  // C1.1: resume routes on the fleet worktree's manifest when the row has one on disk.
  assert.match(resume, /`\.builder\/fleet\/fleet\.json` has a row for\s+the feature whose `worktree` exists on disk/)
  assert.match(resume, /reading the fleet's copy\s+in <worktree>/)
  // C1.2: the walk row starts the env in the worktree and names the absolute signoff path; signoff works there.
  const row = resume.split('\n').find((l) => l.startsWith('| `blocked:` reads `waiting for your walk'))
  assert.match(row, /`agent_walk\.start` run in `<wt>` with `agent_walk\.env`/)
  assert.match(row, /\/builder:signoff --path <wt>\/<registry>\/<feature>` \(the absolute path\)/)
  assert.match(signoff, /^## A fleet worktree$/m)
  assert.match(signoff, /`git -C <worktree> …`/)
  assert.match(signoff, /migration \*\*status\*\* runs in `<worktree>` with the\s+config's `agent_walk\.env`/)
  assert.match(signoff, /whatever the verdict, hand it back[\s\S]{0,120}fleet\.mjs <feature> --detach --into <target>/)
  // C1.3: agent and resume's agent row never unpark a park waiting for your walk.
  assert.match(agent, /The one exception:\*\* a\s+park whose reason starts `waiting for your walk`[\s\S]{0,200}never unparked here/)
  const agentRow = resume.split('\n').find((l) => l.startsWith('| `state: planned` with a go-ahead, or `state: building`') && l.includes('`target:` or an old `profile:`'))
  assert.match(agentRow, /`waiting for your walk …` is the walk row above, never this one/)
  // C1.4: the park's next step stays resume.
  assert.match(walk, /waiting for your walk — next: \/builder:resume --path <folder>/)
  // I5: only an agent go-ahead (target:, or an old profile:) routes to agents; tests: alone or a 4.8 one builds by hand.
  assert.match(agentRow, /carries `target:` or an old `profile:`[^\n]*`tests:` alone is an in-chat go-ahead[^\n]*\/builder:agent --path <folder>/)
  assert.match(agentRow, /Neither key \(a 4\.8 go-ahead\)/)
  assert.match(build, /^\| `state: planned` with a go-ahead, or `state: building`, \*\*and\*\* the manifest carries `profile:` or `target:`[^\n]*\/builder:agent --path <folder>/m)
  // I2: the pause check reads the fleet dir the fleet exports.
  for (const s of [build, walk]) assert.match(s, /`\$BUILDER_FLEET_DIR\/requests\/<feature>\.pause`/)
  // M1: the order of revise's cases.
  const a = revise.indexOf('**No worktree and no running fleet holding the row**')
  const b = revise.indexOf('**A running fleet holds the row**')
  const c = revise.indexOf('**The row has a worktree and is `parked` or `failed`, or the fleet is stopped**')
  assert.ok(a > 0 && a < b && b < c, 'in place, then pause, then the worktree')
  assert.match(revise, /`awaiting-ship` or `shipping` too/)
})

test('4.9.1: agents ask the test plan before launching; a headless go-ahead keeps it', () => {
  const plan = read('skills/plan/SKILL.md'), agent = read('skills/agent/SKILL.md'), fleet = read('skills/fleet/SKILL.md')
  assert.match(plan, /### Picking the test plan ahead/)
  assert.match(plan, /keep a `tests:` \(or an old\s+`profile:`\) and `target:` the manifest already carries/)
  for (const s of [agent, fleet]) {
    assert.match(s, /§Picking the test plan ahead/)
    assert.match(s, /no\s+`tests:`/)
  }
})

test('4.12.0: the go-ahead shows slices and a test plan you can change', () => {
  const plan = read('skills/plan/SKILL.md')
  const g = plan.slice(plan.indexOf('## The go-ahead'), plan.indexOf('### Build here'))
  assert.match(g, /node <builder>\/scripts\/plan-slices\.mjs <folder>/)
  assert.match(g, /^A\. Build it with this plan \(recommended\)/m)
  assert.match(g, /^B\. Change the test plan/m)
  assert.match(g, /^C\. Keep planning/m)
  assert.match(g, /"go" is A/)
  // The three questions, each recommendation first.
  assert.match(g, /\*\*Testing while building — after each slice:\*\* \*\*Its own tests\*\*/)
  assert.match(g, /\*\*Testing at the end — once every slice is built:\*\* \*\*The touched apps' suites, once\*\*/)
  assert.match(g, /\*\*Review:\*\* \*\*Once at the end\*\*/)
  // The floors are never offered off.
  assert.match(g, /\*\*The floors are not options\*\*/)
  assert.match(g, /the type-check of every touched app before\s+the work lands, and the final whole-branch review/)
  // Build reads the levers on every build.
  const build = read('skills/build/SKILL.md')
  assert.match(build, /^## The test plan — read on every build$/m)
  assert.match(build, /node <builder>\/scripts\/profile\.mjs --levers <folder>/)
})

test('4.9.1: splits are cut by value and "one spec" is always offered', () => {
  const ref = read('skills/resume/REFERENCE.md'), conv = read('skills/brainstorm/CONVERSATION.md')
  assert.match(ref, /A slice is shippable only when it gives the user something they can use on its\s+own/)
  assert.match(ref, /Children are cut by value, never by layer/)
  assert.match(conv, /"one spec" is always an option/)
  assert.match(conv, /\*\*One spec\*\*/)
  assert.doesNotMatch(conv, /lg is offered a split before anything else/)
})

test('4.9.1: resume writes to the fleet worktree copy when it routes on it', () => {
  assert.match(resumeAll(), /Every write that follows goes there too/)
})

test('4.10.1: spec asks no section approvals — only open product choices, as real decisions; details are assumed and listed', () => {
  const spec = read('skills/spec/SKILL.md')
  assert.match(spec, /## 1\. Settle what the record left open — no section approvals/)
  assert.match(spec, /Never\s+present the spec section by section for approval/)
  assert.doesNotMatch(spec, /options are only \*\*Right\*\* and \*\*Change something\*\*/)
  assert.match(spec, /\*\*A product choice\*\*/)
  assert.match(spec, /§Rounds format/)
  assert.match(spec, /Never "Right \/ Change\s+something"/)
  assert.match(spec, /\*\*An implementation detail\*\*[\s\S]*\(assumed at spec\) YYYY-MM-DD/)
  // 4.13.0: the closing summary became the review — assumed details are still listed, marked (assumed).
  assert.match(spec, /every detail assumed at spec,\s+each ending `\(assumed\)`/)
})

test('4.10.0: build here — offered before the build, audit and plan still run, the build stops at built', () => {
  const ref = read('skills/resume/REFERENCE.md'), resume = resumeAll(), plan = read('skills/plan/SKILL.md'), build = read('skills/build/SKILL.md')
  assert.match(ref, /\| `--here` \|/)
  assert.match(ref, /build: here \| none/)
  assert.match(ref, /\*\*In this session\*\* — only before the build starts[\s\S]{0,120}`\/builder:resume --path <folder> --here`/)
  for (const f of ['spec', 'align', 'audit']) assert.match(read(`skills/${f}/SKILL.md`), /\n {3}3\. In this session — [^\n]*right here in this session[^\n]*\n {3}Reply 1, 2 or 3 — "go" is 1\./, f)
  assert.match(resume, /\*\*`--here` \(not under `--agent-walk`\)\*\* → write `build: here`/)
  assert.match(resume, /`build: here` \| `\/builder:build --path <folder> --here`/)
  assert.ok(resume.indexOf('**and** `build: here` |') < resume.indexOf('**and** the config has an `agent_walk:` block, **not** under `--agent-walk` |'), 'the here rows come before the agent rows')
  assert.match(plan, /### Build here \(`build: here`\)/)
  assert.match(plan, /don't stop for an approval/)
  assert.match(build, /## Build here/)
  assert.match(build, /chore\(<feature>\): built here — not walked/)
  assert.match(build, /stage and carry on/)
})

test('4.10.2: /builder:agent never offers in-session or shared-branch work, and says what agents would do', () => {
  const agent = read('skills/agent/SKILL.md')
  assert.match(agent, /\*\*`inSession: true`\*\*/)
  assert.match(agent, /being built in a session; finish it there/)
  assert.match(agent, /non-empty `sharedWith`/)
  assert.match(agent, /built in a session, not tested yet · agents only walk it, verify and\s+merge it/)
  assert.match(agent, /features not built yet first, then part-built, then built/)
})

test('brainstorm discovery: the record, the skill, spec and the listings agree on the Discovery section', () => {
  const conv = read('skills/brainstorm/CONVERSATION.md')
  const skill = read('skills/brainstorm/SKILL.md')
  // The record template carries the section between Intent and How it works today.
  const rec = /## Intent[\s\S]*?## Discovery[\s\S]*?## How it works today/.exec(conv)
  assert.ok(rec, 'CONVERSATION §The record lacks ## Discovery between Intent and How it works today')
  assert.match(rec[0], /Concept: </)
  assert.match(rec[0], /^Research: /m)
  assert.match(conv, /^## Discovery recon$/m)
  assert.match(conv, /not run \(auto\)/)
  assert.match(conv, /let's explore/)
  assert.match(conv, /skip discovery/)
  assert.match(skill, /^## Discovery$/m)
  assert.match(skill, /CONVERSATION §Discovery recon/)
  assert.match(skill, /No AskUserQuestion in discovery\*\* — the research offer and the concepts are lettered lists/)
  assert.match(skill, /^### Research$/m)
  assert.match(read('skills/spec/SKILL.md'), /§Discovery/)
  for (const f of ['skills/help/SKILL.md', 'README.md']) assert.match(read(f), /explore/i, f)
})

test('brainstorm discovery: resume lands back in discovery, the steers are brainstorm-only, the frame defers to grounding, a skipped discovery still has a concept', () => {
  const conv = read('skills/brainstorm/CONVERSATION.md')
  const skill = read('skills/brainstorm/SKILL.md')
  // Important 1: an `exploring` record whose §Discovery has no Concept: resumes inside discovery, not the tree.
  assert.match(conv, /`Concept:` is empty → back into SKILL §Discovery/)
  // Important 2: the discovery steers do not leak into /builder:intake.
  assert.match(conv, /"let's explore"[^.]*brainstorm only/)
  // Important 3: a frame question already answered by grounding is stated, not asked.
  assert.match(skill, /skipped when the input, an earlier answer or grounding already/)
  assert.match(skill, /what the product does is looked up and stated/)
  // Minor 5: §Rounds' one-question rule carves out the frame.
  assert.match(conv, /The frame in SKILL §Discovery is not a round/)
  // Minor 9: "skip discovery" still writes a Concept: line.
  assert.match(conv, /\(skipped discovery\)/)
  // Minor 8: spec quotes the record's label.
  assert.match(read('skills/spec/SKILL.md'), /the frame's \*for <who>\*/)
})

test('4.11.2: brainstorm quick path — decided after grounding, one question that is the approval, never under --auto', () => {
  const skill = read('skills/brainstorm/SKILL.md')
  const conv = read('skills/brainstorm/CONVERSATION.md')
  assert.match(skill, /^## Quick path$/m)
  assert.ok(skill.indexOf('## Quick path') < skill.indexOf('## Discovery'), 'the quick path comes before discovery')
  assert.ok(skill.indexOf('3. **The quick check**') > skill.indexOf('2. **🔴 Ground it in the code'), 'the quick check follows grounding')
  assert.match(skill, /A\. Build it \(recommended\)/)
  assert.match(skill, /B\. Brainstorm it first/)
  assert.match(skill, /Picking a Build entry is the small path's one approval/)
  assert.match(skill, /never under `--auto`/)
  assert.match(skill, /quick path offered \(<xs\|sm>\)/)
  assert.match(conv, /the quick path is never offered/)
  assert.match(conv, /\*\*"just build it"\*\* \(brainstorm only — leave the conversation, wherever it is/)
  assert.match(conv, /Build it in chat anyway/)
  assert.match(conv, /quick path — offered/)
})

test('4.11.2: brainstorm ways on are a lettered list, "go" is A, at every pause but the frame', () => {
  const skill = read('skills/brainstorm/SKILL.md')
  const conv = read('skills/brainstorm/CONVERSATION.md')
  assert.match(conv, /^## Ways on$/m)
  assert.ok(conv.indexOf('## Ways on') < conv.indexOf('## Rounds'), 'Ways on comes before Rounds')
  assert.match(conv, /Letters, never numbers/)
  assert.match(conv, /A is the default path/)
  assert.match(conv, /"just build it" still works/)
  // every round carries the same three ways on
  // a round has one menu — its picker; the way ahead is a second picker question every third round
  assert.match(conv, /One menu per screen/)
  assert.match(conv, /header `Keep going\?`: \*\*Keep answering \(Recommended\)\*\*[\s\S]*\*\*Build it\s+now\*\*[\s\S]*\*\*That's enough\*\*/)
  assert.doesNotMatch(conv, /A\. Answer below/)
  // confirm, the small path's approval and the md+ hand-off are lettered
  assert.match(conv, /`A\. Build it \(recommended\)` · `B\. Park it` ·\s+`C\. Stop here`/)
  assert.match(conv, /A\. Write the spec \(recommended\)/)
  assert.match(conv, /`B\. Talk it through more/)
  // the quick path, the playback and the concepts
  assert.doesNotMatch(skill.slice(skill.indexOf('## Quick path'), skill.indexOf('## Discovery')), /AskUserQuestion/)
  assert.match(skill, /`A\. That's right — carry on \(recommended\)`/)
  assert.match(skill, /A letter \(or a concept's name\) names it outright/)
})

test('the response preview: every stage cites a skill section that exists, every path step is a stage', async () => {
  const { load } = await import('../../preview/preview.mjs')
  const { stages, paths } = load()
  const ids = new Set(stages.map((s) => s.id))
  assert.equal(ids.size, stages.length, 'stage ids are unique')
  for (const s of stages) assert.notEqual(s.status, 'broken', `${s.id}: missing section ${s.missing?.join(', ')} — fix its source`)
  for (const p of paths) for (const id of p.steps) assert.ok(ids.has(id), `${p.id} → ${id} is not a stage`)
})

test('4.11.3: research starts from the design system, offers what is installed, names no product', () => {
  const skill = read('skills/brainstorm/SKILL.md'), conv = read('skills/brainstorm/CONVERSATION.md')
  const research = skill.slice(skill.indexOf('### Research'), skill.indexOf('### Concepts'))
  for (const f of ['skills/brainstorm/SKILL.md', 'skills/brainstorm/CONVERSATION.md', 'skills/help/SKILL.md', 'README.md']) assert.doesNotMatch(read(f), /mobbin/i, f)
  assert.match(research, /Always start with\s+what is already here, and how it should be used/)
  assert.ok(research.indexOf("The project's own design system") < research.indexOf('What this session has installed'), 'the design system comes before installed tools')
  assert.ok(research.indexOf('*Stay with what we have*') < research.indexOf('*Look at <installed tool>*') &&
    research.indexOf('*Look at <installed tool>*') < research.indexOf('*Search the web*') &&
    research.indexOf('*Search the web*') < research.indexOf('*Suggest a plugin*'), 'the offer runs here → installed → web → suggest')
  assert.match(research, /Builder names no product/)
  assert.match(research, /Never look outside the repo unasked/)
  assert.match(conv, /^Design system: </m)
  assert.match(conv, /how the design system says to\s+use them/)
})

test('4.13.0: every approval shows the review — REFERENCE defines it, the approval points cite it, no file path is approved', () => {
  const ref = read('skills/resume/REFERENCE.md')
  assert.match(ref, /^## The review — what an approval shows$/m)
  const r = ref.slice(ref.indexOf('## The review — what an approval shows'), ref.indexOf('## Branch and ticket'))
  assert.match(r, /No approval asks anyone to read a file/)
  assert.match(r, /A file path is a\s+\*\*reference line\*\*/)
  // the sections, D2
  for (const h of ['What changes for users', "What they'll see", 'Added · Changed · Removed', 'Data', 'Apps', 'Decisions', 'Risks and open questions', 'Not included', 'How it gets built and tested'])
    assert.match(r, new RegExp(`\\| \\*\\*${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\* \\|`), h)
  // the parts rule, D3, with a filled three-part example
  assert.match(r, /^### Screen-sized parts$/m)
  assert.match(r, /~40 lines/)
  assert.match(r, /^A\. Looks right — next part$/m)
  assert.match(r, /^B\. Change something — say what$/m)
  assert.match(r, /The last part ends with the step's own ways on/)
  for (const p of ['Part 1 of 3 — What users get', 'Part 2 of 3 — Data and apps', 'Part 3 of 3 — Decisions and risks']) assert.match(r, new RegExp(`^${p}$`, 'm'), p)
  assert.match(r, /^> a$/m)
  // the delta form, and --auto (D5: no review where no approval is asked; shown at the walk and the fleet report)
  assert.match(r, /^### The delta form$/m)
  assert.match(r, /The audit changed nothing in the design you approved\./)
  assert.match(r, /^### Under `--auto` and `--agent-walk`$/m)
  assert.match(r, /No approval is asked, so no review is printed/)
  assert.match(r, /resume §🔒 The walk[\s\S]{0,80}fleet §5/)
  // every approval point cites it
  for (const f of ['skills/spec/SKILL.md', 'skills/plan/SKILL.md', 'skills/audit/SKILL.md', 'skills/revise/SKILL.md', 'skills/brainstorm/CONVERSATION.md', 'skills/brainstorm/SKILL.md', 'skills/intake/SKILL.md', 'skills/resume/SKILL.md', 'skills/agent/SKILL.md', 'skills/fleet/SKILL.md'])
    assert.match(read(f), /REFERENCE §The review/, `${f} cites REFERENCE §The review`)
  // spec: the review in parts is the design approval; the old plain summary is gone
  const spec = read('skills/spec/SKILL.md')
  assert.doesNotMatch(spec, /Close with one plain summary/)
  assert.doesNotMatch(spec, /Anything wrong\? Just say what/)
  assert.match(spec, /\*\*Then the review — it is the design approval\.\*\*/)
  assert.match(spec, /Full spec: <registry>\/<feature>\/SPEC\.md/)
  assert.match(spec, /\*\*Under `--auto`\*\* no review is printed/)
  // the go-ahead recaps what it builds and what the audit changed, above the slices
  const plan = read('skills/plan/SKILL.md')
  const g = plan.slice(plan.indexOf('## The go-ahead'), plan.indexOf('### Build here'))
  assert.ok(g.indexOf('**0. The recap') > 0 && g.indexOf('**0. The recap') < g.indexOf('**1. The slices'), 'the recap comes before the slices')
  assert.match(g, /what the audit changed since the design was approved/)
  // audit and revise show a delta; the PR body is printed before the question; the walk shows an --auto run's review
  assert.match(read('skills/audit/SKILL.md'), /What the audit changed in the design/)
  assert.match(read('skills/revise/SKILL.md'), /The change, as a review delta/)
  const resume = resumeAll()
  assert.match(resume, /Print the body in full in the chat first/)
  assert.match(resume, /After an `--auto` run, the review first/)
  assert.match(read('skills/fleet/SKILL.md'), /Then the review of what landed/)
  // the conversation reads four REFERENCE sections now, and says so where it is counted
  assert.match(read('skills/brainstorm/CONVERSATION.md'), /exactly four REFERENCE sections[^)]*§The review/)
  for (const f of ['skills/brainstorm/SKILL.md', 'skills/intake/SKILL.md']) assert.match(read(f), /the four sections CONVERSATION\.md/, f)
})

test('lean orchestrator: the skills call the scripts instead of typing what they write — dispatch, advance, condense, docs, handoff, walk-script, the §Plan index', async () => {
  const { STEPS } = await import('../docs.mjs')
  const build = read('skills/build/SKILL.md'), exec = read('skills/build/EXECUTION.md'), walk = read('skills/agent-walk/SKILL.md'), resume = resumeAll()
  // P1 — every subagent dispatch is rendered; the Agent call is one line
  for (const k of ['implementer <folder> --task N', 'task-review <folder> --task N', 're-review <folder> --task N --round R', 'task-review <folder> --phase N', 'final-review <folder>', 'implementer <folder> --final'])
    assert.ok(build.includes(`dispatch.mjs ${k}`), `build names dispatch.mjs ${k}`)
  assert.match(build, /`Read <file> and do what it says\.`/)
  assert.match(exec, /dispatch\.mjs implementer <folder> --task N/)
  assert.match(exec, /dispatch\.mjs task-review <folder> --task N/)
  assert.match(exec, /dispatch\.mjs re-review <folder> --task N --round R/)
  assert.match(exec, /dispatch\.mjs final-review <folder>/)
  assert.match(walk, /dispatch\.mjs agent-walk <folder>/)
  // findings travel as files: every reviewer template writes its report where the dispatch says
  for (const f of ['task-reviewer.md', 're-review.md', 'final-reviewer.md']) assert.match(read(`skills/build/prompts/${f}`), /\*\*Write the same report to \[FINDINGS_FILE\]\*\*/, f)
  for (const s of [build, exec]) assert.match(s, /--findings-file/)
  assert.doesNotMatch(build, /`<builder>\/scripts\/review-package BASE HEAD/, 'the review package comes from dispatch.mjs, not a hand call')
  // P2 — state changes through advance.mjs / condense.mjs / plan-slices --index --write
  for (const [f, re] of [
    ['skills/build/SKILL.md', /advance\.mjs <folder> --set "contract=frozen <YYYY-MM-DD>"/],
    ['skills/build/SKILL.md', /advance\.mjs <folder> --set state=built .*--commit built/],
    ['skills/build/SKILL.md', /--commit walk-lane/],
    ['skills/build/EXECUTION.md', /advance\.mjs <folder> --ledger/],
    ['skills/audit/SKILL.md', /advance\.mjs/],
    ['skills/align/SKILL.md', /advance\.mjs/],
    ['skills/plan/SKILL.md', /plan-slices\.mjs <folder> --index --write/],
    ['skills/plan/SKILL.md', /advance\.mjs/],
    ['skills/verify/SKILL.md', /verify-ready/],
    ['skills/verify/SKILL.md', /verify-incomplete/],
    ['skills/signoff/SKILL.md', /condense\.mjs <folder> --signoff human/],
    ['skills/ship/SKILL.md', /condense\.mjs <folder> --ship --pr <N>/],
    ['skills/ship/SKILL.md', /condense\.mjs <folder> --ship --into <branch>/],
    ['skills/agent-walk/SKILL.md', /condense\.mjs <folder> --signoff agent\b/],
    ['skills/agent-walk/SKILL.md', /condense\.mjs <folder> --signoff agent --no-walk/],
    ['skills/resume/SKILL.md', /advance\.mjs/],
  ]) assert.match(read(f), re, `${f} ${re}`)
  // P5 — one docs.mjs call per step, and every step a skill names exists in the map
  for (const [f, step] of [['build', 'build'], ['audit', 'audit'], ['plan', 'plan'], ['align', 'align'], ['verify', 'verify'], ['signoff', 'signoff'], ['ship', 'ship'], ['revise', 'revise'], ['agent-walk', 'agent-walk'], ['resume', 'resume'], ['brainstorm', 'brainstorm'], ['intake', 'intake'], ['spec', 'spec']])
    assert.ok(read(`skills/${f}/SKILL.md`).includes(`docs.mjs ${step}`), `${f} reads its docs through docs.mjs ${step}`)
  for (const dir of readdirSync(join(ROOT, 'skills'))) {
    for (const file of readdirSync(join(ROOT, 'skills', dir)).filter((x) => x.endsWith('.md'))) {
      const text = read(`skills/${dir}/${file}`)
      for (const m of text.matchAll(/docs\.mjs ([a-z][a-z-]*)/g)) assert.ok(STEPS[m[1]], `skills/${dir}/${file}: docs.mjs ${m[1]} is not a step in docs.mjs`)
      // zsh reads a word starting with = as a filename expansion: no `echo =====` separator anywhere
      assert.doesNotMatch(text, /echo +["']?={3,}/, `skills/${dir}/${file} has an echo === separator`)
    }
  }
  // P6 — build writes the hand-off; resume's walk lane reads it and falls back on stale (exit 3)
  assert.match(build, /handoff\.mjs write <folder>/)
  assert.match(resume, /handoff\.mjs read <folder>/)
  assert.match(resume, /\*\*`stale: …` \(exit 3\)\*\*[^|]*derive it as before/)
  // P7 — walk.md from walk-script.mjs, the orchestrator filling only the marked blocks
  assert.match(build, /walk-script\.mjs <folder>/)
  assert.match(build, /you fill only each app's marked `<!-- orchestrator: … -->` block/)
  // the crash rule: every changed skill says to re-run the same command
  for (const f of ['skills/build/SKILL.md', 'skills/build/EXECUTION.md', 'skills/agent-walk/SKILL.md', 'skills/resume/SKILL.md', 'skills/audit/SKILL.md', 'skills/plan/SKILL.md', 'skills/align/SKILL.md', 'skills/verify/SKILL.md', 'skills/signoff/SKILL.md', 'skills/ship/SKILL.md', 'skills/revise/SKILL.md', 'skills/brainstorm/SKILL.md'])
    assert.match(read(f), /re-run the same\s+command/i, `${f} says to re-run the same command after a crash`)
  // REFERENCE §The scripts lists them and owns the idempotence rule
  const ref = read('skills/resume/REFERENCE.md')
  const scripts = ref.slice(ref.indexOf('## The scripts'), ref.indexOf('## Sizes'))
  for (const s of ['docs.mjs', 'advance.mjs', 'condense.mjs', 'plan-slices.mjs', 'dispatch.mjs', 'walk-script.mjs', 'handoff.mjs']) assert.ok(scripts.includes(s), s)
  assert.match(scripts, /Every one of these is idempotent — after a crash, a `\/clear` or a session that died, re-run the/)
  assert.match(scripts, /Separate outputs with `echo ---`/)
})

test('lean orchestrator: under --auto brainstorm writes the spec itself behind a stub record that resume, brainstorm and spec all route', () => {
  const b = read('skills/brainstorm/SKILL.md'), c = read('skills/brainstorm/CONVERSATION.md'), s = read('skills/spec/SKILL.md'), r = resumeAll()
  assert.match(b, /^## Spec under `--auto`$/m)
  assert.match(b, /docs\.mjs spec-auto/)
  assert.match(c, /^### The `--auto` stub record \(brainstorm only\)$/m)
  assert.match(c, /^auto: stub — the design is written straight into SPEC\.md$/m)
  assert.match(c, /^Request: "<the user's request, verbatim/m)
  assert.match(c, /re-run the same\s+command/)
  for (const t of [b, s, r]) assert.match(t, /auto:\s+stub/)
  assert.match(read('skills/intake/SKILL.md'), /Intake keeps its\s+full record under `--auto`/)
})

test('4.14.2: before a picker, the options are explained — never a second menu', () => {
  const ref = read('skills/resume/REFERENCE.md'), conv = read('skills/brainstorm/CONVERSATION.md')
  assert.match(ref, /^## Before a picker$/m)
  assert.match(ref, /never a second menu/)
  assert.match(ref, /never an option for "answer\s+the question below"/)
  assert.match(conv, /\*\*Your options:\*\*/)
  assert.match(conv, /\*\*Why <the recommended label>:\*\*/)
  assert.match(conv, /The briefing explains; the picker is where you choose/)
  for (const f of ['skills/brainstorm/CONVERSATION.md', 'skills/spec/SKILL.md', 'skills/plan/SKILL.md', 'skills/resume/SKILL.md', 'skills/fleet/SKILL.md']) assert.match(read(f), /§Before a picker/, f)
})

test('4.14.3: the program go-ahead is the program review — never a raw file or a bare Yes / No', () => {
  const spec = read('skills/spec/SKILL.md'), ref = read('skills/resume/REFERENCE.md'), resume = resumeAll()
  assert.match(spec, /the one\s+program go-ahead as the program's review/)
  assert.match(spec, /never the file\s+shown raw, never a bare Yes \/ No/)
  assert.match(spec, /A\. Approve the program \(recommended\)/)
  assert.match(ref, /\*\*spec at xl — the one program go-ahead\*\*/)
  assert.match(resume, /Pick the child the way the picker picks a feature\.\*\* Brief it first \(REFERENCE §Before a picker\)/)
  assert.match(spec, /designed \(xl, <n> children\)/)
})

test('the build options: Agent → Step by step → In this session, no command on an option line, one pick-up line', () => {
  const ref = read('skills/resume/REFERENCE.md')
  const sec = ref.slice(ref.indexOf('## The two-way footer'), ref.indexOf('**Not numbered:**'))
  // the order, and each option only where it applies
  assert.ok(sec.indexOf('- **Agent** — only when the config has an `agent_walk:` block') < sec.indexOf('- **Step by step** — always'))
  assert.ok(sec.indexOf('- **Step by step** — always') < sec.indexOf('- **In this session** — only before the build starts'))
  assert.match(sec, /numbered from 1 with no gaps when one is absent/)
  // the per-state wording is a table, the walk row in the owner's words
  assert.match(sec, /^\| State \| 1\. Agent — \| 2\. Step by step — \| 3\. In this session — \|$/m)
  assert.match(sec, /^\| `built` \(the walk\) \|[^\n]*\| you walk it yourself in the running app, then sign it off here \|/m)
  // "go" is option 1 — Agent where it is offered — and replies may name the option
  assert.match(sec, /\*\*so where\s+Agent is offered, "go" hands the feature to the agents\*\*/)
  for (const r of ['`agent`', '`step by step` or `resume`', '`in this session` or `here`']) assert.ok(sec.includes(r), r)
  assert.match(ref, /\*\*On a numbered footer\*\* \(§The two-way footer\) a bare affirmative picks \*\*option 1\*\*/)
  // every copy: the Full spec / Pick up lines, the options in order, no /builder: on an option line
  const footers = [ref, ...['spec', 'align', 'audit', 'build', 'signoff', 'verify'].map((f) => read(`skills/${f}/SKILL.md`))]
    .flatMap((s) => [...s.matchAll(/^ *```\w*\n([\s\S]*?)^ *```$/gm)].map((m) => m[1]).filter((b) => /^ {3}\d\. (Agent|Step by step|In this session) — /m.test(b)))
  assert.ok(footers.length >= 9, `found ${footers.length} footers`)
  for (const b of footers) {
    assert.match(b, /^Pick up where you left off any time: \/builder:resume --path \S+\n {2}\(if this session ends, or to spec several features before building any of them\)$/m, b)
    const opts = [...b.matchAll(/^ {3}(\d)\. (Agent|Step by step|In this session) — (.*)$/gm)]
    for (const [, , , text] of opts) assert.doesNotMatch(text, /\/builder:/, text)
    const order = ['Agent', 'Step by step', 'In this session']
    // each 📍 group in the block numbers from 1 in the fixed order
    for (const group of b.split(/^📍/m).slice(1)) {
      const g = [...group.matchAll(/^ {3}(\d)\. (Agent|Step by step|In this session) — /gm)]
      g.forEach(([, n, name], i) => assert.equal(+n, i + 1, group))
      const idx = g.map(([, , name]) => order.indexOf(name))
      assert.deepEqual(idx, [...idx].sort(), group)
      if (!/ — …$/m.test(group)) assert.match(group, /^ {3}Reply 1(, 2)?( or [23])? — "go" is 1\.$/m, group) // the review example is cut short
    }
  }
  // no copy keeps the old option lines
  for (const f of ['resume/REFERENCE.md', 'resume/SKILL.md', 'spec/SKILL.md', 'align/SKILL.md', 'audit/SKILL.md', 'build/SKILL.md', 'signoff/SKILL.md', 'verify/SKILL.md', 'help/SKILL.md', 'agent/SKILL.md'])
    assert.doesNotMatch(read(`skills/${f}`), /resume — continue here|2\. agent|3\. here|1\. resume/, f)
})

test('4.14.8: init always writes the agent_walk block — agent mode is part of every install', () => {
  const init = read('skills/init/SKILL.md'), tpl = read('PROJECT.template.md')
  assert.match(init, /the \*\*`agent_walk` block\*\* — 🔴 \*\*always written\.\*\*/)
  assert.match(init, /A config with no `agent_walk:` block is a gap, and the biggest one/)
  assert.doesNotMatch(init, /recommend\s+\*not yet\*/)
  assert.doesNotMatch(init, /\(not yet \/ yes\)/)
  assert.match(tpl, /\/builder:init always writes this block/)
})
