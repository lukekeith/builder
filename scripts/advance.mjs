#!/usr/bin/env node
/**
 * advance — ONE state change of a feature, in one call: the manifest keys, `head:`, a ledger line and
 * the commit, instead of a hand-typed `sed` + `echo >>` + `git add && git commit` per transition.
 *
 *   node <builder>/scripts/advance.mjs <folder> [--set key=value]… [--unset key]… [--head]
 *        [--ledger "<line>"]… [--add <path>]… [--commit "<subject>" | <preset>]
 *        [--body "<text>"] [--trailer "<line>"]… [--no-commit]
 *
 *   --set key=value  a manifest line, replaced in place or inserted in REFERENCE §MANIFEST.md's order
 *   --unset key      drop a manifest line
 *   --head           `head:` = the short HEAD sha before this commit; `branch:` too, when the line exists
 *   --ledger "<l>"   append to <WS>/progress.md (created with its identity line); a line already
 *                    there is not added twice
 *   --add <path>     another tracked path to commit with the manifest (a SPEC edit, a `git rm`-ed PLAN)
 *   --commit         the subject. `{key}` is the ticket or the feature, `{feature}` the feature; a
 *                    preset names a subject the skills fix: audited · aligned · plan · built ·
 *                    walk-lane · verify-ready · verify-incomplete
 *   --body / --trailer  the message body, and trailer lines after it. The skills ask for no trailer;
 *                    pass one when your harness asks for an attribution line
 *
 * Commits ONLY the manifest and the --add paths (`git commit -- <paths>`): unrelated work in the tree
 * or the index is never swept in.
 *
 * Safe to re-run after a crash: a line already in the ledger is skipped, an unchanged manifest is not
 * rewritten, and when HEAD already carries this subject with every requested key in place, the whole
 * call reports `already applied` and does nothing. A crash between the write and the commit is
 * finished by running the same command again.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openFeature, setManifestKeys, appendLedger, writeAtomic, git, shortHead, currentBranch, posix, parseArgs, cli, read } from './feature-core.mjs'

export const PRESETS = {
  audited: 'docs({key}): {feature} audited',
  aligned: 'docs({key}): {feature} aligned',
  plan: 'docs({key}): plan {feature}',
  built: 'chore({key}): {feature} — built, awaiting the walk',
  'walk-lane': 'chore({key}): {feature} — phases closed, awaiting the walk lane',
  'verify-ready': 'docs({key}): {feature} — verify READY',
  'verify-incomplete': 'docs({key}): {feature} — verify INCOMPLETE',
}

export const subjectOf = (s, f) => (PRESETS[s] ?? s).replaceAll('{key}', f.key).replaceAll('{feature}', f.feature)

const parseSets = (list = []) =>
  list.map((s) => {
    const m = /^([a-z][a-z-]*)=(.*)$/s.exec(s)
    if (!m) throw new Error(`--set wants key=value (got: ${s})`)
    return [m[1], m[2]]
  })

/**
 * The state change, as a function (condense calls it too). → { lines: string[] } describing what it did.
 * opts: { sets: [[k,v]], unsets: [k], head: bool, ledger: [line], add: [abs path], commit: subject|null,
 *         body, trailers: [line], noCommit }
 */
