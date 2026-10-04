#!/usr/bin/env node
import { loadConfig } from './config.mjs'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { parseProfile } from './profile.mjs'

export const DEFAULTS = {
  fast: { model: 'gpt-6-luna', effort: 'high' },
  standard: { model: 'gpt-6.1-sol', effort: 'medium' },
  judgment: { model: 'gpt-6-astra', effort: 'high' },
}
const ROLES = {
  inventory: 'fast', mechanical: 'fast', 'mechanical-review': 'standard',
  implementation: 'standard', integration: 'standard', 'task-review': 'standard',
  'fix-review': 'standard', architecture: 'judgment', audit: 'judgment',
  'final-review': 'judgment', 'security-review': 'judgment',
}
export function route(role, { models = {}, available, escalate = false, complex = false, profile } = {}) {
  if (!Object.hasOwn(ROLES, role)) throw new Error(`Unknown role: ${role}`)
  const tiers = Object.keys(DEFAULTS)
  let tier = ROLES[role]
  const selected = parseProfile(profile)
  if (selected.levers.models === 'strong' && !['inventory', 'mechanical'].includes(role)) tier = tiers[Math.min(tiers.indexOf(tier) + 1, 2)]
  if (complex || escalate) tier = tiers[Math.min(tiers.indexOf(tier) + 1, 2)]
  const configured = (t) => ({
    model: models[t] ?? DEFAULTS[t].model,
    effort: models[`${t}_effort`] ?? DEFAULTS[t].effort,
  })
  const requested = configured(tier)
  if (!available || available.includes(requested.model))
    return { role, tier, ...requested, fallback: false }
  // Do not silently downgrade judgment or reuse an expensive parent for light work.
  for (const t of tiers.slice(tiers.indexOf(tier) + 1)) {
    const option = configured(t)
    if (available.includes(option.model))
      return { role, tier: t, ...option, fallback: true, requested: requested.model }
  }
  return { role, tier, requested: requested.model, unavailable: true,
    reason: 'No configured model at the required tier or above is available; select an available equivalent explicitly.' }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    if (args.includes('--help')) {
      console.log('route.mjs ROLE [--available MODEL,MODEL] [--complex] [--escalate] [--profile VALUE]')
    } else {
      const cfg = loadConfig()
      if (!cfg.ok && existsSync(cfg.path)) throw new Error(cfg.reason)
      const profileAt = args.indexOf('--profile')
      if (profileAt >= 0 && !args[profileAt + 1]) throw new Error('--profile requires a value')
      const at = args.indexOf('--available')
      const result = route(args[0], { models: cfg.ok ? cfg.models : {},
        available: at < 0 ? undefined : (args[at + 1] ?? '').split(','),
        profile: profileAt < 0 ? undefined : args[profileAt + 1],
        complex: args.includes('--complex'), escalate: args.includes('--escalate') })
      console.log(JSON.stringify(result, null, 2))
      if (result.unavailable) process.exitCode = 2
    }
  } catch (error) { console.error(error.message); process.exitCode = 2 }
}
