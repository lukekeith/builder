#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from './lifecycle.mjs';
import { parseProfile } from './profile.mjs';

export function archivePath(root) {
  const common = execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
  return path.join(path.resolve(root, common), 'builder-codex/archive.jsonl');
}
export function readHistory(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid history row ${i + 1}`); }
  });
}
function numeric(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid measured ${name}`);
  return value;
}
export function appendLanding(file, metadata, { tasks, metrics = null, now = new Date().toISOString() }) {
  if (metadata.phase !== 'merged' || !metadata.mergedHead) throw new Error('Only a landed feature can be archived');
  if (!Number.isInteger(tasks) || tasks < 0) throw new Error('Invalid plan task count');
  const rows = readHistory(file);
  const existing = rows.find(row => row.feature === metadata.name && row.mergedHead === metadata.mergedHead);
  if (existing) return existing;
  const row = { feature: metadata.name, mergedHead: metadata.mergedHead, target: metadata.targetBranch || metadata.originBranch, profile: parseProfile(metadata.profile).preset, size: { tasks }, landed: now, tokens: null, cost: null, lanes: null };
  if (metrics) {
    if (metrics.tokens) row.tokens = { input: numeric(metrics.tokens.input, 'input tokens'), output: numeric(metrics.tokens.output, 'output tokens') };
    if (metrics.cost !== undefined) row.cost = numeric(metrics.cost, 'cost');
    if (metrics.lanes) row.lanes = Object.fromEntries(Object.entries(metrics.lanes).map(([lane, duration]) => [lane, numeric(duration, `${lane} milliseconds`)]));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  return row;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help')) console.log('history.mjs list|record [FEATURE] [--root REPO] [--metrics MEASURED_JSON]');
    else {
      const command = args.shift(); const name = args[0] && !args[0].startsWith('--') ? args.shift() : undefined;
      const options = { root: process.cwd() };
      while (args.length) {
        const key = args.shift(), value = args.shift();
        if (!value || !['--root', '--metrics'].includes(key)) throw new Error(`Invalid option: ${key}`);
        options[key.slice(2)] = value;
      }
      const file = archivePath(options.root);
      if (command === 'list' && !name) console.log(JSON.stringify(readHistory(file), null, 2));
      else if (command === 'record' && name) {
        const m = await run('status', name, options);
        const planPath = `${m.registry}/${name}/PLAN.md`;
        let text = '';
        try { text = execFileSync('git', ['-C', m.originRoot, 'show', `${m.mergedHead}:${planPath}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch { throw new Error('Landed commit has no readable PLAN.md; cannot record its plan size'); }
        const tasks = (text.match(/^### Task \d+/gm) || []).length;
        const metrics = options.metrics ? JSON.parse(fs.readFileSync(options.metrics, 'utf8')) : null;
        console.log(JSON.stringify(appendLanding(file, m, { tasks, metrics }), null, 2));
      } else throw new Error('Expected list or record FEATURE');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
