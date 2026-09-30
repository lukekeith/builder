/**
 * newer — whether a copy of this plugin vendored into a repo is behind the newest release this
 * machine knows about, so /builder:status and /builder:resume can say "run /builder:vendor".
 *
 * A vendored copy is a snapshot: nothing else tells the repo a release came out. It reads only what
 * is already on disk — no network: the plugin installs under `<config>/plugins/cache/*\/builder/*`
 * and the marketplace clones under `<config>/plugins/marketplaces/*`, which a marketplace refresh
 * (`/builder:vendor` does one, and so does `/builder:update`) brings up to the latest release.
 * Only a copy carrying `scripts/vendor.mjs` counts as a release of THIS plugin — another plugin
 * that happens to be called builder does not.
 *
 * It names nothing of where the plugin came from: `/builder:vendor` refuses to copy a file that does.
 */
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

const versionOf = (dir) => {
  try {
    const pj = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))
    return pj.name === 'builder' && existsSync(join(dir, 'scripts', 'vendor.mjs')) ? pj.version ?? null : null
  } catch {
    return null
  }
}
const ls = (dir) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Semver-ish order: numbers compared as numbers, part by part. */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => Number(x) || 0)
  const pb = String(b).split(/[.-]/).map((x) => Number(x) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

/**
 * `{ vendored, have, latest, behind }`. `vendored` is false for a plugin install (its own
 * /builder:update keeps it current) and for the plugin's own repository; `latest` is null when the
 * machine has no release of it installed beside the copy.
 */
export function newerRelease({ pluginRoot, repoRoot, configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude') }) {
  // Real paths: a repo reached through a symlink (macOS's /var → /private/var) is the same repo.
  const real = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  const root = real(pluginRoot)
  const vendored = root.startsWith(real(repoRoot) + sep)
  const have = versionOf(root) ?? JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version
  if (!vendored) return { vendored: false, have, latest: null, behind: false }
  const found = [
    ...ls(join(configDir, 'plugins', 'cache')).flatMap((m) => ls(join(configDir, 'plugins', 'cache', m, 'builder')).map((v) => versionOf(join(configDir, 'plugins', 'cache', m, 'builder', v)))),
    ...ls(join(configDir, 'plugins', 'marketplaces')).map((m) => versionOf(join(configDir, 'plugins', 'marketplaces', m))),
  ].filter(Boolean)
  const latest = found.sort(compareVersions).pop() ?? null
  return { vendored: true, have, latest, behind: latest !== null && compareVersions(latest, have) > 0 }
}

/** The one line status and resume print when the copy is behind, else null. */
export const newerLine = (n) => (n?.behind ? `⬆️ builder ${n.latest} is available — this repo carries ${n.have}. Run /builder:vendor to update it.` : null)
