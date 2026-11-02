// codex/scripts/verify/node-reporter.mjs
/**
 * A node:test reporter writing one Result per test as a JSON line: file, name path (describe
 * names joined with ' > '), status, ms, msg. Node's own junit reporter does not say which file a
 * test lives in, and the verifier needs that to re-run one test and to know whether a branch owns it.
 */
export default async function* reporter(source) {
  const stacks = new Map() // file → [name at each nesting]
  for await (const ev of source) {
    const d = ev.data ?? {}
    const file = d.file ?? ''
    const stack = stacks.get(file) ?? stacks.set(file, []).get(file)
    if (ev.type === 'test:start') {
      stack[d.nesting] = d.name
      stack.length = d.nesting + 1
      continue
    }
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') continue
    if (d.details?.type === 'suite') continue
    const err = d.details?.error
    yield JSON.stringify({
      file,
      name: [...stack.slice(0, d.nesting), d.name].join(' > '),
      status: ev.type === 'test:fail' ? 'fail' : d.skip || d.todo ? 'skip' : 'pass',
      ms: Math.round(d.details?.duration_ms ?? 0),
      msg: err ? String(err.cause?.stack ?? err.cause ?? err.message ?? err).slice(0, 2000) : null,
    }) + '\n'
  }
}
