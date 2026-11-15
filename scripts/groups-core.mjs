/**
 * groups-core — which fleet features overlap, and the groups that build, walk and land them together
 * (group lanes, docs/specs/2026-11-14-group-lanes-design.md). Everything here is pure: the fleet reads
 * the PLAN.md files, git and manifests, and hands the text and lists in. That keeps the rules — what a
 * footprint is, when two features overlap, how a group is cut and ordered — testable without a repo.
 */
import { isSet } from './manifest.mjs'

const HEADING = /^### Task \d+\b/
const FENCE = /^\s*(`{3,}|~{3,})/
/** A section label at the start of a line: `**Files:**`, `**Interfaces** (…):`, `**Behaviour:**`, `**Step 1: …**`. */
const LABEL = /^\s*\*\*([A-Za-z][A-Za-z ]*?)\s*(?::\s*)?\*\*/
const STEP = /^\s*[-*]\s+\[[ xX]\]\s/
const GLOB_CHAR = /[*?[]/
const FILE_EXT = /\.(?:m?[jt]sx?|c[jt]s|json|md|css|s[ac]ss|html?|vue|svelte|py|rb|go|rs|java|kt|swift|sql|prisma|graphql|ya?ml|toml|sh|txt)$/i
const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'switch', 'case', 'return', 'import', 'from', 'await', 'new', 'throw', 'try', 'catch', 'true', 'false', 'null', 'undefined', 'this', 'const', 'let', 'var', 'function', 'class', 'type', 'interface', 'export', 'default', 'async'])

/** Lines tagged with whether they sit inside a code fence (the fence markers themselves count as inside). */
function fenced(text) {
  let open = null
  return String(text ?? '').split('\n').map((line) => {
    const m = FENCE.exec(line)
    if (!open && m) { open = m[1]; return { line, inside: true, marker: true } }
    if (open && m && m[1][0] === open[0] && m[1].length >= open.length && line.trim() === m[1]) { open = null; return { line, inside: true, marker: true } }
    return { line, inside: !!open, marker: false }
  })
}

const sortedUnique = (xs) => [...new Set(xs)].sort()

/**
 * A token from a Files section that names a path: no spaces, not a URL, and either a directory
 * (`/`), a file extension, or a glob. `tags` or `contract:` in a bullet's note are not paths.
 */
function asPath(token) {
  const t = String(token).trim().replace(/^\.\//, '').replace(/[,;)]+$/, '').replace(/:\d+(?:-\d+)?$/, '')
  if (!t || /\s/.test(t) || /^[a-z]+:\/\//i.test(t) || t.startsWith('-') || t.startsWith('(')) return null
  return t.includes('/') || /\.\w+$/.test(t) || GLOB_CHAR.test(t) ? t : null
}

/** The paths one Files line names: its backticked paths, else the bare path after `Create:`/`Modify:`, else any bare path-like word. */
function pathsOfLine(line) {
  // On a bullet, the description after ` — ` or `(` is prose: `exports \`res.status\`` names no file.
  // Backticked text is masked while looking, so `app/(group)/page.tsx` keeps its parenthesis.
  if (/^\s*[-*]\s/.test(line)) {
    const masked = line.replace(/`[^`]*`/g, (m) => 'x'.repeat(m.length))
    const cut = masked.search(/\s[—–]\s|\(/)
    if (cut >= 0) line = line.slice(0, cut)
  }
  const ticks = [...line.matchAll(/`([^`]+)`/g)].map((m) => asPath(m[1])).filter(Boolean)
  if (ticks.length || line.includes('`')) return ticks
  const body = line.replace(/^\s*[-*]\s+/, '').replace(/^(?:Create|Modify|Test|Delete|Remove|Read)\s*:\s*/i, '')
  // Prose after a dash or in parentheses is a note, not more paths.
  const head = body.split(/\s[—–]\s|\s-\s|\s\(/)[0]
  return head.split(/[\s,]+/).map(asPath).filter(Boolean)
}

/** An interface's name in a backticked token: `parse(argv)` and `parse(argv) → …` are both `parse`; a path or a literal is not a name. */
function nameOf(token) {
  const t = String(token).trim()
  if (/[/\\]/.test(t.split(/[\s(]/)[0]) || FILE_EXT.test(t)) return null
  const m = /^(?:export\s+)?(?:async\s+)?(?:const|let|function|class|type|interface|def)?\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?=$|[\s(:=<,[→])/.exec(t)
  return m && m[1] !== '$' && !KEYWORDS.has(m[1]) ? m[1] : null
}

/**
 * The names one line of a fenced contract declares: an identifier at the start of an unindented line
 * before `(`, `:` or `=` (`saveTags(list)`, `TagList: string[]`, `MAX = 3`), an endpoint
 * (`POST /api/tags`), and an `export`ed name at any indent. Indented lines are a declaration's body.
 */
function declaredIn(line) {
  const out = []
  const endpoint = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)/.exec(line)
  if (endpoint) return [`${endpoint[1]} ${endpoint[2]}`]
  const exp = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/.exec(line)
  if (exp) return [exp[1]]
  const list = /^\s*export\s*\{([^}]*)\}/.exec(line)
  if (list) return list[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter((s) => /^[A-Za-z_$][\w$]*$/.test(s))
  if (/^\s/.test(line) || /^\s*(?:\/\/|#|\/\*|\*)/.test(line)) return out
  const m = /^(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum|def)?\s*([A-Za-z_$][\w$]*)\s*(?:[(:=<])/.exec(line)
  if (m && !KEYWORDS.has(m[1])) out.push(m[1])
  return out
}

/**
 * A feature's footprint from its PLAN.md (D1): the union over every `### Task N` block of its
 * **Files:** paths and its **Interfaces:** names. A name declared in a fence under Interfaces, or
 * named on a `Produces` bullet (PLAN-FORMAT writes contracts as prose), is produced; any other
 * backticked name in Interfaces is consumed. A name the plan produces anywhere is not also consumed —
 * a feature does not depend on itself. Paths under a `generated` glob (D15) are dropped: regenerated
 * files are not shared work, and counting them would group every feature that touches a schema.
 */
export function footprintOf(planText, { generated = [] } = {}) {
  const paths = []
  const produces = []
  const consumes = []
  let inTask = false
  let part = null
  let io = null // a `Produces` bullet's indent, while its line and sub-bullets are being read
  for (const { line, inside, marker } of fenced(planText)) {
    if (!inside && HEADING.test(line)) { inTask = true; part = null; io = null; continue }
    if (!inside && /^#{1,3} /.test(line)) { inTask = false; continue }
    if (!inTask) continue
    if (!inside && STEP.test(line)) { part = null; continue }
    const label = inside ? null : LABEL.exec(line)
    let text = line
    if (label) {
      const word = label[1].toLowerCase()
      part = word === 'files' ? 'files' : word === 'interfaces' ? 'interfaces' : null
      io = null
      text = line.slice(label[0].length)
    }
    if (part === 'files' && !inside) paths.push(...pathsOfLine(text))
    if (part !== 'interfaces' || marker) continue
    if (inside) { produces.push(...declaredIn(line)); continue }
    const bullet = /^(\s*)[-*]\s+(?:(Produces|Consumes)\b[^:]*:)?/i.exec(text)
    if (bullet && bullet[2]) io = bullet[2].toLowerCase() === 'produces' ? bullet[1].length : null
    // A Produces bullet owns everything indented under it — its sub-bullets and its wrapped lines; a
    // blank line, a bullet or line back at its indent, or a label ends it.
    else if (io != null && (!text.trim() || /^\s*/.exec(text)[0].length <= io)) io = null
    // A double-backtick span (`` `${id}` ``) is a literal, not a name; dropping it keeps the single-backtick pairs aligned.
    const names = [...text.replace(/``.*?``/g, '').matchAll(/`([^`]+)`/g)].map((m) => nameOf(m[1])).filter(Boolean)
    ;(io != null ? produces : consumes).push(...names)
  }
  const made = new Set(produces)
  return {
    paths: sortedUnique(paths).filter((p) => !generated.some((g) => matchesGlob(p, g))),
    produces: sortedUnique(produces),
    consumes: sortedUnique(consumes.filter((n) => !made.has(n))),
  }
}

const escape = (s) => s.replace(/[.+^${}()|\\]/g, '\\$&')

/**
 * Whether a path matches a glob: `*` within one segment, `**` across segments (zero or more), `?`
 * one character, `[…]` a class. A glob that ends in `/` names a directory and matches everything
 * under it, the way a plan writes `src/lib/` for "this folder".
 */
export function matchesGlob(path, glob) {
  const g = String(glob)
  if (g === path) return true
  if (g.endsWith('/')) return String(path).startsWith(g)
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      i++
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const end = g.indexOf(']', i + 1)
      if (end < 0) re += '\\['
      else { re += `[${g.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = end }
    } else re += escape(c)
  }
  return new RegExp(`^${re}$`).test(String(path))
}

const isGlob = (p) => GLOB_CHAR.test(p) || p.endsWith('/')
/** The part of a glob before its first glob character — `src/api/` for `src/api/**`. */
const literalPrefix = (p) => { const i = p.search(GLOB_CHAR); return i < 0 ? p : p.slice(0, i) }

/**
 * The shared path two footprint entries stand for, or null. Equal entries, a path a glob matches
 * (either way round), or two globs where one matches the other's literal prefix (D2). The narrower
 * entry is reported — "they share `src/api/routes.ts`" says more than "they share `src/**`".
 */
function sharedPath(x, y) {
  if (x === y) return x
  if (matchesGlob(x, y)) return x
  if (matchesGlob(y, x)) return y
  // A bare directory (`src/lib`, no trailing slash) holds what is under it.
  if (y.startsWith(`${x}/`)) return y
  if (x.startsWith(`${y}/`)) return x
  if (isGlob(x) && isGlob(y)) {
    const px = literalPrefix(x)
    const py = literalPrefix(y)
    if (matchesGlob(py, x) || py.startsWith(px) && x.endsWith('/')) return y
    if (matchesGlob(px, y) || px.startsWith(py) && y.endsWith('/')) return x
  }
  return null
}

const sharedPaths = (xs, ys) => sortedUnique(xs.flatMap((x) => ys.map((y) => sharedPath(x, y)).filter((p) => p != null)))
const meets = (made, used) => made.filter((n) => used.includes(n))

/**
 * Why two footprints overlap (D2), or null when they don't: the shared paths, the interfaces one
 * produces and the other consumes (both directions), and whether PROGRAM.md declared a dependency
 * between them (the caller knows that; a footprint does not). Every reason is reported, so a note
 * can say all of why.
 */
export function overlapOf(a, b, { declared = false } = {}) {
  const paths = sharedPaths(a?.paths ?? [], b?.paths ?? [])
  const interfaces = sortedUnique([...meets(a?.produces ?? [], b?.consumes ?? []), ...meets(b?.produces ?? [], a?.consumes ?? [])])
  if (!paths.length && !interfaces.length && !declared) return null
  return { paths, interfaces, declared: !!declared }
}

/**
 * The overlap graph's edges (D2–D5), one per overlapping pair, `a` before `b` when the pair has an
 * order: a declared dependency first (`b` Depends on `a`), else the producer of an interface before
 * its consumer. Shared paths alone have no order (`directed: false`). Two features that each depend
 * on, or each consume an interface of, the other get an edge each way — a cycle `orderMembers`
 * breaks. A feature with no footprint has not planned, and runs alone until it does (D1): it has no
 * edges, not even declared ones.
 */
export function edgesOf(features) {
  const out = []
  const planned = features.filter((f) => f.footprint)
  for (let i = 0; i < planned.length; i++) {
    for (let j = i + 1; j < planned.length; j++) {
      const x = planned[i]
      const y = planned[j]
      const yOnX = (y.dependsOn ?? []).includes(x.name)
      const xOnY = (x.dependsOn ?? []).includes(y.name)
      const why = overlapOf(x.footprint, y.footprint, { declared: yOnX || xOnY })
      if (!why) continue
      const edge = (a, b, directed) => out.push({ a: a.name, b: b.name, why, directed })
      if (yOnX || xOnY) {
        if (yOnX) edge(x, y, true)
        if (xOnY) edge(y, x, true)
        continue
      }
      const xFirst = meets(x.footprint.produces, y.footprint.consumes).length > 0
      const yFirst = meets(y.footprint.produces, x.footprint.consumes).length > 0
      if (xFirst) edge(x, y, true)
      if (yFirst) edge(y, x, true)
      if (!xFirst && !yFirst) edge(x, y, false)
    }
  }
  return out
}

/**
 * A group's build order (D5): dependencies first (the directed edges), then PROGRAM.md §Children
 * order, then the order the features were named to the fleet, then the order given. A cycle is
 * broken by fleet order: the remaining member named to the fleet first goes next, as if its
 * incoming edges were not there. The result carries, as a non-enumerable `cycle`, the members
 * placed that way, so the fleet can say so in a note.
 */
export function orderMembers(names, { edges = [], programOrder = [], fleetOrder = [] } = {}) {
  const rank = (list, n) => { const i = (list ?? []).indexOf(n); return i < 0 ? Infinity : i }
  const given = (n) => names.indexOf(n)
  const byPriority = (x, y) => rank(programOrder, x) - rank(programOrder, y) || rank(fleetOrder, x) - rank(fleetOrder, y) || given(x) - given(y)
  const byFleet = (x, y) => rank(fleetOrder, x) - rank(fleetOrder, y) || given(x) - given(y)
  const inGroup = new Set(names)
  const before = new Map(names.map((n) => [n, new Set()]))
  for (const e of edges) if (e.directed && inGroup.has(e.a) && inGroup.has(e.b) && e.a !== e.b) before.get(e.b).add(e.a)
  const out = []
  const cycle = []
  const left = new Set(names)
  while (left.size) {
    const ready = [...left].filter((n) => [...before.get(n)].every((p) => !left.has(p)))
    let next
    if (ready.length) next = ready.sort(byPriority)[0]
    else {
      // Only a member on a cycle may go first out of turn; one that merely waits on a cycle still
      // waits for its dependency. `onCycle`: the member reaches itself through remaining members.
      const onCycle = (n) => {
        const seen = new Set()
        const stack = [...before.get(n)].filter((p) => left.has(p))
        while (stack.length) {
          const p = stack.pop()
          if (p === n) return true
          if (seen.has(p)) continue
          seen.add(p)
          stack.push(...[...before.get(p)].filter((q) => left.has(q)))
        }
        return false
      }
      next = [...left].filter(onCycle).sort(byFleet)[0]
      cycle.push(next)
    }
    out.push(next)
    left.delete(next)
  }
  Object.defineProperty(out, 'cycle', { value: cycle, enumerable: false })
  return out
}

/**
 * The fleet's groups (D3): the overlap graph's connected components, each in member order (D5) and
 * cut into chunks of at most `max`. A chunk after the first waits for the one before it to land — an
 * implied dependency, so the cap bounds how long one lane runs without dropping the overlap. A
 * feature with no overlaps is a group of one, which is today's lane. Ids are `g-` + the first
 * member, so a group keeps its id while later members join. Groups come out in the order of their
 * component's first feature in `features`.
 */
export function groupsOf(features, { max = 3, programOrder = [], fleetOrder = [] } = {}) {
  const names = features.map((f) => f.name)
  const edges = edgesOf(features)
  const root = new Map(names.map((n) => [n, n]))
  const find = (n) => { while (root.get(n) !== n) n = root.get(n); return n }
  for (const e of edges) { const ra = find(e.a); const rb = find(e.b); if (ra !== rb) root.set(names.indexOf(ra) < names.indexOf(rb) ? rb : ra, names.indexOf(ra) < names.indexOf(rb) ? ra : rb) }
  const components = new Map()
  for (const n of names) { const r = find(n); if (!components.has(r)) components.set(r, []); components.get(r).push(n) }
  const cap = Math.max(1, Number(max) || 1)
  const out = []
  for (const members of components.values()) {
    const ordered = orderMembers(members, { edges, programOrder, fleetOrder })
    let prev = null
    for (let i = 0; i < ordered.length; i += cap) {
      const chunk = ordered.slice(i, i + cap)
      const id = `g-${chunk[0]}`
      out.push({ id, members: chunk, waitsOn: prev })
      prev = id
    }
  }
  return out
}

/**
 * Engine-split advice (D13): when two features share only a few paths, a prerequisite feature that
 * takes those changes would let both build in parallel instead of stacking. Advice only. Null when
 * they share no path or more than `maxPaths`, and for a declared dependency — those were meant to be
 * built in order.
 */
export function splitAdvice(a, b, overlap, { maxPaths = 10 } = {}) {
  if (!overlap || overlap.declared) return null
  const n = overlap.paths?.length ?? 0
  if (n < 1 || n > maxPaths) return null
  const shown = `${overlap.paths.slice(0, 3).join(', ')}${n > 3 ? '…' : ''}`
  return `${a} and ${b} share ${n} path${n === 1 ? '' : 's'} (${shown}) — a prerequisite feature that takes the shared change would let them build in parallel`
}

/** Groups as an array of `{ id, members }`, from `groupsOf`'s list or fleet.json's `{ [id]: { members } }`. */
const groupList = (groups) => (Array.isArray(groups) ? groups : Object.entries(groups ?? {}).map(([id, g]) => ({ id, ...g })))

/**
 * New collisions found while running (D10): a lane whose changed paths now touch the footprint of a
 * member of another group. `changed` is each lane's `git diff --name-only` since its merge-base;
 * `groups` should be the unlanded ones. A feature's own group never collides with it. One row per
 * feature and group, with the feature's paths that collide.
 */
export function laneCollisions({ changed = {}, groups = [], footprints = {} } = {}) {
  const list = groupList(groups)
  const out = []
  for (const [feature, paths] of Object.entries(changed)) {
    for (const g of list) {
      if ((g.members ?? []).includes(feature)) continue
      const theirs = (g.members ?? []).flatMap((m) => footprints[m]?.paths ?? [])
      const hit = sortedUnique((paths ?? []).filter((p) => theirs.some((t) => sharedPath(p, t) != null)))
      if (hit.length) out.push({ feature, group: g.id, paths: hit })
    }
  }
  return out
}

/**
 * The next walk batch (D8): whole groups, never part of one, in queue order. Groups are added while
 * they fit in `max`; the first that doesn't ends the batch, so nothing behind it in the queue jumps
 * ahead. A group larger than `max` walks alone. A feature `groupOfFeature` (an object or a Map)
 * doesn't name is a group of its own.
 */
export function takeWalkBatch(queue, groupOfFeature, max) {
  const groupOf = (n) => (groupOfFeature instanceof Map ? groupOfFeature.get(n) : groupOfFeature?.[n]) ?? `feature:${n}`
  const batch = []
  const left = [...queue]
  while (left.length) {
    const g = groupOf(left[0])
    const whole = left.filter((n) => groupOf(n) === g)
    if (batch.length && batch.length + whole.length > max) break
    batch.push(...whole)
    for (const n of whole) left.splice(left.indexOf(n), 1)
    if (batch.length >= max) break
  }
  return { batch, rest: left }
}

const LANDABLE = new Set(['signed-off', 'verified'])

/**
 * The landing gate (D9), checked right before a group's tip releases its held merge: every member
 * signed off or verified and none blocked (`blocked: none` is not). The reason names the first member that fails, because
 * that is the one someone has to act on.
 */
export function landingGate(members, manifests) {
  for (const m of members) {
    const man = manifests instanceof Map ? manifests.get(m) : manifests?.[m]
    if (!man) return { ok: false, why: `${m} has no manifest` }
    if (isSet(man.blocked)) return { ok: false, why: `${m} is blocked: ${man.blocked}` }
    if (!LANDABLE.has(man.state)) return { ok: false, why: `${m} is ${man.state ?? 'in no state'}, not signed off` }
  }
  return { ok: true }
}

/** The prefixes a red tip is tested by (D9): member 1, then 1–2, … — the first red one names the member that broke it. */
export const bisectPlan = (members) => members.map((_, i) => members.slice(0, i + 1))

/** The index of the first prefix whose merge tier went red, or -1 when every one is green. */
export const firstFailing = (results) => results.findIndex((r) => !r.green)

/**
 * Whether a change touches only generated files (D15) — then it is not new code, and a sign-off
 * stands. An empty change is not "only generated": there is nothing to excuse.
 */
export const generatedOnly = (paths, generated) => paths.length > 0 && paths.every((p) => (generated ?? []).some((g) => matchesGlob(p, g)))
