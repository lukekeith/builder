// The adapted workflow rules the Codex skill actually carries, and no Claude runtime names in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const ref = (name) => read(`skills/builder/references/${name}.md`);

test('spec asks no section approvals: open product choices are real decisions, details are assumed at spec, one closing summary', () => {
  const d = ref('discovery');
  assert.match(d, /Settle what the record left open — no section approvals/);
  assert.match(d, /Never present the spec section by section for approval/);
  assert.match(d, /\*\*A product choice\*\*[\s\S]*why it matters, what it affects, the recommendation[\s\S]*real alternatives as the options/);
  assert.match(d, /An approve\/change choice is an approval, not a decision; never offer one here/);
  assert.match(d, /\*\*An implementation detail\*\*[\s\S]*`\(assumed at spec\) YYYY-MM-DD`/);
  assert.match(d, /Close the spec with one plain summary and no question/);
  assert.match(d, /Anything wrong\? Just say what — it's revised before anything is built\./);
  assert.doesNotMatch(d, /presenting a spec for review/);
});

test('build here: offered before the build, audit and plan still run, the coordinator builds in the feature worktree and stops at built', () => {
  const skill = read('skills/builder/SKILL.md');
  assert.match(skill, /`\$builder resume <feature> \[--here\]`/);
  assert.match(skill, /`here` — only before the build starts \(spec, aligned, audited, planned\)/);
  assert.match(skill, /only when the config has an `agent_walk` block/);
  const exec = ref('execution');
  assert.match(exec, /## Build here \(`build: here`\)/);
  assert.match(exec, /in the existing feature worktree — Codex isolation is never skipped/);
  assert.match(exec, /In an app configured `commit: manual`, stage and carry on/);
  assert.match(exec, /chore\(<feature>\): built here — not walked/);
  assert.match(exec, /A here build is never delivered from this state[\s\S]*independent whole-feature final review/);
  assert.match(ref('planning'), /Choosing \*here\* was the go-ahead[\s\S]*go-ahead: <who YYYY-MM-DD> \(here\)/);
  assert.match(ref('persistence'), /`build: here` on the manifest/);
});

test('agent handoff runs agent-ready, never takes in-session work, and describes what workers would do', () => {
  const p = ref('profiles');
  assert.match(p, /lifecycle\.mjs agent-ready <feature>/);
  assert.match(p, /being built in a session; finish it there/);
  assert.match(p, /A feature only specced in a session is still offered/);
  assert.match(p, /features not built yet first, then part-built, then built/);
  assert.match(p, /`agent\.does` — what the workers would actually do/);
  assert.match(p, /builder\/<feature>` branch and worktree at start/);
});

test('landed migrations: delivery reports apply or the exact command; the template documents apply_mode', () => {
  assert.match(ref('delivery'), /`apply_mode: agent` and only additive migrations, deliver already ran `apply:` then `regenerate:` in the target checkout/);
  assert.match(ref('delivery'), /walk applies its migrations to its own isolated database, never the shared dev database/);
  assert.match(read('assets/PROJECT.template.md'), /^apply_mode: ask .*agent \(just run it — delivery also runs apply then regenerate/m);
});

test('the Codex skill names no Claude tools or Claude slash commands as actions', () => {
  const files = [];
  const visit = (dir) => { for (const n of fs.readdirSync(dir)) { const f = path.join(dir, n); if (fs.statSync(f).isDirectory()) visit(f); else if (f.endsWith('.md')) files.push(f); } };
  visit(path.join(root, 'skills'));
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /AskUserQuestion|through the Skill tool|run_in_background|\/builder:(?!update|vendor)/, f);
  }
  assert.match(read('README.md'), /`\/builder:benchmark`[\s\S]*is excluded/);
});

test('5.x ports: build options read as a decision, the test plan is chosen at the go-ahead, walks are lean, the config is the owner\'s', () => {
  const skill = read('skills/builder/SKILL.md');
  assert.match(skill, /1\. \*\*Agent\*\*[\s\S]*2\. \*\*Step by step\*\*[\s\S]*3\. \*\*In this session\*\*/);
  assert.match(skill, /"go" is option 1 — so where Agent is offered, "go" hands the feature to the workers/);
  assert.match(skill, /Pick up where you left off any time: \$builder resume <feature>/);
  assert.match(skill, /never a lettered list or a "reply …" line beside a picker/);
  assert.match(skill, /`\$builder init` always writes the `agent_walk:` block/);
  assert.match(skill, /never edit the project config/);
  const c = ref('conversation');
  assert.match(c, /## The quick path for a small change/);
  assert.match(c, /## Discovery for a vague idea/);
  assert.match(c, /state the project's own design system first/);
  assert.match(c, /\*\*Keep going\?\*\*/);
  assert.match(ref('discovery'), /one app, on data it already stores, with no new screen and nothing outside the app calling it, is sm/);
  assert.match(ref('discovery'), /A\. Approve the program/);
  const p = ref('profiles');
  assert.match(p, /\*\*Agent walk\*\* \(`walk`\)[\s\S]*\*\*Review\*\* \(`review`\)/);
  assert.match(p, /approve <feature> --tests/);
  assert.match(p, /`merge_into: current` means the branch checked out where the feature starts/);
  assert.match(p, /A landing target with no `agent_walk:` block/);
  assert.match(p, /the merged result the merge tier tested is exactly what lands/);
  assert.match(ref('planning'), /A\. Build it with this plan[\s\S]*B\. Change the test plan[\s\S]*C\. Keep planning/);
  const d = ref('delivery');
  assert.match(d, /One app in scope → the verification script is the walk/);
  assert.match(d, /A re-walk covers only what the fix changed/);
  assert.match(d, /Walk by screen/);
  assert.match(d, /§Standing traps/);
});

test('6.0 config: the template carries verify:, not Quality gates; init writes it and init --update migrates through migrate.mjs with a review', () => {
  const t = read('assets/PROJECT.template.md');
  assert.doesNotMatch(t, /## Quality gates|Deep set|@known-red|@delta|@scoped|depends_on/);
  assert.match(t, /^verify:\n {2}workers: 2/m);
  assert.match(t, /^## Verification$/m);
  for (const key of ['pending', 'restart', 'fixtures', 'smoke']) assert.match(t, new RegExp(`^${key}: +<command> +# optional`, 'm'), key);
  const skill = read('skills/builder/SKILL.md');
  assert.match(skill, /`\$builder init` writes `verify:` in the frontmatter/);
  assert.match(skill, /`\$builder init --update` on a config that still has `## Quality gates` migrates it/);
  assert.match(skill, /scripts\/verify\/migrate\.mjs <worktree> --review` and show its output as the review/);
  assert.match(skill, /Write nothing until the owner approves: then `migrate\.mjs <worktree> --write`/);
  assert.match(skill, /shared `\.claude\/builder\.md` the one migration serves Claude Code's builder too/);
  assert.match(skill, /known failures and flaky tests are never asked/);
  assert.doesNotMatch(skill, /`@typecheck`|`@walk`/);
  const d = ref('delivery');
  assert.match(d, /`pending:` command, deliver asked it in the target checkout/);
  assert.match(d, /read `wrapUp`[\s\S]*Offer them in \*\*one\*\* question/);
});

test('6.0 builds: the commit tier beside the build, the phase tier the only wait, and no gate runner on any build path', () => {
  const exec = ref('execution');
  for (const name of ['execution', 'planning', 'profiles', 'discovery']) {
    assert.doesNotMatch(ref(name), /gate\.mjs|gates-core|@typecheck|@delta|--baseline|Quality gates/, name);
  }
  assert.match(exec, /verify\.mjs request <worktree> HEAD --tier commit/);
  assert.match(exec, /verify\.mjs verdict <branch>/);
  assert.match(exec, /verify\.mjs request <worktree> HEAD --tier phase --since <phase BASE>/);
  assert.match(exec, /verify\.mjs wait <id>/);
  assert.match(exec, /Exit 75 means still running: call `wait` again/);
  assert.match(exec, /## Phase close — the build's only wait/);
  assert.match(exec, /Red \(exit 1\) — the phase does not close[\s\S]*fix dispatch against the task that introduced it/);
  assert.match(exec, /Env-broken \(exit 3\) — the phase does not close either[\s\S]*`⚠` lines[\s\S]*request the phase tier again/);
  assert.match(exec, /\*\*Env-broken a second time → stop\.\*\*[\s\S]*tell the user in plain words[\s\S]*the way forward/);
  assert.match(exec, /An env-broken verdict at the commit tier blocks nothing/);
  assert.match(exec, /Never run a suite by hand beside the verifier/);
  assert.match(exec, /run \*\*only the tests of the code they change plus the type-check\*\*/);
  assert.match(exec, /`--tree`/, 'a commit: manual app is tested on its uncommitted work');
  assert.match(read('skills/builder/SKILL.md'), /\*\*Builds test through the verifier\.\*\*/);
  assert.match(ref('delivery'), /phase tier must be green \*\*at that sha\*\*/);
  assert.doesNotMatch(ref('delivery'), /plan's `end`/);
});

test('6.0 briefs carry the environment landmines and the ledger\'s env notes through brief.mjs', () => {
  const exec = ref('execution');
  assert.match(exec, /node <plugin>\/scripts\/brief\.mjs <absolute-outfile> --ledger <featurePath>\/ledger\.md --root <worktree>/);
  assert.match(exec, /add it to the ledger's `## env notes` with its remedy written as a step/);
  assert.match(exec, /never repeat them in your own context for the worker/);
});

test('6.0 test plan is walk · review; tests are not a lever; old plans map on read', () => {
  const p = ref('profiles');
  assert.match(p, /\*\*Tests are not a lever\*\*/);
  assert.match(p, /`walk=you` becomes `human=yes`/);
  assert.match(p, /approve <feature> --tests "walk=… review=…"/);
  assert.match(p, /Finished means gone/);
  assert.doesNotMatch(p, /Testing per slice|Testing at the end|own\+app|`touched`: /);
  const plan = ref('planning');
  assert.match(plan, /B asks the two levers as two questions — \*\*Agent walk\*\*[\s\S]*\*\*Review\*\*/);
  assert.match(plan, /--tests "walk=<v> review=<v>"/);
  assert.doesNotMatch(plan, /\| Gates \|/);
});

test('6.0 plan task: six parts, decisions not bodies, code only where pinned; the audit leaves a code map', () => {
  const plan = ref('planning');
  assert.match(plan, /\*\*The plan carries decisions, not bodies\.\*\*/);
  assert.match(plan, /A task has six parts:\n\n1\. \*\*Files\*\*[\s\S]*2\. \*\*Interfaces\*\*[\s\S]*3\. \*\*Behaviour\*\*[\s\S]*4\. \*\*Tests\*\*[\s\S]*5\. \*\*Pattern\*\*[\s\S]*6\. \*\*Steps\*\*/);
  for (const pinned of ['exact copy the spec fixes', 'a migration', 'the frozen contract', "an algorithm the signature and tests don't determine", 'a security-sensitive mechanism']) assert.ok(plan.includes(`**${pinned}**`), pinned);
  assert.match(plan, /a task touches exactly one app/);
  assert.match(plan, /\.builder\/<feature>\/audit-digest\.md/);
  assert.match(ref('discovery'), /\*\*Leave a code map for the plan\.\*\* Write `\.builder\/<feature>\/audit-digest\.md`/);
  assert.match(ref('discovery'), /A child dropped or closed without landing never satisfies another child's dependency/);
});

test('6.0 landing: the merge queue, READY = merge tier green + walk passed, no integration worktree and no gate anywhere in the skill', () => {
  const d = ref('delivery');
  assert.match(d, /\*\*READY = the merge tier green \+ the walk passed\.\*\*/);
  assert.match(d, /lifecycle\.mjs prepare <feature>`[\s\S]*\*\*held\*\*/);
  assert.match(d, /verify\/verify\.mjs wait <request>/);
  assert.match(d, /lifecycle\.mjs deliver <feature>`[\s\S]*compare-and-swap[\s\S]*`release`, or `carry`/);
  assert.match(d, /`conflict` \(exit 4\)[\s\S]*Merge the target into the feature worktree/);
  assert.match(d, /ready to land on `<target>`\*\* — never "landed"/);
  for (const rel of ['skills/builder/SKILL.md', ...['conversation', 'delivery', 'discovery', 'execution', 'models', 'persistence', 'planning', 'profiles', 'version'].map(n => `skills/builder/references/${n}.md`)]) {
    const text = read(rel).split('\n').filter(l => !/^\*\*Tests are the `verify:` block|^`\$builder init --update` on a config/.test(l)).join('\n').replace(/an old `\.builder\/gates\/` folder is ignored/g, '');
    assert.doesNotMatch(text, /integration worktree|merge candidate|gate\.mjs|gates-core|@walk|@delta|flaky:|\.builder\/gates|Quality gates|fresh gate runs/, rel);
  }
});

test('a landing that needs you asks with three choices, recommended first, the files shown as a review, and never touches the owner\'s changes unasked', () => {
  const d = ref('delivery');
  const order = ['- **Set my changes aside, land, put them back**', '- **Commit my changes, then land**', '- **Leave it for now**'].map(s => d.indexOf(s));
  assert.ok(order.every(i => i > 0) && order[0] < order[1] && order[1] < order[2], 'the three choices, leave it last');
  assert.match(d, /\*\*The recommendation\*\*, said above the picker[\s\S]*\*\*3 files or fewer → Set my changes aside, land, put them back\*\*[\s\S]*\*\*More than 3 → Commit my changes, then land\*\*/, 'Claude\'s rule, with the reason above the picker');
  assert.match(d, /the recommended one first \(`needsYou\.choices` is already in that order/);
  assert.match(d, /\*\*Never commit, set aside or discard the owner's changes without their answer\*\*, and never choose for them under `--auto` or an agent handoff/);
  assert.match(d, /Your uncommitted changes in `<checkout>` overlap the feature in 2 files:\n> - `app\/settings\.ts`/);
  assert.match(d, /Nothing of yours has been touched\./);
  assert.match(d, /deliver <feature> --commit-mine "<message>"`/);
  assert.match(d, /deliver <feature> --set-aside` stashes[\s\S]*keeps the stash/);
  assert.match(d, /Only on A run/);
  const p = ref('persistence');
  assert.match(p, /\*\*Every human-only park names a choice\.\*\*[\s\S]*at least one option that moves the work forward, and \*leave it for now\* as the last/);
  assert.match(p, /`\$builder resume <feature>` raises it first/);
  assert.match(read('skills/builder/SKILL.md'), /`needsYou` in the result[\s\S]*raised first/);
  assert.doesNotMatch(d + p, /\bfleet\.mjs|\/builder:/, 'Codex names its own steps');
});

test('$builder archive: routed from SKILL.md, the plan is the review, one confirmation, one commit; status shows the verifier and registry lines', () => {
  const s = read('skills/builder/SKILL.md');
  assert.match(s, /`\$builder archive \[--into <branch>\]`/);
  assert.match(s, /§Archive finished features/);
  assert.match(s, /lifecycle\.mjs list` from the host repository, then `node <plugin>\/scripts\/verify\/verify\.mjs status`[\s\S]*`node <plugin>\/scripts\/archive\.mjs plan --summary`/);
  const d = ref('delivery');
  assert.match(d, /## Archive finished features[\s\S]*archive\.mjs plan[\s\S]*\*\*Archive the finished ones\*\* \(recommended\)[\s\S]*\*\*Those and the old ones\*\*[\s\S]*\*\*Not now\*\*[\s\S]*archive\.mjs apply <path…>[\s\S]*--drop "<name>=<their reason>"/);
  assert.match(d, /never called shipped/);
  assert.match(d, /never pushes, never deletes a folder's only docs/);
  assert.ok(fs.existsSync(path.join(root, 'scripts/archive.mjs')));
});
