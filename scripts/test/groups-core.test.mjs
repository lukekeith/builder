import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  footprintOf, matchesGlob, overlapOf, edgesOf, orderMembers, groupsOf, splitAdvice, laneCollisions,
  takeWalkBatch, landingGate, bisectPlan, firstFailing, generatedOnly,
} from '../groups-core.mjs'

const fp = (paths = [], produces = [], consumes = []) => ({ paths, produces, consumes })

// A plan in both shapes builder sees: PLAN-FORMAT's Create/Modify bullets with Consumes/Produces prose,
// and an inline **Files:** line with a fenced contract under **Interfaces**.
const PLAN = [
  '# Tags — plan',
  '',
  '### Task 1: the parser',
  '',
  'App: web · Phase: 1',
  '',
  '**Files:**',
  '- Create: `src/tags/parse.ts` — the parser',
  '- Modify: `src/api/routes.ts:12-40` (the `tags` route)',
  '- Modify: src/db/schema.prisma (new)',
  '- Test: `src/tags/**/*.test.ts`',
  '- Modify: `src/generated/client.ts`',
  '',
  '**Interfaces:**',
  '- Consumes: `loadUser(id)` from `src/user.ts`; `saveTags`',
  '- Produces: `parseTags` — takes the raw string, returns the tags',
  '  - `TAG_MAX` = 10',
  '',
  '**Behaviour:**',
  '- `ignored` names here are not interfaces; `src/not/a/file.ts` is not a path',
  '',
  '```ts',
  'export function notAContract() {}',
  '```',
  '',
  '### Task 2: saving',
  '',
  '**Files:** `src/tags/save.ts` (new), `src/api/**` (modify)',
  '',
  '**Interfaces** (all exported):',
  '',
  '```js',
  'saveTags(list) // → response',
  'TagList: string[]',
  'export const tagRoute = 1',
  '  nested: not a name',
  'POST /api/tags',
  '```',
  '',
  'It uses `parseTags` and `formatDate()`.',
  '',
  '- [ ] Write the tests',
].join('\n')

test('footprintOf reads Files and Interfaces from every task, drops generated paths, sorts and dedupes', () => {
  const f = footprintOf(PLAN, { generated: ['src/generated/**'] })
  assert.deepEqual(f.paths, ['src/api/**', 'src/api/routes.ts', 'src/db/schema.prisma', 'src/tags/**/*.test.ts', 'src/tags/parse.ts', 'src/tags/save.ts'])
  // Fenced names and Produces bullets are produced; a name produced anywhere in the plan is not also consumed.
  assert.deepEqual(f.produces, ['POST /api/tags', 'TAG_MAX', 'TagList', 'parseTags', 'saveTags', 'tagRoute'])
  assert.deepEqual(f.consumes, ['formatDate', 'loadUser'])
})

test('footprintOf keeps generated paths when none are named, and an empty plan has an empty footprint', () => {
  assert.ok(footprintOf(PLAN).paths.includes('src/generated/client.ts'))
  assert.deepEqual(footprintOf(''), fp())
  assert.deepEqual(footprintOf('# no tasks\n\n**Files:** `a.ts`'), fp())
  // A double-backtick literal is not a name, and does not shift the backtick pairs after it.
  const lit = '### Task 1: x\n\n**Interfaces:**\n- Produces: `line(note)` — `` `${id}` `` plus `tag`\n'
  assert.deepEqual(footprintOf(lit).produces, ['line', 'tag'])
})

test('matchesGlob: * within a segment, ** across segments, ? one character', () => {
  assert.equal(matchesGlob('src/a.ts', 'src/*.ts'), true)
  assert.equal(matchesGlob('src/x/a.ts', 'src/*.ts'), false)
  assert.equal(matchesGlob('src/x/y/a.ts', 'src/**/*.ts'), true)
  assert.equal(matchesGlob('src/a.ts', 'src/**/*.ts'), true)
  assert.equal(matchesGlob('src/x/y', 'src/**'), true)
  assert.equal(matchesGlob('src/ab.ts', 'src/a?.ts'), true)
  assert.equal(matchesGlob('src/abc.ts', 'src/a?.ts'), false)
  assert.equal(matchesGlob('src/a.ts', 'src/a.ts'), true)
  assert.equal(matchesGlob('src/a+b.ts', 'src/a+b.ts'), true)
  assert.equal(matchesGlob('src/a.tsx', 'src/a.ts'), false)
  assert.equal(matchesGlob('src/x/a.ts', 'src/'), true, 'a directory matches what is under it')
})

