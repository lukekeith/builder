// Records every path the process reads or lists. Imported by a test, `spy(fn)` patches fs and
// returns the restore; run as `node --import <this> …` with SPY_OUT set, it logs to that file.
// syncBuiltinESMExports makes `import { readFileSync } from 'node:fs'` in other modules see the patch.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const append = fs.appendFileSync

export function spy(onPath) {
  const saved = {}
  for (const k of ['readFileSync', 'readdirSync', 'statSync']) {
    saved[k] = fs[k]
    fs[k] = function (p, ...rest) {
      onPath(String(p))
      return saved[k].call(this, p, ...rest)
    }
  }
  syncBuiltinESMExports()
  return () => {
    Object.assign(fs, saved)
    syncBuiltinESMExports()
  }
}

if (process.env.SPY_OUT) spy((p) => append(process.env.SPY_OUT, `${p}\n`))
