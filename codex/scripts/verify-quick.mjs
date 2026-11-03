#!/usr/bin/env node
/**
 * verify-quick — the quick check after sign-off (Claude 6.1.0's scripts/verify-quick.mjs, adapted to
 * Codex): the mechanical part of the full verification in one call, no model judgment. Verify is
 * optional after sign-off — the owner (or --auto / an agent handoff) picks Quick check (this),
 * Ship it (`--skip`) or Full verify (the verified checkpoint, delivery.md §Feature verification) —
 * and `lifecycle.mjs deliver` refuses none of them. A gap here is advice, never a block.
 *
 *   node <plugin>/scripts/verify-quick.mjs <feature> [--root R] [--json] [--max-wait <seconds>] [--no-record]
 *   node <plugin>/scripts/verify-quick.mjs <feature> [--root R] --skip
 *
 * The checks, read from the Codex runtime record and the feature's SPEC.md in its worktree:
 *   walk        the runtime phase is signed-off (or verified); a human walk the plan requires
 *               covers HEAD (humanHead), as deliver will insist
 *   fixes       no `- [ ]` left under `## Fixes`
 *   schema      every §Schema & API changes row's Status carries a migration id or a marking —
 *               not empty, `planned`, `pending`, `todo`, `tbd`, `open`
 *   decisions   no OPEN (or empty) Ruling in §Decisions
 *   obligations check-obligations.mjs <folder> finds no FAIL
 *   merge tier  the held merge deliver lands — `lifecycle.mjs prepare` asks for it (or reuses the one
 *               asked for this HEAD and target tip), then `verify.mjs wait` until its verdict, bounded
 *               by --max-wait (default 1800 s: time, not tokens). Green on HEAD merged onto the target.
 *
 * Output: one `✓ <check>: <what>` / `✗ <check>: <the gap>` line each, then `QUICK CHECK: PASS` or
 * `QUICK CHECK: GAPS (n)`. --json prints { feature, sha, checks, pass, gaps, recorded }.
 * Exit 0 pass · 1 gaps (or --skip refused) · 2 usage or unknown feature.
 *
 * On PASS it records the check runtime-only — `lifecycle.mjs record-check <feature> --check quick`
 * (the verified checkpoint is runtime-only for the same reason: nothing dirties the tested tree); a
 * full verify that already holds on HEAD stands. --no-record writes nothing. --skip records
 * `--check skipped` without checking anything; refused only on a feature never signed off. Both
 * re-run as a no-op.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from './lifecycle.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.join(HERE, 'verify', 'verify.mjs');
const SIGNED_OFF = ['signed-off', 'verified'];
const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const short = sha => String(sha ?? '').slice(0, 7);
const ok = (name, detail) => ({ name, ok: true, detail });
const gap = (name, detail) => ({ name, ok: false, detail });

/** The `## <title>` section's body (to the next `## `), or null. A title may run on (`## Schema & API changes (v2)`). */
function section(text, title) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex(l => { const m = /^##\s+(.+?)\s*$/.exec(l); return m && (m[1] === title || m[1].startsWith(`${title} `)); });
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n');
}
/** A markdown table's body rows (below its `|---|` line), each as trimmed cells. */
function tableRows(body) {
  const rows = []; let seenSep = false;
  for (const line of String(body ?? '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    if (/^\|\s*:?-{2,}/.test(line.trim())) { seenSep = true; continue; }
    if (seenSep) rows.push(line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
  }
  return rows;
}

async function walkCheck(m, sha) {
  if (!SIGNED_OFF.includes(m.phase)) return gap('walk', `not signed off (${m.phase}) — the walk comes first ($builder resume ${m.name})`);
  const { runtimeTestPlan } = await import('./profile.mjs');
  const required = m.humanWalkRequired || runtimeTestPlan(m).levers.human === 'yes';
  if (m.awaitingHuman || (required && m.humanHead !== sha)) return gap('walk', `the plan needs a human walk at HEAD ${short(sha)}, and the recorded one ${m.humanHead ? `is at ${short(m.humanHead)}` : 'is missing'} — walk the changes, then human-pass`);
  if (m.humanReport && m.humanHead === sha) return ok('walk', `signed off — human walk at ${short(sha)}`);
  return ok('walk', 'signed off — not human-tested (the agent walk, or a recorded no-walk)');
}
function fixesCheck(spec) {
  const body = section(spec, 'Fixes');
  const open = (body ?? '').split('\n').filter(l => /^\s*[-*] \[ \]/.test(l));
  return open.length ? gap('fixes', `${open.length} open under ## Fixes — first: ${open[0].replace(/^\s*[-*] \[ \]\s*/, '')}`) : ok('fixes', 'none open');
}
const UNLANDED = /^(planned|pending|todo|tbd|open|proposed|wip|—|-|\?|\[ \])?$/i;
function schemaCheck(spec) {
  const body = section(spec, 'Schema & API changes') ?? section(spec, 'Schema');
  if (body == null) return ok('schema', 'no §Schema & API changes section');
  const rows = tableRows(body).filter(c => c.length > 1 && /\S/.test(c[0]));
  if (!rows.length) return ok('schema', /no schema change/i.test(body) ? 'no schema change' : 'no rows');
  const bad = rows.filter(c => UNLANDED.test(c.at(-1).replace(/[*_`]/g, '').trim().split(/\s/)[0] ?? ''));
  if (!bad.length) return ok('schema', `${rows.length} row${rows.length === 1 ? '' : 's'}, each with a Status`);
  return gap('schema', `${bad.map(c => `${`${c[0]} ${c[2] ?? ''}`.trim()} — Status "${c.at(-1) || 'empty'}"`).join('; ')} — no migration id and not marked (landed, deferred with a decider, n/a)`);
}
function decisionsCheck(spec) {
  const body = section(spec, 'Decisions');
  if (body == null) return ok('decisions', 'no §Decisions section');
  const rows = tableRows(body).map(c => c.map(x => x.replace(/^[*_`]+|[*_`]+$/g, '')));
  const open = rows.filter(c => c.length < 3 || !c[2] || c.some(x => /^open\b/i.test(x)));
  return open.length ? gap('decisions', `${open.map(c => c[0]).join(', ')} OPEN in §Decisions`) : ok('decisions', `none OPEN (${rows.length} ruled)`);
}
function obligationsCheck(m) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'check-obligations.mjs'), m.featurePath, '--json'], { cwd: m.worktree, encoding: 'utf8' });
  let results;
  try { results = JSON.parse(r.stdout); } catch { return gap('obligations', `check-obligations could not run (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`); }
  const fails = results.flatMap(x => x.findings ?? []).filter(x => x.severity === 'FAIL');
  return fails.length ? gap('obligations', `${fails.length} dangling — ${fails.map(x => `[${x.id}] ${x.rule}`).join('; ')}`) : ok('obligations', 'check-obligations: every obligation discharged');
}
async function mergeCheck(m, root, sha, maxWait) {
  let p;
  try { p = await run('prepare', m.name, { root }); } catch (error) { return gap('merge tier', `could not ask for the merge: ${error.message}`); }
  const target = p.targetBranch || p.originBranch;
  const until = Date.now() + maxWait * 1000;
  let w;
  for (;;) {
    const left = Math.max(1, Math.min(Math.ceil((until - Date.now()) / 1000), 540));
    w = spawnSync(process.execPath, [VERIFY, 'wait', p.request, '--max', String(left), '--in', root], { encoding: 'utf8' });
    if (w.status !== 75 || Date.now() >= until) break;
  }
  const line = String(w.stdout || w.stderr || '').trim().split('\n')[0];
  const overlap = p.overlap?.length ? ` (your uncommitted changes on ${target} overlap it in ${p.overlap.join(', ')} — deliver asks first)` : '';
  if (w.status === 75) return gap('merge tier', `still running (${p.request}) after ${maxWait}s — run the quick check again later, or verify.mjs wait ${p.request}`);
  if (w.status === 4) return gap('merge tier', `conflicts with ${target} — ${line}`);
  if (w.status !== 0) return gap('merge tier', `${line || `exit ${w.status}`} — fix what it names, then the quick check again`);
  if (/untested/.test(line)) return gap('merge tier', `${line} — the config names no tests, so nothing ran`);
  return ok('merge tier', `green on ${short(sha)} merged onto ${target} — ${line}${overlap}`);
}

/** Every check, in a fixed order — the cheap ones first, the merge tier (which may wait) last. */
export async function quickCheck(m, root, { maxWait = 1800 } = {}) {
  const sha = m.head;
  const spec = read(path.join(m.featurePath, 'SPEC.md'));
  const specChecks = spec == null ? [gap('spec', `no SPEC.md in ${path.relative(m.worktree, m.featurePath)} — nothing to check the fixes, schema or decisions against`)] : [fixesCheck(spec), schemaCheck(spec), decisionsCheck(spec), obligationsCheck(m)];
  const checks = [await walkCheck(m, sha), ...specChecks, await mergeCheck(m, root, sha, maxWait)];
  return { sha, checks, gaps: checks.filter(c => !c.ok).length };
}

async function record(name, root, kind) {
  const m = await run('status', name, { root });
  if (kind === 'quick' && m.verifiedHead === m.head) return { recorded: null, line: `a full verify already holds at ${short(m.head)} — nothing recorded over it` };
  if (m.check?.kind === kind && (kind === 'skipped' || m.check.head === m.head)) return { recorded: m.check, line: `already recorded: ${kind === 'quick' ? `quick check at ${short(m.check.head)}` : 'check skipped'}` };
  const r = await run('record-check', name, { root, check: kind });
  return { recorded: r.check, line: kind === 'quick' ? `recorded: quick check passed at ${short(r.check.head)} — deliver next` : 'recorded: check skipped — deliver next' };
}

async function main(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--json', '--skip', '--no-record'].includes(a)) o[a.slice(2)] = true;
    else if (['--root', '--max-wait'].includes(a)) o[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) o.bad = a;
    else o._.push(a);
  }
  const maxWait = o['max-wait'] == null ? 1800 : Number(o['max-wait']);
  if (!o._[0] || o.bad || !Number.isFinite(maxWait) || maxWait < 0) {
    console.error('usage: verify-quick.mjs <feature> [--root R] [--json] [--max-wait <seconds>] [--no-record] | <feature> [--root R] --skip');
    return 2;
  }
  const root = path.resolve(o.root ?? process.cwd());
  const name = o._[0];
  let m;
  try { m = await run('status', name, { root }); } catch (error) { console.error(error.message); return 2; }
  if (m.cleaned || m.phase === 'merged') { console.error(`${name} already landed — there is nothing to check`); return 2; }
  if (o.skip) {
    if (!SIGNED_OFF.includes(m.phase)) { console.error(`${name} is not signed off — there is no check to skip yet; the walk comes first ($builder resume ${name})`); return 1; }
    console.log((await record(name, root, 'skipped')).line);
    return 0;
  }
  const res = await quickCheck(m, root, { maxWait });
  const pass = res.gaps === 0;
  const rec = pass && !o['no-record'] ? await record(name, root, 'quick') : { recorded: null, line: null };
  if (o.json) {
    console.log(JSON.stringify({ feature: name, sha: short(res.sha), checks: res.checks, pass, gaps: res.gaps, recorded: rec.recorded }, null, 2));
    return pass ? 0 : 1;
  }
  console.log(`quick check — ${name} at ${short(res.sha)}`);
  for (const c of res.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
  console.log(pass ? 'QUICK CHECK: PASS' : `QUICK CHECK: GAPS (${res.gaps})`);
  if (rec.line) console.log(rec.line);
  return pass ? 0 : 1;
}

if ((() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}
