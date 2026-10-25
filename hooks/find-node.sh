# Sourced by the hook entries: sets NODE to a node binary, or leaves it empty. A SessionStart hook can
# run with a broken or empty PATH (anthropics/claude-code#43127), so after `command -v` it tries the
# usual install places itself — bash builtins and globs only, no external commands.
NODE=""
if command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  # nvm: the glob lists versions in lexical order; the last executable one wins.
  for c in "$HOME"/.nvm/versions/node/*/bin/node; do [ -x "$c" ] && NODE="$c"; done
  if [ -n "${NVM_BIN:-}" ] && [ -x "$NVM_BIN/node" ]; then NODE="$NVM_BIN/node"; fi
  if [ -z "$NODE" ]; then
    for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" \
             "$HOME/.local/share/mise/shims/node" "$HOME/.asdf/shims/node" /usr/bin/node; do
      if [ -x "$c" ]; then NODE="$c"; break; fi
    done
  fi
fi
