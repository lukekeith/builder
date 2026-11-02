#!/usr/bin/env node
/**
 * archive — the registry back to work in flight (Claude 5.4's /builder:archive, adapted: Codex has
 * no ship/condense step and no fleet, and a Codex landing is the verifier's merge commit
 * `Merge builder feature <name>` on the target). Finished folders leave `<registry>/` for
 * `<registry>/_archive/`, each keeping only its SPEC.md (PROGRAM.md for a program) under a header
 * that says how it ended; `git log -- <folder>` keeps everything else. `$builder archive` drives
 * it: `plan` is the review, `apply` the one confirmed change.
 *
 *   node <plugin>/scripts/archive.mjs plan [--root R] [--into <branch>] [--days N] [--json | --summary]
 *   node <plugin>/scripts/archive.mjs apply <name>… [--root R] [--into <branch>] [--days N] [--drop "<name>=<reason>"]… [--no-commit]
 *
 * Finished (the recommended batch):
 *   shipped   — says it shipped (registry.mjs isShippedFolder), never moved → archived as it reads
 *   landed    — landed through the merge queue (a `Merge builder feature <name>` commit on the
 *               target, or the Codex runtime record's mergedHead), which needs verify READY
 *               → `✅ SHIPPED <date> — merged <sha>`
 *   merged    — in the target at built · signed-off · verified with no landing of record (a manual
 *               merge), untouched for --days (14) → `✅ CLOSED <date> — merged <sha>, not walked`
 *               (`walked, not verified` once signed off) — never called shipped
 *   program   — every child named on its manifest's `child:` lines is archived
 *   leftovers — an archived folder still holding PLAN, MANIFEST, ledger… beside its SPEC → trimmed;
 *               an ignored `.builder/<name>` workspace of an archived feature, nothing in it newer
 *               than the archiving → removed
 * Old (only when the owner says so):
 *   abandoned — spec … building, no commit to the folder or its branch for 4 × --days
 *               → `✖ DROPPED <date> — no activity since <date>` (or --drop's reason); a dropped
 *               feature never satisfies a program dependency (registry.mjs archivedOutcome)
 *   legacy    — no SPEC.md, PROGRAM.md or manifest (an earlier pipeline's docs) → moved whole
 *
 * Never touched: a folder with uncommitted changes, a feature with a live Codex runtime record (its
 * worktree is still there — resume or clean it up first), a name the archive already holds.
 * `apply` runs on the target branch (merged work is judged there) with a clean registry, puts a
 * folder that fails half-way back as it was, and makes one commit:
 * `docs(archive): <n> folders — <names>`. It never pushes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { features, ARCHIVE, isShippedFolder, isArchived, archivedOutcome } from './registry.mjs';
import { parseManifest, isSet } from './manifest.mjs';
import { buildingInSession } from './offer.mjs';

const DAY = 86400000;
const ALWAYS_GO = /^(PLAN|MANIFEST|PARKED)\.md$|^continue\.md$|^progress\.md$|^ledger\.md$|^TASK[\w-]*RESULT[\w-]*(\.md)?$/i;
const KEEP_DOCS = ['SPEC.md', 'PROGRAM.md'];
const BUILT = ['built', 'signed-off', 'verified'];
const IN_FLIGHT = ['exploring', 'spec', 'aligned', 'audited', 'planned', 'building'];

const gitStrict = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (root, args) => { try { return gitStrict(root, args); } catch { return null; } };
const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const today = () => process.env.BUILDER_TODAY || isoDay(Date.now());

/** The branch archive judges merged work on: --into, merge_into, `current`'s branch, else base_branch. */
export function targetOf(root, cfg, into) {
  if (into) return into;
  if (cfg.mergeIntoCurrent) {
    const b = git(root, ['symbolic-ref', '--short', 'HEAD']);
    if (b && !b.startsWith('builder/')) return b;
  }
  return cfg.mergeInto;
}

/** Codex's machine-local feature record (lifecycle.mjs), or null. */
function runtimeRecord(root, name) {
  const common = git(root, ['rev-parse', '--git-common-dir']);
  if (!common) return null;
  try { return JSON.parse(read(path.join(path.resolve(root, common), 'builder-codex', 'features', `${name}.json`))); } catch { return null; }
}

