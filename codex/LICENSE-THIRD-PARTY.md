# Third-party attribution — Codex port

The task-brief and review-package shell helpers are adapted from Jesse Vincent’s
superpowers (MIT), through Luke Keith’s Builder. The workflow references retain
its task-scoped implementation/review loop, recorded BASE ranges, scoped fix
reviews and evidence-before-completion principles in a Codex-specific form.

This port replaces the Claude command/tool bindings, supports configurable Codex
model routing, creates worktrees before any edits, retains durable plan/checkpoint
evidence, and verifies the actual local merge candidate. It does not inherit the
Claude plugin’s old prohibition on worktree creation. Other scripts retain
Builder’s MIT license. The repository-root attribution describes the original
Claude plugin and is preserved there.

MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
