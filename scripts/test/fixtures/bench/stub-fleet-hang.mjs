#!/usr/bin/env node
// A fleet that hangs: it starts a long-lived child (a dev server, a claude session), records its pid, and never exits.
// With STUB_FLEET_PGIDS it also starts a session in its own process group, as the real fleet does, and records
// that group in fleet.json beside pgid 1 and STUB_EXTRA_PGID — groups bench-case must never signal.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
const fleet = join(process.cwd(), '.builder', 'fleet')
mkdirSync(fleet, { recursive: true })
const child = spawn('sleep', ['60'], { stdio: 'ignore' })
writeFileSync(join(fleet, 'child.pid'), String(child.pid))
if (process.env.STUB_FLEET_PGIDS) {
  const session = spawn('sleep', ['60'], { stdio: 'ignore', detached: true })
  writeFileSync(join(fleet, 'session.pid'), String(session.pid))
  const extra = Number(process.env.STUB_EXTRA_PGID)
  writeFileSync(join(fleet, 'fleet.json'), JSON.stringify({ features: { f: { status: 'building', pgid: session.pid, startPgid: 1 }, g: { status: 'building', pgid: extra } } }))
}
setInterval(() => {}, 1000)