/** The short sha of the merge-queue commit that landed `name` on HEAD, or null. */
function landingCommit(root, name, rec) {
  if (rec?.phase === 'merged' && rec.mergedHead && git(root, ['merge-base', '--is-ancestor', rec.mergedHead, 'HEAD']) !== null) return git(root, ['rev-parse', '--short', rec.mergedHead]);
  const subject = `Merge builder feature ${name}`;
  const rows = (git(root, ['log', '--first-parent', '--fixed-strings', `--grep=${subject}`, '--format=%h%x09%s', 'HEAD']) ?? '').split('\n');
  return rows.map(r => r.split('\t')).find(([, s]) => s === subject)?.[0] ?? null;
}

/** When the folder, or its own branch, last moved (epoch ms; 0 = never committed). */
function lastMoved(root, rel, mf, name, mainline) {
  const at = args => Number(git(root, args) ?? 0) * 1000;
  const folder = at(['log', '-1', '--format=%ct', '--', rel]);
  const branch = isSet(mf.branch) ? String(mf.branch).trim() : `builder/${name}`;
  const own = !mainline.includes(branch) && git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !== null;
  return Math.max(folder, own ? at(['log', '-1', '--format=%ct', `refs/heads/${branch}`]) : 0);
}

/** The tracked top-level entries trimming removes: working files and anything the SPEC does not name. None without a SPEC/PROGRAM. */
export function trimList(root, dir) {
  const docs = KEEP_DOCS.map(d => read(path.join(dir, d))).filter(t => t != null);
  if (!docs.length) return [];
  const text = docs.join('\n');
  const rel = path.relative(root, dir).split(path.sep).join('/');
  const tracked = (git(root, ['ls-files', '--', rel]) ?? '').split('\n').filter(Boolean);
  const tops = [...new Set(tracked.map(p => p.slice(rel.length + 1).split('/')[0]))];
  return tops.filter(e => !KEEP_DOCS.includes(e) && (ALWAYS_GO.test(e) || !text.includes(e))).sort();
}

/** The newest mtime of any file under dir (ms), or 0. */
function newest(dir, depth = 0) {
  let n = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 6) n = Math.max(n, newest(p, depth + 1)); }
    else try { n = Math.max(n, fs.statSync(p).mtimeMs); } catch { /* gone */ }
  }
  return n;
}

/** Ignored `.builder/<name>` workspaces of archived features with no live folder, nothing newer than the archiving. */
function orphanWorkspaces(root, reg) {
  let names = [];
  try { names = fs.readdirSync(path.join(root, '.builder'), { withFileTypes: true }).filter(e => e.isDirectory() && !/^[_.]/.test(e.name)).map(e => e.name); } catch { return []; }
  return names.filter(n => {
    if (!isArchived(root, reg, n) || fs.existsSync(path.join(root, reg, n))) return false;
    const archived = Math.max(...KEEP_DOCS.map(d => { try { return fs.statSync(path.join(root, reg, ARCHIVE, n, d)).mtimeMs; } catch { return 0; } }));
    // A file newer than the archived record means the name is being reused: never a leftover.
    return newest(path.join(root, '.builder', n)) <= archived;
  }).sort();
}

/**
 * Every folder archive could act on — `items` ({ name, kind, tier, action, why, path, moved, sha? })
 * — and `left`, the live folders it leaves alone and why.
 */