export function advance(f, opts) {
  const { sets = [], unsets = [], head = false, ledger = [], add = [], commit = null, body = null, trailers = [], noCommit = false } = opts
  const out = []
  const subject = commit ? subjectOf(commit, f) : null
  const cur = read(f.manifestPath)
  if ((sets.length || unsets.length || head) && cur == null) throw new Error(`no MANIFEST.md in ${f.dir}`)

  // Already applied? HEAD carries this subject, every key is as asked, every ledger line is there.
  if (subject && !noCommit && git(f.root, ['log', '-1', '--format=%s'], { allowFail: true }) === subject) {
    const sameKeys = cur == null || setManifestKeys(cur, sets, unsets) === setManifestKeys(cur, [], [])
    const ledgerText = read(`${f.ws({ create: false })}/progress.md`) ?? ''
    const have = new Set(ledgerText.split('\n'))
    const sameLedger = ledger.every((l) => String(l).split('\n').every((x) => !x.trim() || have.has(x)))
    const paths = commitPaths(f, add)
    const clean = !paths.length || git(f.root, ['status', '--porcelain', '--', ...paths]) === ''
    if (sameKeys && sameLedger && clean) {
      out.push(`already applied: ${shortHead(f.root)} ${subject}`)
      return { lines: out }
    }
  }

  if (cur != null && (sets.length || unsets.length || head)) {
    const all = [...sets]
    if (head) {
      const sha = shortHead(f.root)
      if (sha) all.push(['head', sha])
      const br = currentBranch(f.root)
      if (br && /^branch:/m.test(cur)) all.push(['branch', br])
    }
    const next = setManifestKeys(cur, all, unsets)
    if (next !== setManifestKeys(cur, [], [])) {
      writeAtomic(f.manifestPath, next)
      out.push(`manifest: ${[...all.map(([k, v]) => `${k}=${v}`), ...unsets.map((k) => `-${k}`)].join(' · ')}`)
    } else out.push('manifest: unchanged')
  }

  if (ledger.length) {
    const r = appendLedger(f.ws(), f.rel, ledger.join('\n'))
    out.push(r.added.length ? `ledger: +${r.added.length} line${r.added.length === 1 ? '' : 's'} → ${r.path}` : 'ledger: already has it')
  }

  if (subject && !noCommit) {
    const paths = commitPaths(f, add)
    if (!paths.length || git(f.root, ['status', '--porcelain', '--', ...paths]) === '') out.push(`commit: nothing to commit for ${subject}`)
    else {
      const msg = [subject, body, trailers.length ? trailers.join('\n') : null].filter(Boolean).join('\n\n')
      // A path already `git rm`-ed is in neither the tree nor the index: nothing to add, the commit takes it.
      const addable = paths.filter((p) => existsSync(resolve(f.root, p)) || git(f.root, ['ls-files', '--error-unmatch', '--', p], { allowFail: true }) !== null)
      if (addable.length) git(f.root, ['add', '-A', '--', ...addable])
      git(f.root, ['commit', '-q', '-F', '-', '--', ...paths], { input: msg + '\n' })
      out.push(`commit: ${shortHead(f.root)} ${subject}`)
    }
  }
  return { lines: out }
}

/** The manifest plus the --add paths, relative to the repo, keeping only ones git can commit. */
function commitPaths(f, add) {
  const all = [f.manifestPath, ...add].map((p) => posix(relative(f.root, resolve(p))))
  const known = (p) =>
    existsSync(resolve(f.root, p)) ||
    git(f.root, ['ls-files', '--error-unmatch', '--', p], { allowFail: true }) !== null ||
    git(f.root, ['cat-file', '-e', `HEAD:${p}`], { allowFail: true }) !== null
  return [...new Set(all)].filter(known)
}

async function main(argv) {
  const a = parseArgs(argv, { repeat: ['set', 'unset', 'ledger', 'add', 'trailer'], bool: ['head', 'no-commit'] })
  if (!a._[0]) {
    console.error('usage: advance.mjs <folder> [--set key=value]… [--unset key]… [--head] [--ledger "<line>"]… [--add <path>]… [--commit "<subject>"|<preset>] [--body "<text>"] [--trailer "<line>"]…')
    return 2
  }
  const sets = parseSets(a.set)
  const f = openFeature(a._[0])
  const r = advance(f, {
    sets,
    unsets: a.unset ?? [],
    head: !!a.head,
    ledger: a.ledger ?? [],
    add: a.add ?? [],
    commit: a.commit ?? null,
    body: a.body ?? null,
    trailers: a.trailer ?? [],
    noCommit: !!a['no-commit'],
  })
  for (const l of r.lines) console.log(l)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli(main)
