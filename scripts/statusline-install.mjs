#!/usr/bin/env node
/**
 * statusline-install — turn builder's status line on or off in the user's Claude Code settings.
 * The only code that edits settings.json; it touches the `statusLine` key and nothing else.
 *
 *   node <plugin>/scripts/statusline-install.mjs [on|off|status|toggle]     # default: toggle
 *
 * on:  copy the launcher to <config>/builder/statusline.mjs, save the current statusLine (unless it
 *      is already builder's) to <config>/builder/statusline.prev.json, point statusLine at the launcher.
 * off: put the saved statusLine back (remove the key when there was none). Refuses when the current
 *      statusLine is not builder's. <config> is $CLAUDE_CONFIG_DIR, else ~/.claude.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { render } from './statusline.mjs'

const SCRIPTS = dirname(fileURLToPath(import.meta.url))
const CONFIG = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const SETTINGS = join(CONFIG, 'settings.json')
const LAUNCHER = join(CONFIG, 'builder', 'statusline.mjs')
const PREV = join(CONFIG, 'builder', 'statusline.prev.json')
const OURS = { type: 'command', command: `node "${LAUNCHER}"`, refreshInterval: 2 }

const fail = (msg) => {
  console.log(`✘ ${msg}`)
  process.exit(1)
}
function loadSettings() {
  if (!existsSync(SETTINGS)) return {}
  try {
    return JSON.parse(readFileSync(SETTINGS, 'utf8'))
  } catch {
    fail(`${SETTINGS} is not valid JSON — fix it first; nothing was changed`)
  }
}
function saveSettings(s) {
  mkdirSync(CONFIG, { recursive: true })
  writeFileSync(`${SETTINGS}.tmp`, JSON.stringify(s, null, 2) + '\n')
  renameSync(`${SETTINGS}.tmp`, SETTINGS)
}
const isOurs = (line) => typeof line?.command === 'string' && line.command.includes(LAUNCHER)
const prevLine = () => {
  try { return JSON.parse(readFileSync(PREV, 'utf8')).statusLine ?? null } catch { return null }
}

function on(s) {
  mkdirSync(dirname(LAUNCHER), { recursive: true })
  copyFileSync(join(SCRIPTS, 'statusline-launcher.mjs'), LAUNCHER)
  if (isOurs(s.statusLine)) return console.log('builder status line: already on (launcher refreshed)')
  writeFileSync(PREV, JSON.stringify({ statusLine: s.statusLine ?? null }, null, 2) + '\n')
  saveSettings({ ...s, statusLine: OURS })
  console.log(`builder status line: on — ${s.statusLine ? 'your previous status line still shows above it' : 'no previous status line'}. Takes effect on the next refresh.`)
}

function off(s) {
  if (!isOurs(s.statusLine)) {
    if (!s.statusLine) return console.log('builder status line: already off')
    fail("the status line isn't builder's — left alone")
  }
  const prev = prevLine()
  const next = { ...s }
  if (prev) next.statusLine = prev
  else delete next.statusLine
  saveSettings(next)
  rmSync(PREV, { force: true })
  console.log(`builder status line: off — ${prev ? 'your previous status line is back' : 'status line removed (there was none before)'}`)
}

function status(s) {
  const onNow = isOurs(s.statusLine)
  console.log(`builder status line: ${onNow ? 'on' : 'off'}`)
  const wrapped = onNow ? prevLine() : s.statusLine
  console.log(`  ${onNow ? 'wrapping' : 'current'}: ${wrapped?.command ?? '(none)'}`)
  if (onNow) console.log(`  here: ${render({ cwd: process.cwd() }) || '(idle — nothing running)'}`)
}

const verb = process.argv[2] ?? 'toggle'
const s = loadSettings()
if (verb === 'on') on(s)
else if (verb === 'off') off(s)
else if (verb === 'status') status(s)
else if (verb === 'toggle') (isOurs(s.statusLine) ? off : on)(s)
else fail(`unknown verb ${verb} — use on, off or status`)
