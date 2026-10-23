import { createServer } from 'node:http'
import { createApp } from '../src/app.mjs'
import { createStore } from '../src/store.mjs'

/** An app on a free port with its own in-memory store; `call(method, path, body?)` → { status, body }. */
export async function serve({ store = createStore(), now } = {}) {
  const server = createServer(createApp({ store, ...(now ? { now } : {}) }))
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
    const text = await r.text()
    return { status: r.status, body: text ? JSON.parse(text) : null }
  }
  return { base, call, store, close: () => new Promise((res) => server.close(res)) }
}
