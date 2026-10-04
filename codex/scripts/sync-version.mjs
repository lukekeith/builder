#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareVersions } from './version.mjs';

export function syncVersion({ root, ref, check = false }) {
  const file = path.join(root, 'codex/plugin.json');
  const upstream = JSON.parse(ref
    ? execFileSync('git', ['-C', root, 'show', `${ref}:.claude-plugin/plugin.json`], { encoding: 'utf8' })
    : fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'));
  const codex = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (upstream.name !== 'builder' || codex.name !== 'builder') throw new Error('Expected Builder manifests');
  const order = compareVersions(upstream.version, codex.version);
  if (order < 0) throw new Error(`Claude source ${upstream.version} is older than Codex ${codex.version}; select the current upstream ref instead of downgrading`);
  if (check && order !== 0) throw new Error(`Version mismatch: Claude ${upstream.version}, Codex ${codex.version}`);
  if (!check && order !== 0) {
    codex.version = upstream.version;
    fs.writeFileSync(file, `${JSON.stringify(codex, null, 2)}\n`);
  }
  return upstream.version;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = { root: path.resolve(fileURLToPath(new URL('../..', import.meta.url))) };
    if (args.includes('--help')) console.log('sync-version.mjs [--ref UPSTREAM_REF] [--check]');
    else {
      while (args.length) {
        const key = args.shift();
        if (key === '--check') options.check = true;
        else if (key === '--ref' && args[0] && !args[0].startsWith('--')) options.ref = args.shift();
        else throw new Error(`Invalid option: ${key}`);
      }
      console.log(`Builder ${syncVersion(options)} — Claude and Codex release versions aligned`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
