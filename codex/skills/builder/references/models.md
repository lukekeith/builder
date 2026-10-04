# Task-specific model allocation

Use the cheapest available model likely to finish correctly with few turns. Price per token alone is misleading when a weak model needs several attempts. Keep the coordinator's current model; route the work it delegates.

The shipped defaults are configurable examples for currently supported models, not a promise that an account has them:

| Tier | Default | Reasoning | Work |
|---|---|---|---|
| fast | gpt-6-luna | high | Inventories, bounded existence checks, exact mechanical changes |
| standard | gpt-6.1-sol | medium | Prose-based implementation, integration, task review, scoped fix review |
| judgment | gpt-6-astra | high | Architecture, adversarial audit, complex security boundaries, final review |

Override model IDs and efforts under `models:` in the selected project config. Match IDs and reasoning levels to the actual client/tool capabilities; do not assume a brand alias translates from Claude. Read the current spawn tool or agent configuration API before dispatching. When defaults become unavailable, configure replacements, not repeated failing calls.

`node <plugin>/scripts/route.mjs <role> --available <comma-separated-supported-models>` emits the tier, model, effort, and explicit fallback. Roles: inventory, mechanical, mechanical-review, implementation, integration, task-review, fix-review, architecture, audit, final-review, security-review. `--complex` or `--escalate` raises a tier. An unavailable required tier with no configured equivalent returns a nonzero result; report it and select a supported equivalent explicitly. Do not silently downgrade judgment. If the harness cannot choose models, use its supported inherited-model behavior and record that cost routing could not be enforced.

Always specify model and supported effort on delegated work. In this runtime, use `spawn_agent` with `fork_turns:"none"` for model overrides. Other clients may offer custom agent configurations; use the actual available interface. Do not edit global model defaults or project agent configuration merely to route one task.

Record role, chosen model/effort, reason, and fallback/escalation in ledger.md. A model name in a plan is intended routing; actual dispatch settings are the evidence of routing.

## Escalation and context economy

- Mechanical means exact, bounded edits with complete requirements. Ambiguous multi-step work has a standard floor. Review from prose uses standard or higher even when the diff is small.
- Use judgment for consequential architectural ambiguity, permission/tenant boundaries, risky migrations, and final assembled-system review. Do not dispatch the most expensive tier for every search or fix.
- Batch same-shape tiny changes within one app. Keep short searches and dependent steps in the coordinator when delegation overhead exceeds the benefit.
- Give workers the task brief, required SPEC sections, contract, relevant project constraints/skill paths, recorded BASE, and a report path. Do not fork full conversation history or paste previous reports into every task.
- Reuse the original worker for a scoped fix while its context remains useful. Repeated nonconvergence requires a changed diagnosis, task split, or more capable worker; never repeat the identical failing request.
- No worker-created reviewers/helpers. The coordinator dispatches independent reviewers once and carries findings into the next action.

## Profile-aware routing

Pass the recorded profile as `--profile <value>` to route.mjs. Custom models=strong elevates implementation and review roles while leaving bounded inventories/mechanical work economical. Economy preserves role floors and uses the cheapest permitted configured tier. Rush does not silently weaken judgment review. Record effective model/effort and any availability fallback in the ledger.
