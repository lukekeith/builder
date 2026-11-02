// Shared by lifecycle.test.mjs and landing.test.mjs: landings go through the real verifier service.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run } from '../scripts/lifecycle.mjs';

// The detached service exits soon after its queue empties, so none outlives a test's temp dir.
process.env.BUILDER_VERIFY_IDLE_MS = '400';
const VERIFY = new URL('../scripts/verify/verify.mjs', import.meta.url).pathname;

/** A committed config the verifier and lifecycle both read: one trivial check on every tier. */
export const VERIFY_CONFIG = '---\napps:\n  - name: app\n    path: app\nverify:\n  workers: 1\n  checks:\n    ok: { run: "true", tiers: [commit, phase, merge] }\n---\n';

/** Wait for a verifier request's verdict; returns verify.mjs wait's exit code (0 green, 4 conflict, …). */
export function waitFor(root, id) {
  const r = spawnSync(process.execPath, [VERIFY, 'wait', id, '--max', '120', '--in', root], { encoding: 'utf8' });
  return r.status;
}

/** prepare → wait for the merge tier → deliver, as the coordinator does. */
export async function landFeature(root, name, options = {}) {
  const p = await run('prepare', name, { root });
  waitFor(root, p.request);
  return run('deliver', name, { root, ...options });
}

/** Wait for the repo's verifier service to exit (it idles out), so its files can be removed. */
export function settle(root) {
  let pid;
  try { pid = Number(fs.readFileSync(path.join(root, '.builder', 'verify', 'serve.pid'), 'utf8')); } catch { return; }
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    try { process.kill(pid, 0); } catch { return; }
    spawnSync('sleep', ['0.2']);
  }
}
