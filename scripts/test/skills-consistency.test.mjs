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