export function plan(root, cfg, { target = targetOf(root, cfg), days = 14, now = Date.now() } = {}) {
  const reg = cfg.registry;
  const items = [];
  const left = [];
  const onTarget = git(root, ['symbolic-ref', '--short', 'HEAD']) === target;
  for (const name of features(root, reg).sort()) {
    const rel = `${reg}/${name}`;
    const dir = path.join(root, rel);
    const mfText = read(path.join(dir, 'MANIFEST.md'));
    const mf = mfText ? parseManifest(mfText) : {};
    const hasSpec = fs.existsSync(path.join(dir, 'SPEC.md'));
    const isProgram = fs.existsSync(path.join(dir, 'PROGRAM.md')) || mf.tier === 'program';
    const moved = lastMoved(root, rel, mf, name, [target, cfg.baseBranch]);
    const add = (kind, tier, action, why, extra = {}) => items.push({ name, kind, tier, action, why, path: rel, moved: moved ? isoDay(moved) : null, ...extra });
    if (git(root, ['status', '--porcelain', '--', rel])) { left.push({ name, why: 'uncommitted changes in the folder' }); continue; }
    const rec = runtimeRecord(root, name);
    if (rec && rec.phase !== 'merged' && !rec.cleaned && rec.worktree && fs.existsSync(rec.worktree)) {
      left.push({ name, why: buildingInSession(rec, now) ? 'running now' : `a live feature (${rec.phase}, worktree ${rec.worktree}) — resume it, or clean it up first` });
      continue;
    }
    if (isArchived(root, reg, name)) { left.push({ name, why: `${reg}/${ARCHIVE}/${name} already exists — two folders of one name would make "has it shipped?" answer for the wrong one` }); continue; }
    if (isShippedFolder(dir)) { add('shipped', 'finished', 'archive', 'says it shipped; never moved into the archive', { sha: landingCommit(root, name, rec) ?? git(root, ['log', '-1', '--format=%h', '--', rel]) }); continue; }
    if (isProgram) {
      const kids = (mf.children ?? []).map(c => c.trim().split(/\s+/)[0]).filter(Boolean);
      const ended = kids.map(k => archivedOutcome(root, reg, k));
      if (kids.length && ended.every(Boolean)) {
        const n = k => ended.filter(x => x === k).length;
        const tally = { shipped: n('shipped'), closed: n('closed'), dropped: n('dropped') };
        add('program', 'finished', 'program', `every child ended — ${Object.entries(tally).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ')}`, { kids: tally });
      } else left.push({ name, why: kids.length ? `a program — ${kids.length - ended.filter(Boolean).length} of its ${kids.length} children not archived yet` : 'a program with no child: lines in its manifest' });
      continue;
    }
    const state = mf.state ?? mf.phase ?? null;
    // A name reused for new work (back in flight) is not the feature that landed under it.
    const landed = onTarget && !IN_FLIGHT.includes(state) ? landingCommit(root, name, rec) : null;
    if (landed) { add('landed', 'finished', 'ship', `landed on ${target} through the merge queue (${landed}) — verified before it landed`, { sha: landed }); continue; }
    if (onTarget && BUILT.includes(state)) {
      if (now - moved <= days * DAY) { left.push({ name, why: `${state}, last moved ${moved ? isoDay(moved) : 'never'} — still in hand; archive closes one after ${days} days` }); continue; }
      const walked = state !== 'built';
      add('merged', 'finished', 'close', `${state} and in ${target} with no landing of record; never verified`, { sha: git(root, ['log', '-1', '--format=%h', '--', rel]), walked });
      continue;
    }
    if (IN_FLIGHT.includes(state)) {
      const since = moved ? isoDay(moved) : 'it was written';
      if (now - moved > 4 * days * DAY) add('abandoned', 'old', 'drop', `${state}; nothing moved since ${since}`, { reason: `no activity since ${since}` });
      else left.push({ name, why: `${state} — in flight` });
      continue;
    }
    if (!mfText && !hasSpec) { add('legacy', 'old', 'move', 'no SPEC.md and no manifest — an earlier pipeline\'s docs or notes; moved as it is'); continue; }
    left.push({ name, why: !onTarget && state ? `${state} — archive judges merged work on ${target}` : `${state ?? 'no state'} — in flight` });
  }
  const archDir = path.join(root, reg, ARCHIVE);
  for (const name of fs.existsSync(archDir) ? fs.readdirSync(archDir).filter(n => !n.startsWith('.')).sort() : []) {
    const dir = path.join(archDir, name);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    const rel = `${reg}/${ARCHIVE}/${name}`;
    const gone = trimList(root, dir);
    if (gone.length && !git(root, ['status', '--porcelain', '--', rel])) items.push({ name, kind: 'leftovers', tier: 'finished', action: 'trim', why: `archived, still holding ${gone.join(', ')}`, path: rel, moved: null });
  }
  for (const name of orphanWorkspaces(root, reg)) items.push({ name, kind: 'leftovers', tier: 'finished', action: 'workspace', why: `.builder/${name} of an archived feature`, path: `.builder/${name}`, moved: null });
  return { target, onTarget, days, items, left };
}

