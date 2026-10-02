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
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, rmSync, realpathSync, statSync, chmodSync } from 'node:fs'
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
/** Atomic, onto the real file: a symlinked settings.json (dotfiles) stays a symlink, and keeps its mode. */
function saveSettings(s) {
  mkdirSync(CONFIG, { recursive: true })
  const target = existsSync(SETTINGS) ? realpathSync(SETTINGS) : SETTINGS
  const tmp = `${target}.builder-tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n')
  if (existsSync(target)) chmodSync(tmp, statSync(target).mode & 0o777)
  renameSync(tmp, target)
}
const isOurs = (line) => typeof line?.command === 'string' && line.command.includes(LAUNCHER)
/** Any builder launcher, however its path is spelled — never saved as the line to wrap. */
const isALauncher = (line) => typeof line?.command === 'string' && /builder[\/\\]statusline\.mjs/.test(line.command)
const prevLine = () => {
  try { return JSON.parse(readFileSync(PREV, 'utf8')).statusLine ?? null } catch { return null }
}

function on(s) {
  mkdirSync(dirname(LAUNCHER), { recursive: true })
  copyFileSync(join(SCRIPTS, 'statusline-launcher.mjs'), LAUNCHER)
  if (isOurs(s.statusLine)) return console.log('builder status line: already on (launcher refreshed)')
  const keep = isALauncher(s.statusLine) ? null : s.statusLine ?? null
  if (s.statusLine && !keep) console.log(`  (the current status line is a builder launcher — not wrapped: ${s.statusLine.command})`)
  writeFileSync(PREV, JSON.stringify({ statusLine: keep }, null, 2) + '\n')
  saveSettings({ ...s, statusLine: OURS })
  console.log(`builder status line: on — ${keep ? 'your previous status line still shows above it' : 'no previous status line'}. Takes effect on the next refresh.`)
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
