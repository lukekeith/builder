// codex/scripts/verify/reports.mjs
/**
 * Test reports → Result rows `{ file, name, status: pass|fail|skip, ms, msg }`. `file` is relative
 * to `root` (the suite's cwd) when the report holds absolute paths.
 */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m))
const attrs = (s) => {
  const o = {}
  for (const m of s.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) o[m[1]] = decode(m[2])
  return o
}
export const rel = (f, root) => (root && f && f.startsWith(`${root}/`) ? f.slice(root.length + 1) : f ?? '')
const clip = (s) => (s ? String(s).trim().slice(0, 2000) : null)

/** JUnit XML. A case's file: its `file`, else its suite's `file`, else `classname`, else the suite's name. */
export function parseJUnit(xml, { root = null } = {}) {
  const out = []
  let suite = {}
  for (const m of xml.matchAll(/<testsuite\b([^>]*)>|<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    if (m[1] !== undefined) {
      suite = attrs(m[1])
      continue
    }
    const a = attrs(m[2])
    const body = m[4] ?? ''
    const fail = /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(body)
    const status = fail ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass'
    const msg = fail ? clip(decode([attrs(fail[2]).message, fail[4]].filter(Boolean).join('\n'))) : null
    out.push({ file: rel(a.file ?? suite.file ?? a.classname ?? suite.name, root), name: a.name ?? '', status, ms: Math.round(Number(a.time ?? 0) * 1000), msg })
  }
  return out
}

/** `jest --json`. */
export function parseJestJson(text, { root = null } = {}) {
  const j = JSON.parse(text)
  return (j.testResults ?? []).flatMap((f) =>
    // a file that fails to load or compile has no assertions — without a row a red suite would read as empty
    f.status === 'failed' && !f.assertionResults?.length
      ? [{ file: rel(f.name ?? f.testFilePath, root), name: '<file failed to load>', status: 'fail', ms: 0, msg: clip(f.message) }]
      : (f.assertionResults ?? []).map((a) => ({
      file: rel(f.name ?? f.testFilePath, root),
      name: a.fullName ?? a.title,
      status: a.status === 'passed' ? 'pass' : a.status === 'failed' ? 'fail' : 'skip',
      ms: a.duration ?? 0,
      msg: a.failureMessages?.length ? clip(a.failureMessages.join('\n')) : null,
    })),
  )
}

/** `xcrun xcresulttool get test-results tests --format json`: a test's file is its class + `.swift`. */
export function parseXcresult(text) {
  if (!text.trim()) return []
  const out = []
  const walk = (n, cls) => {
    if (n.nodeType === 'Test Case') {
      const msgs = (n.children ?? []).filter((c) => c.nodeType === 'Failure Message').map((c) => c.name)
      const status = /^(Passed|Expected Failure)$/.test(n.result) ? 'pass' : n.result === 'Skipped' ? 'skip' : 'fail'
      out.push({ file: cls ? `${cls}.swift` : '', name: n.name, status, ms: Math.round((n.durationInSeconds ?? 0) * 1000), msg: msgs.join('\n') || null })
      return
    }
    for (const c of n.children ?? []) walk(c, n.nodeType === 'Test Suite' ? n.name : cls)
  }
  for (const n of JSON.parse(text).testNodes ?? []) walk(n, null)
  return out
}

/** One JSON Result per line (node-reporter.mjs). */
export const parseJsonLines = (text, { root = null } = {}) =>
  text
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      // a runner killed mid-write leaves a truncated last line; keep the rows before it
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
    .map((r) => ({ ...r, file: rel(r.file, root) }))
