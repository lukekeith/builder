#!/usr/bin/env node
// A fleet that hangs: it starts a long-lived child (a dev server, a claude session), records its pid, and never exits.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
const fleet = join(process.cwd(), '.builder', 'fleet')
mkdirSync(fleet, { recursive: true })
const child = spawn('sleep', ['60'], { stdio: 'ignore' })
writeFileSync(join(fleet, 'child.pid'), String(child.pid))
setInterval(() => {}, 1000)
