import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { draftRows } from '../brainstorm-file.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

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
  const r = read('skills/resume/SKILL.md')
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
  const r = read('skills/resume/SKILL.md')
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
  assert.match(c, /\*\*Recommendation:\*\*/)
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
  assert.match(read('README.md'), /^## Live progress in the status line$/m)
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

test('the go-ahead picks a build profile and launches the fleet; resume routes a go-ahead to the agents', () => {
  const plan = read('skills/plan/SKILL.md')
  assert.match(plan, /profile\.mjs --recommend <folder>/)
  assert.match(plan, /profile\.mjs --estimate <folder> --profile/)
  assert.match(plan, /fleet\.mjs <feature> --detach --into <target>/)
  assert.match(plan, /Walk it yourself before it lands/)
  assert.match(plan, /\/builder:init --update/)
  assert.match(plan, /profile: custom k=v/)
  assert.match(plan, /chore\(<ticket-or-feature>\): <feature> — go-ahead \(<profile>\)/)
  // No `2. agent` footer: with agent_walk the fleet launches; without it agents can't take it.
  assert.doesNotMatch(plan, /2\. agent/)
  const resume = read('skills/resume/SKILL.md')
  assert.match(resume, /^\| `state: planned` with a go-ahead, or `state: building`, \*\*and\*\* the manifest carries `profile:` or `target:`[^\n]*\*\*and\*\* the config has an `agent_walk:` block[^\n]*\/builder:agent --path <folder>/m)
  assert.match(read('skills/agent/SKILL.md'), /manifest carries `target:`[\s\S]{0,80}`--into <target>`/)
})

test('agents get the right target, no hand build in agent_walk projects, and the target is its own question', () => {
  const plan = read('skills/plan/SKILL.md')
  // I-1: under the fleet, the target is the --into the run was given.
  assert.match(plan, /^Invocation: [^\n]*\[--into <branch>\]/m)
  assert.match(plan, /`target: <the --into this run was given>`/)
  // I-3: the target is a second question in the same call; Other on the profile question is only Customize.
  assert.match(plan, /\*\*Land on\?\*\*/)
  assert.match(plan, /`<merge_into> \(Recommended\)`/)
  assert.match(plan, /Other[^\n]*means only \*\*Customize\*\*/)
  // I-2: planned + no go-ahead in an agent_walk project goes to plan's go-ahead, never a hand build.
  const resume = read('skills/resume/SKILL.md')
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
  assert.match(build, /final`[^\n]*no per-task reviewer/)
  assert.match(build, /`per-task\+second`[\s\S]{0,200}§Contract or §Schema/)
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
  for (const v of ['none', 'risky', 'full', 'full+human']) assert.ok(walk.includes(`\`testing: ${v}\``), `agent-walk names testing: ${v}`)
  assert.match(walk, /🤖 AGENT SIGNED OFF — no walk \(profile: rush\) — not human-tested/)
  assert.match(walk, /waiting for your walk — next: \/builder:resume --path <folder>/)
  assert.match(walk, /`persist: low`[^\n]*1 failed round/)
  const verify = read('skills/verify/SKILL.md')
  assert.match(verify, LEVERS)
  assert.match(verify, FLOORS)
  assert.match(verify, /`verify: floors`/)
  assert.match(verify, /consumer parity when[^\n]*`released_artifact`/)
  const revise = read('skills/revise/SKILL.md')
  assert.match(revise, /fleet\.mjs --pause <feature>/)
  assert.match(revise, /every 30 s[^\n]*20 min/)
  assert.match(revise, /fleet\.mjs <feature> --detach --into <target>/)
  assert.match(revise, /no worktree[^\n]*in place/i)
  const resume = read('skills/resume/SKILL.md')
  assert.match(resume, /^\| `blocked:` reads `waiting for your walk[^\n]*`agent_walk\.env`[^\n]*fleet\.mjs <feature> --detach --into <target>/m)
  const init = read('skills/init/SKILL.md')
  assert.match(init, /build_profile_default/)
  assert.match(read('skills/status/SKILL.md'), /Profile/)
  for (const f of ['skills/help/SKILL.md', 'README.md']) {
    const s = read(f)
    for (const p of ['Rush', 'Standard', 'Thorough', 'Thorough + you']) assert.ok(s.includes(p), `${f} names ${p}`)
    assert.match(s, /floors/, `${f} names the floors`)
    assert.match(s, /How should agents build/, `${f} names the go-ahead's profile question`)
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
  const resume = read('skills/resume/SKILL.md')
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

test('4.9.0 final review: your walk runs in the fleet\'s worktree, pause requests are found, old go-aheads build by hand', () => {
  const resume = read('skills/resume/SKILL.md')
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
  const agentRow = resume.split('\n').find((l) => l.startsWith('| `state: planned` with a go-ahead, or `state: building`'))
  assert.match(agentRow, /`waiting for your walk …` is the walk row above, never this one/)
  // C1.4: the park's next step stays resume.
  assert.match(walk, /waiting for your walk — next: \/builder:resume --path <folder>/)
  // I5: only a 4.9 go-ahead (profile: or target:) routes to agents; a 4.8 one builds by hand.
  assert.match(agentRow, /carries `profile:` or `target:`[^\n]*\/builder:agent --path <folder>/)
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

test('4.9.1: agents ask the build profile before launching; a headless go-ahead keeps it', () => {
  const plan = read('skills/plan/SKILL.md'), agent = read('skills/agent/SKILL.md'), fleet = read('skills/fleet/SKILL.md')
  assert.match(plan, /### Picking the profile ahead/)
  assert.match(plan, /keep a `profile:` and\s+`target:` the manifest already carries/)
  for (const s of [agent, fleet]) {
    assert.match(s, /§Picking the profile ahead/)
    assert.match(s, /no\s+`profile:`/)
  }
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
  assert.match(read('skills/resume/SKILL.md'), /Every write that follows goes there too/)
})
