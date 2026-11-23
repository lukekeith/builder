/**
 * test-bench — the summaries for E1–E3 (spec docs/specs/2026-11-23-test-efficiency-bench-design.md).
 * Pure: the CLI (test-bench.mjs) does the runs and hands each one's measurement in.
 *
 * A run: { wallMs, timedOut, code, tests, pass, fail, starved, files: { <file>: ms }, peakConn, baseConn }
 */

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const sd = (xs) => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

/**
 * E1 — the floor: one suite, alone, N times at one sha. The coefficient of variation says how far a
 * single run can be trusted; a test that both passed and failed across the reps is flaky.
 */
export function summarizeFloor(runs, results = []) {
  const walls = runs.filter((r) => !r.timedOut).map((r) => r.wallMs)
  const m = mean(walls)
  const seen = new Map()
  for (const rows of results)
    for (const r of rows) {
      const s = seen.get(r.id) ?? new Set()
      s.add(r.status)
      seen.set(r.id, s)
    }
  const flaky = [...seen].filter(([, s]) => s.has('pass') && s.has('fail')).map(([id]) => id).sort()
  // The files that take the most time, by the mean per rep (summed test time, so a lock wait inside a file counts).
  const fileMs = {}
  for (const r of runs) for (const [f, ms] of Object.entries(r.files ?? {})) fileMs[f] = (fileMs[f] ?? 0) + ms / runs.length
  const slowest = Object.entries(fileMs).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([file, ms]) => ({ file, ms: Math.round(ms) }))
  return {
    reps: runs.length, timedOut: runs.filter((r) => r.timedOut).length,
    meanMs: m == null ? null : Math.round(m), minMs: walls.length ? Math.min(...walls) : null, maxMs: walls.length ? Math.max(...walls) : null,
    cv: m ? +(sd(walls) / m).toFixed(3) : null,
    tests: runs.at(-1)?.tests ?? 0, failing: runs.at(-1)?.fail ?? 0, flaky, slowest,
  }
}

/**
 * E2 — the contention curve: n runs of one suite at once, for each n. slowdown(n) = mean wall at n
 * / mean wall at 1; `fits` is the largest n whose slowdown is within `tolerance` with no run
 * starved of connections and none cut at the timeout — the spec's rule for workers and db.max.
 */
export function summarizeContention(levels, tolerance = 1.2) {
  const rows = levels.map(({ n, runs }) => ({
    n,
    meanMs: Math.round(mean(runs.map((r) => r.wallMs))),
    maxMs: Math.max(...runs.map((r) => r.wallMs)),
    timedOut: runs.filter((r) => r.timedOut).length,
    starved: runs.reduce((a, r) => a + (r.starved ?? 0), 0),
    peakConn: Math.max(0, ...runs.map((r) => r.peakConn ?? 0)),
    baseConn: Math.min(...runs.map((r) => r.baseConn ?? Infinity).filter(Number.isFinite), Infinity),
  }))
  const one = rows.find((r) => r.n === 1)
  for (const r of rows) {
    r.slowdown = one && one.meanMs ? +(r.meanMs / one.meanMs).toFixed(2) : null
    if (!Number.isFinite(r.baseConn)) r.baseConn = null
  }
  const ok = rows.filter((r) => r.slowdown != null && r.slowdown <= tolerance && !r.starved && !r.timedOut)
  return { tolerance, rows, fits: ok.length ? Math.max(...ok.map((r) => r.n)) : 0 }
}

/**
 * E3 — lock-wait vs work: each file run alone, one after another, against the whole suite run
 * normally. ratio = whole wall / Σ alone. Near 1, the parallel run does the files one at a time
 * (a suite-wide lock, a shared database); near 1/cores, it is truly parallel. A sample of the files
 * is scaled up to the whole suite and says so.
 */
export function summarizeSerial({ wholeMs, alone, totalFiles }) {
  const sum = alone.reduce((a, x) => a + x.wallMs, 0)
  const scale = alone.length && totalFiles ? totalFiles / alone.length : 1
  const estimated = Math.round(sum * scale)
  return {
    wholeMs, files: alone.length, totalFiles, sampled: alone.length < totalFiles,
    sumAloneMs: estimated, ratio: estimated ? +(wholeMs / estimated).toFixed(2) : null,
    slowest: [...alone].sort((a, b) => b.wallMs - a.wallMs).slice(0, 10).map((x) => ({ file: x.file, ms: x.wallMs })),
  }
}

/** Every k-th of `files`, so a sample spreads across the suite rather than taking its first directory. */
export function spread(files, n) {
  if (!n || n >= files.length) return files
  const k = files.length / n
  return Array.from({ length: n }, (_, i) => files[Math.floor(i * k)])
}

const s = (ms) => (ms == null ? '—' : ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`)

export function renderBench(exp, meta, sum) {
  const L = [`# test-bench ${exp} — ${meta.repo} · ${meta.suite} · ${meta.sha.slice(0, 8)} · ${meta.at}`, '']
  if (exp === 'floor') {
    L.push(`${sum.reps} reps · mean ${s(sum.meanMs)} (min ${s(sum.minMs)}, max ${s(sum.maxMs)}) · CV ${sum.cv ?? '—'} · ${sum.tests} tests, ${sum.failing} failing · ${sum.timedOut} cut at the timeout`, '')
    if (sum.flaky.length) L.push(`Flaky across the reps (${sum.flaky.length}):`, ...sum.flaky.map((f) => `- ${f}`), '')
    L.push('| Slowest files (summed test time per rep) | |', '|---|---|', ...sum.slowest.map((f) => `| ${f.file} | ${s(f.ms)} |`))
  } else if (exp === 'contention') {
    L.push(`Largest n within ${sum.tolerance}× of one run, none starved or cut: **${sum.fits}**`, '')
    L.push('| Runs at once | Mean wall | Max wall | Slowdown | Starved tests | Cut | Peak connections (start) |', '|---|---|---|---|---|---|---|')
    for (const r of sum.rows) L.push(`| ${r.n} | ${s(r.meanMs)} | ${s(r.maxMs)} | ${r.slowdown ?? '—'}× | ${r.starved} | ${r.timedOut} | ${r.peakConn} (${r.baseConn ?? '—'}) |`)
  } else {
    L.push(`Whole suite ${s(sum.wholeMs)} · ${sum.files}${sum.sampled ? ` of ${sum.totalFiles}` : ''} files alone, one after another: Σ ${s(sum.sumAloneMs)}${sum.sampled ? ' (scaled from the sample)' : ''} · ratio **${sum.ratio}**`, '')
    L.push('A ratio near 1 means the parallel run does the files one at a time.', '')
    L.push('| Slowest files alone | |', '|---|---|', ...sum.slowest.map((f) => `| ${f.file} | ${s(f.ms)} |`))
  }
  return L.join('\n') + '\n'
}