test('overlapOf: path/glob and glob/glob in both directions, interfaces, declared, all reasons reported', () => {
  const a = fp(['src/api/**', 'README.md'], ['parseTags'], ['loadUser'])
  const b = fp(['src/api/routes.ts'], ['loadUser'], [])
  assert.deepEqual(overlapOf(a, b), { paths: ['src/api/routes.ts'], interfaces: ['loadUser'], declared: false })
  assert.deepEqual(overlapOf(b, a), { paths: ['src/api/routes.ts'], interfaces: ['loadUser'], declared: false })
  // Two globs overlap when either matches the other's literal prefix.
  const g1 = fp(['src/**'])
  const g2 = fp(['src/api/*.ts'])
  assert.deepEqual(overlapOf(g1, g2), { paths: ['src/api/*.ts'], interfaces: [], declared: false })
  assert.deepEqual(overlapOf(g2, g1), { paths: ['src/api/*.ts'], interfaces: [], declared: false })
  assert.equal(overlapOf(fp(['src/*.ts']), fp(['src/*.js'])), null)
  assert.deepEqual(overlapOf(fp(['x.ts']), fp(['y.ts']), { declared: true }), { paths: [], interfaces: [], declared: true })
  assert.equal(overlapOf(fp(['x.ts']), fp(['y.ts'])), null)
})

test('edgesOf: a producer comes before its consumer; a declared edge needs no shared paths; unplanned features have none', () => {
  const features = [
    { name: 'b', footprint: fp(['b.ts'], [], ['parseTags']), dependsOn: [] },
    { name: 'a', footprint: fp(['a.ts'], ['parseTags']), dependsOn: [] },
    { name: 'c', footprint: fp(['c.ts']), dependsOn: ['a'] },
    { name: 'd', footprint: null, dependsOn: ['a'] },
    { name: 'e', footprint: fp(['e.ts']), dependsOn: [] },
  ]
  const edges = edgesOf(features)
  assert.deepEqual(edges.map(({ a, b, directed }) => [a, b, directed]), [['a', 'b', true], ['a', 'c', true]])
  assert.deepEqual(edges[0].why, { paths: [], interfaces: ['parseTags'], declared: false })
  assert.deepEqual(edges[1].why, { paths: [], interfaces: [], declared: true })
  // Shared paths alone have no direction.
  const plain = edgesOf([{ name: 'x', footprint: fp(['s.ts']), dependsOn: [] }, { name: 'y', footprint: fp(['s.ts']), dependsOn: [] }])
  assert.deepEqual(plain.map(({ a, b, directed }) => [a, b, directed]), [['x', 'y', false]])
})

test('orderMembers: dependencies first, then program order, then fleet order; a cycle is broken by fleet order', () => {
  const edges = [{ a: 'a', b: 'c', directed: true }]
  assert.deepEqual(orderMembers(['c', 'b', 'a'], { edges, programOrder: ['c', 'b', 'a'], fleetOrder: [] }), ['b', 'a', 'c'])
  assert.deepEqual(orderMembers(['c', 'b', 'a'], { edges: [], fleetOrder: ['b', 'c', 'a'] }), ['b', 'c', 'a'])
  assert.deepEqual(orderMembers(['c', 'b', 'a'], { edges: [], programOrder: ['a'], fleetOrder: ['b', 'c'] }), ['a', 'b', 'c'])
  // Each consumes the other's interface: fleet order decides, and the order says a cycle was broken.
  const mutual = edgesOf([
    { name: 'p', footprint: fp([], ['x'], ['y']), dependsOn: [] },
    { name: 'q', footprint: fp([], ['y'], ['x']), dependsOn: [] },
  ])
  const o = orderMembers(['p', 'q'], { edges: mutual, programOrder: ['p', 'q'], fleetOrder: ['q', 'p'] })
  assert.deepEqual(o, ['q', 'p'])
  assert.deepEqual(o.cycle, ['q'])
  assert.deepEqual(orderMembers(['p', 'q'], { edges: [] }).cycle, [])
})

test('groupsOf: components, ordered, cut at max — the next chunk waits on the one before; a loner is a group of one', () => {
  const f = (name, paths, dependsOn = []) => ({ name, footprint: fp(paths), dependsOn })
  const features = [f('a', ['s.ts']), f('b', ['s.ts', 't.ts']), f('lone', ['z.ts']), f('c', ['t.ts']), f('d', ['u.ts'], ['c'])]
  const groups = groupsOf(features, { max: 3, fleetOrder: ['a', 'b', 'lone', 'c', 'd'] })
  assert.deepEqual(groups, [
    { id: 'g-a', members: ['a', 'b', 'c'], waitsOn: null },
    { id: 'g-d', members: ['d'], waitsOn: 'g-a' },
    { id: 'g-lone', members: ['lone'], waitsOn: null },
  ])
  assert.deepEqual(groupsOf([f('x', ['1.ts']), f('y', ['2.ts'])]), [
    { id: 'g-x', members: ['x'], waitsOn: null },
    { id: 'g-y', members: ['y'], waitsOn: null },
  ])
})