/** The SPEC/PROGRAM with `line` as the header under its `# ` title; null when there is no title. */
export function withHeader(text, line) {
  const lines = text.split('\n');
  const t = lines.findIndex(l => /^# /.test(l));
  if (t < 0) return null;
  // Directly under the title, the first line of any `> ` header block already there (Claude's layout).
  const next = lines[t + 1];
  lines.splice(t + 1, 0, ...(next === undefined || !next.trim() || next.startsWith('>') ? [line] : [line, '']));
  return lines.join('\n');
}

function writeHeader(dir, line) {
  for (const d of KEEP_DOCS) {
    const p = path.join(dir, d);
    const text = read(p);
    if (text == null) continue;
    const next = withHeader(text, line);
    if (next == null) return false;
    fs.writeFileSync(p, next);
    return true;
  }
  return false;
}

function trim(root, dir) {
  const gone = trimList(root, dir);
  const rel = path.relative(root, dir).split(path.sep).join('/');
  for (const e of gone) gitStrict(root, ['rm', '-r', '-q', '-f', '--', `${rel}/${e}`]);
  return gone;
}

function applyOne(root, reg, it, dropReason) {
  if (it.action === 'workspace') { fs.rmSync(path.join(root, '.builder', it.name), { recursive: true, force: true }); return `✓ ${it.path} — removed`; }
  if (it.action === 'trim') return `✓ ${it.name} — trimmed: ${trim(root, path.join(root, it.path)).join(', ')} removed`;
  const dir = path.join(root, reg, it.name);
  const date = today();
  const k = it.kids;
  const header = {
    archive: /^> ✅ SHIPPED/m.test((read(path.join(dir, 'SPEC.md')) ?? '').slice(0, 1200)) || !fs.existsSync(path.join(dir, 'SPEC.md')) ? null : `> ✅ SHIPPED ${date} — merged ${it.sha}`,
    ship: `> ✅ SHIPPED ${date} — merged ${it.sha}`,
    close: `> ✅ CLOSED ${date} — merged ${it.sha}, ${it.walked ? 'walked, not verified' : 'not walked'}`,
    drop: `> ✖ DROPPED ${date} — ${dropReason ?? it.reason}`,
    program: k && (k.shipped || k.closed ? `> ✅ ${k.shipped && !k.closed ? 'SHIPPED' : 'CLOSED'} ${date} — every child ended: ${['shipped', 'closed', 'dropped'].filter(x => k[x]).map(x => `${k[x]} ${x}`).join(', ')}` : `> ✖ DROPPED ${date} — every child dropped`),
    move: null,
  }[it.action];
  // A drop or close with no SPEC/PROGRAM gets a minimal SPEC.md carrying its header — else archivedOutcome would read it as shipped.
  if (['drop', 'close'].includes(it.action) && !KEEP_DOCS.some(d => fs.existsSync(path.join(dir, d)))) fs.writeFileSync(path.join(dir, 'SPEC.md'), `# ${it.name}\n`);
  const hasDoc = KEEP_DOCS.some(d => fs.existsSync(path.join(dir, d)));
  if (header && hasDoc && !writeHeader(dir, header)) throw new Error(`its ${fs.existsSync(path.join(dir, 'SPEC.md')) ? 'SPEC.md' : 'PROGRAM.md'} has no "# " title line to put the header under`);
  const gone = hasDoc && it.action !== 'move' ? trim(root, dir) : [];
  fs.mkdirSync(path.join(root, reg, ARCHIVE), { recursive: true });
  gitStrict(root, ['add', '-A', '--', `${reg}/${it.name}`]);
  gitStrict(root, ['mv', `${reg}/${it.name}`, `${reg}/${ARCHIVE}/${it.name}`]);
  fs.rmSync(path.join(root, '.builder', it.name), { recursive: true, force: true });
  const what = { archive: 'archived', ship: `shipped (merged ${it.sha})`, close: 'closed (not shipped)', drop: 'dropped', move: 'moved as it is', program: 'archived (program)' }[it.action];
  return `✓ ${it.name} — ${what}${gone.length ? `; ${gone.join(', ')} removed` : ''}`;
}

/** Put one half-done item back to HEAD (the registry was clean when apply began). → whether it got there. */
function rollback(root, reg, it) {
  if (it.action === 'workspace') return true;
  const live = it.path.startsWith(`${reg}/${ARCHIVE}/`) ? null : `${reg}/${it.name}`;
  const arch = `${reg}/${ARCHIVE}/${it.name}`;
  const paths = [live, arch].filter(Boolean);
  git(root, ['reset', '-q', '--', ...paths]);
  if (live) { git(root, ['checkout', '-q', 'HEAD', '--', live]); git(root, ['clean', '-fdq', '--', arch]); }
  else git(root, ['checkout', '-q', 'HEAD', '--', arch]);
  return !git(root, ['status', '--porcelain', '--', ...paths]);
}

export function apply(root, cfg, names, { target = targetOf(root, cfg), days = 14, drop = {}, commit = true } = {}) {
  const reg = cfg.registry;
  const p = plan(root, cfg, { target, days });
  if (!p.onTarget) return { ok: false, lines: [`archive runs on ${target}, where merged work is — switch to it (git switch ${target}). Nothing was changed.`] };
  const dirty = git(root, ['status', '--porcelain', '--', reg]);
  if (dirty) return { ok: false, lines: [`uncommitted changes under ${reg} — commit them or set them aside first. Nothing was changed.\n${dirty}`] };
  const lines = [];
  const done = [];
  let refused = 0;
  let stuck = false;
  for (const arg of names) {
    // A row's first column (`<registry>/<name>`) and a bare name are the same folder.
    const name = arg.startsWith(`${reg}/`) && !arg.startsWith(`${reg}/${ARCHIVE}/`) ? arg.slice(reg.length + 1) : arg;
    let it = p.items.find(i => i.name === name || i.path === arg || i.path === name);
    const why = p.left.find(l => l.name === name)?.why;
    // The owner dropping a folder archive left as in flight: their call, with their reason — never
    // one running, live, uncommitted, a program, or a name the archive already holds.
    if (!it && drop[name] && why && !/running now|a live feature|uncommitted|already exists|a program/.test(why)) it = { name, kind: 'abandoned', tier: 'old', action: 'drop', path: `${reg}/${name}` };
    if (!it) { refused++; lines.push(`✗ ${name} — ${why ? `left alone: ${why}` : 'not a folder archive would act on'}`); continue; }
    try {
      lines.push(applyOne(root, reg, it, it.action === 'drop' ? drop[it.name] ?? drop[name] ?? null : null));
      if (it.action !== 'workspace') done.push(it.name);
    } catch (e) {
      refused++;
      const back = rollback(root, reg, it);
      if (!back) stuck = true;
      lines.push(`✗ ${name} — ${String(e.stderr || e.message).trim().split('\n').pop()}${back ? ' — put back as it was' : ` — could not be put back: check git status -- ${it.path}`}`);
    }
  }
  if (stuck) lines.push(`nothing committed — a folder could not be put back, so the registry holds a half-archived folder; check git status -- ${reg}`);
  else if (done.length && commit && git(root, ['status', '--porcelain', '--', reg])) {
    gitStrict(root, ['add', '-A', '--', reg]);
    const shown = done.length > 4 ? `${done.slice(0, 4).join(', ')} and ${done.length - 4} more` : done.join(', ');
    gitStrict(root, ['commit', '-q', '-m', `docs(archive): ${done.length} folder${done.length === 1 ? '' : 's'} — ${shown}`, '--', reg]);
    lines.push(`committed: ${git(root, ['log', '-1', '--format=%h %s'])}`);
  }
  return { ok: !refused, lines };
}

/** One line for `$builder status`. */
export function summaryLine(p) {
  const finished = p.items.filter(i => i.tier === 'finished').length;
  const old = p.items.filter(i => i.tier === 'old').length;
  if (!finished && !old) return 'registry: clean';
  return `registry: ${[finished && `${finished} finished`, old && `${old} old`].filter(Boolean).join(' · ')} to archive → $builder archive`;
}

const KIND = { program: 'Program, every child ended', shipped: 'Shipped, not archived', landed: 'Landed — ship it', merged: 'Merged, never verified — close as is', leftovers: 'Leftovers', abandoned: 'Looks abandoned — drop', legacy: 'Old docs — move as is' };

export function render(cfg, p) {
  const out = [`**${cfg.project}** — the registry against ${p.target}\n`];
  if (!p.onTarget) out.push(`On another branch: merged work is judged on ${p.target} — switch to it to archive.\n`);
  const cell = s => String(s ?? '—').replace(/\|/g, '\\|');
  for (const tier of ['finished', 'old']) {
    const rows = p.items.filter(i => i.tier === tier);
    if (!rows.length) continue;
    out.push(tier === 'finished' ? '**Finished** — archived on your go-ahead:\n' : '**Old** — archived only if you say so:\n');
    out.push('| Folder | What it is | Becomes | Last moved |', '|---|---|---|---|');
    for (const i of rows) {
      const becomes = { archive: 'SHIPPED (as it reads)', ship: `SHIPPED — merged ${i.sha}`, close: `CLOSED — merged ${i.sha}, ${i.walked ? 'walked, not verified' : 'not walked'}`, drop: `DROPPED — ${i.reason}`, move: 'moved as it is', trim: 'trimmed to its SPEC', workspace: 'removed', program: 'archived with its PROGRAM.md' }[i.action];
      out.push(`| ${cell(i.path)} | ${cell(`${KIND[i.kind]}: ${i.why}`)} | ${cell(becomes)} | ${cell(i.moved)} |`);
    }
    out.push('');
  }
  if (p.left.length) out.push(`Left alone: ${p.left.map(l => `${l.name} (${l.why})`).join(' · ')}\n`);
  out.push(summaryLine(p));
  return out.join('\n');
}

const USAGE = 'usage: archive.mjs plan [--root R] [--into <branch>] [--days N] [--json | --summary] | apply <name>… [--root R] [--into <branch>] [--days N] [--drop "<name>=<reason>"]… [--no-commit]';

if ((() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  try {
    const args = process.argv.slice(2);
    const verb = args.shift();
    const names = []; const o = { drop: {} };
    while (args.length) {
      const a = args.shift();
      if (['--json', '--summary', '--no-commit'].includes(a)) { o[a.slice(2)] = true; continue; }
      if (['--root', '--into', '--days', '--drop'].includes(a)) {
        const v = args.shift();
        if (v === undefined) throw new Error(`${a} needs a value`);
        if (a === '--drop') {
          const eq = v.indexOf('=');
          if (eq < 1 || !/^[\w.-]+$/.test(v.slice(0, eq)) || !v.slice(eq + 1).trim()) throw new Error('--drop takes "<name>=<reason>"');
          o.drop[v.slice(0, eq)] = v.slice(eq + 1).trim();
        } else o[a.slice(2)] = v;
        continue;
      }
      if (a.startsWith('--')) throw new Error(`Invalid option: ${a}\n${USAGE}`);
      names.push(a);
    }
    const root = gitStrict(path.resolve(o.root ?? process.cwd()), ['rev-parse', '--show-toplevel']);
    const cfg = loadConfig(root);
    if (!cfg.ok) { console.error(cfg.reason); process.exit(2); }
    const target = targetOf(root, cfg, o.into);
    const days = Number(o.days) > 0 ? Number(o.days) : 14;
    if (verb === 'plan' && !names.length) {
      const p = plan(root, cfg, { target, days });
      console.log(o.json ? JSON.stringify(p, null, 2) : o.summary ? summaryLine(p) : render(cfg, p));
    } else if (verb === 'apply' && names.length) {
      const r = apply(root, cfg, names, { target, days, drop: o.drop, commit: !o['no-commit'] });
      for (const l of r.lines) console.log(l);
      process.exitCode = r.ok ? 0 : 1;
    } else { console.error(USAGE); process.exitCode = 2; }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
