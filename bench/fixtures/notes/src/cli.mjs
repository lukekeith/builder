#!/usr/bin/env node
import { load, save } from './store.mjs'

const USAGE = 'usage: notes add <text> | list | show <id> | rm <id>'
const [cmd, ...args] = process.argv.slice(2)
const fail = (msg) => {
  console.error(msg)
  process.exit(1)
}
const find = (store, id) => store.notes.find((n) => n.id === Number(id)) ?? fail(`no note ${id}`)

const store = load()
switch (cmd) {
  case 'add': {
    const text = args.join(' ').trim()
    if (!text) fail(USAGE)
    const note = { id: store.nextId++, text }
    store.notes.push(note)
    save(store)
    console.log(String(note.id))
    break
  }
  case 'list':
    console.log(store.notes.map((n) => `${n.id}  ${n.text}`).join('\n'))
    break
  case 'show':
    console.log(find(store, args[0]).text)
    break
  case 'rm': {
    const note = find(store, args[0])
    store.notes = store.notes.filter((n) => n !== note)
    save(store)
    console.log(`removed ${note.id}`)
    break
  }
  default:
    fail(USAGE)
}
