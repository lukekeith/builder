#!/usr/bin/env node
/**
 * The session brief's feature list: the in-flight features of the project at argv[2], up to five,
 * most recent first, one line each — name, state, next step. Read from list-features.mjs --json, so
 * the brief and /builder:status never disagree. Prints nothing on any error (the hook stays silent).
 */
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX = 5
try {
  const project = process.argv[2] || process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'list-features.mjs')
  const r = spawnSync(process.execPath, [script, '--json'], {
    cwd: project,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
    encoding: 'utf8',
    timeout: 8000, // under the hook's own 10 s: a slow list drops the list, never the brief
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (r.status === 0 && r.stdout.trim()) {
    const open = (JSON.parse(r.stdout).features ?? [])
      .filter((f) => !f.done && f.feature)
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    const lines = open.slice(0, MAX).map((f) => {
      // list-features' state cell reads `planned · size md · …` — the brief keeps the step.
      const step = String(f.state ?? '').split(' · ')[0].replace(/\s+/g, ' ').trim()
      const state = step ? ` (${step})` : ''
      const next = f.nextStep && f.nextStep !== '—' ? ` — next: ${f.nextStep}` : ''
      const cmd = f.command && f.command !== '—' ? ` · ${f.command}` : ''
      return `- ${f.feature}${state}${next}${cmd}`
    })
    if (open.length > MAX) lines.push(`- … and ${open.length - MAX} more — /builder:status lists them all`)
    if (lines.length) process.stdout.write(lines.join('\n'))
  }
} catch {
  // silent: the brief goes out without the list
}
