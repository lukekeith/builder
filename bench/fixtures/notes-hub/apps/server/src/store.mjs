import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'

/**
 * The server's data: named collections of records with numeric ids, in memory — and, when `file`
 * is given (STORE_FILE), loaded from and written back to that JSON file on every change, so the
 * data survives a restart. Shape on disk: { <collection>: { nextId, items: [...] } }.
 */
export function createStore(file = null) {
  const data = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const coll = (name) => (data[name] ??= { nextId: 1, items: [] })
  const persist = () => {
    if (!file) return
    writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + '\n')
    renameSync(`${file}.tmp`, file)
  }
  return {
    all: (name) => [...coll(name).items],
    find: (name, pred) => coll(name).items.find(pred) ?? null,
    get: (name, id) => coll(name).items.find((r) => r.id === id) ?? null,
    insert(name, fields) {
      const c = coll(name)
      const rec = { id: c.nextId++, ...fields }
      c.items.push(rec)
      persist()
      return rec
    },
    update(name, id, fields) {
      const rec = coll(name).items.find((r) => r.id === id)
      if (!rec) return null
      Object.assign(rec, fields)
      persist()
      return rec
    },
    remove(name, id) {
      const c = coll(name)
      const before = c.items.length
      c.items = c.items.filter((r) => r.id !== id)
      if (c.items.length === before) return false
      persist()
      return true
    },
  }
}
