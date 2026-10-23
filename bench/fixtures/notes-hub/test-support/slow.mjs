// The per-file setup cost every test file in this repo pays — it stands in for what a real suite
// spends seeding a database or launching a browser. Import it first in every test file:
//   import '../../../test-support/slow.mjs'
// SLOW_TESTS_MS sets the wait (default 4000 ms); SLOW_TESTS_MS=0 skips it.
import { setTimeout as sleep } from 'node:timers/promises'

const ms = Number(process.env.SLOW_TESTS_MS ?? 4000)
if (ms > 0) await sleep(ms)
