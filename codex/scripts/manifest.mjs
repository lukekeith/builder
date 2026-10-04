/**
 * MANIFEST.md — the ~12-line `key: value` file every builder feature carries. Shared by
 * list-features.mjs and the fleet, so both read a manifest the same way.
 *
 * A `#` starts a comment only when it is set off from the value — two or more spaces before it,
 * or a space after it. A single space plus `#<something>` is a PR reference, not a comment:
 * `pr: #1234` and `hold: "PR #1179 must land first"` both keep their `#`. `child:` repeats into
 * `children[]`.
 */
export const parseManifest = (text) => {
  const out = {}
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s{2,}#.*$|\s+#\s.*$/, '').trim()
    const m = /^([a-z-]+):\s*(.*)$/.exec(line)
    if (!m) continue
    const [, k, v] = m
    if (k === 'child') (out.children ??= []).push(v)
    else out[k] = v
  }
  return out
}

/** A manifest value that means "nothing": absent, empty, or the literal `none`. */
export const isSet = (v) => v != null && v !== '' && v !== 'none'
