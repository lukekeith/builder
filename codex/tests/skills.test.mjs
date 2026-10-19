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
