#!/bin/bash
# Seed the run's empty workspace with the benchmark's notes fixture as a fresh git repo on main.
# Sourced by each case's scaffold.sh; $1 is the case directory.
set -euo pipefail
ROOT="$(cd "$1/../.." && pwd)"
cp -R "$ROOT/bench/fixtures/notes/." .
git init -q -b main
git -c user.name=eval -c user.email=eval@example.invalid add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm "notes: add, list, show, rm"