test('splitAdvice: a note for 1..maxPaths shared paths, null for none, too many, interface-only or declared', () => {
  const ov = (paths, extra = {}) => ({ paths, interfaces: [], declared: false, ...extra })
  assert.equal(splitAdvice('a', 'b', ov(['x.ts', 'y.ts'])), 'a and b share 2 paths (x.ts, y.ts) — a prerequisite feature that takes the shared change would let them build in parallel')
  assert.equal(splitAdvice('a', 'b', ov(['x.ts'])), 'a and b share 1 path (x.ts) — a prerequisite feature that takes the shared change would let them build in parallel')
  assert.match(splitAdvice('a', 'b', ov(['1', '2', '3', '4'])), /share 4 paths \(1, 2, 3…\)/)
  assert.equal(splitAdvice('a', 'b', ov(Array.from({ length: 11 }, (_, i) => `${i}.ts`))), null)
  assert.equal(splitAdvice('a', 'b', ov(['1', '2']), { maxPaths: 1 }), null)
  assert.equal(splitAdvice('a', 'b', ov([], { interfaces: ['x'] })), null)
  assert.equal(splitAdvice('a', 'b', ov(['x.ts'], { declared: true })), null)
  assert.equal(splitAdvice('a', 'b', null), null)
})

test('laneCollisions: a lane touching another group\'s footprint, never its own', () => {
  const groups = [{ id: 'g-a', members: ['a', 'b'], waitsOn: null }, { id: 'g-c', members: ['c'], waitsOn: null }]
  const footprints = { a: fp(['src/api/**']), b: fp(['web/x.ts']), c: fp(['lib/c.ts']) }
  const changed = { c: ['lib/c.ts', 'src/api/routes.ts', 'web/x.ts'], a: ['src/api/a.ts', 'web/x.ts'] }
  assert.deepEqual(laneCollisions({ changed, groups, footprints }), [{ feature: 'c', group: 'g-a', paths: ['src/api/routes.ts', 'web/x.ts'] }])
  // fleet.json's map shape works too.
  assert.deepEqual(laneCollisions({ changed: { a: ['lib/c.ts'] }, groups: { 'g-a': { members: ['a', 'b'] }, 'g-c': { members: ['c'] } }, footprints }), [{ feature: 'a', group: 'g-c', paths: ['lib/c.ts'] }])
})

test('takeWalkBatch takes whole groups in queue order and lets a group larger than max walk alone', () => {
  const groupOf = { a: 'g-a', b: 'g-a', c: 'g-c', d: 'g-d', e: 'g-d', f: 'g-d', g: 'g-d' }
  assert.deepEqual(takeWalkBatch(['a', 'c', 'b', 'd'], groupOf, 3), { batch: ['a', 'b', 'c'], rest: ['d'] })
  // g-d (4) does not fit after c, and nothing behind it jumps the queue; it never splits.
  assert.deepEqual(takeWalkBatch(['c', 'd', 'e', 'f', 'g', 'a', 'b'], groupOf, 3), { batch: ['c'], rest: ['d', 'e', 'f', 'g', 'a', 'b'] })
  assert.deepEqual(takeWalkBatch(['d', 'e', 'f', 'g', 'c'], groupOf, 3), { batch: ['d', 'e', 'f', 'g'], rest: ['c'] })
  // A feature with no group is its own.
  assert.deepEqual(takeWalkBatch(['x', 'y'], new Map(), 1), { batch: ['x'], rest: ['y'] })
  assert.deepEqual(takeWalkBatch([], {}, 3), { batch: [], rest: [] })
})

test('landingGate: every member signed off or verified and unblocked, else the first that is not', () => {
  const ok = { state: 'signed-off' }
  assert.deepEqual(landingGate(['a', 'b'], { a: ok, b: { state: 'verified' } }), { ok: true })
  assert.deepEqual(landingGate(['a', 'b', 'c'], { a: ok, b: { state: 'built' }, c: { state: 'planned' } }), { ok: false, why: 'b is built, not signed off' })
  assert.deepEqual(landingGate(['a', 'b'], { a: { state: 'signed-off', blocked: 'its spec changed' }, b: ok }), { ok: false, why: 'a is blocked: its spec changed' })
  assert.deepEqual(landingGate(['a'], {}), { ok: false, why: 'a has no manifest' })
})

test('bisectPlan and firstFailing find the first member that turns the merge tier red', () => {
  const plan = bisectPlan(['m1', 'm2', 'm3'])
  assert.deepEqual(plan, [['m1'], ['m1', 'm2'], ['m1', 'm2', 'm3']])
  assert.equal(firstFailing(plan.map((prefix, i) => ({ prefix, green: i < 1 }))), 1)
  assert.equal(firstFailing(plan.map((prefix) => ({ prefix, green: true }))), -1)
  assert.equal(firstFailing([{ prefix: ['m1'], green: false }]), 0)
  assert.deepEqual(bisectPlan([]), [])
})

test('generatedOnly: every path under a generated glob; an empty list is not', () => {
  const gen = ['src/generated/**', 'schema.graphql']
  assert.equal(generatedOnly(['src/generated/a.ts', 'schema.graphql'], gen), true)
  assert.equal(generatedOnly(['src/generated/a.ts', 'src/app.ts'], gen), false)
  assert.equal(generatedOnly([], gen), false)
  assert.equal(generatedOnly(['src/generated/a.ts'], []), false)
})
