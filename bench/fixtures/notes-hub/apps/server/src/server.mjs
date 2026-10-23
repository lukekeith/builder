#!/usr/bin/env node
import { createServer } from 'node:http'
import { createApp } from './app.mjs'
import { createStore } from './store.mjs'

const port = Number(process.env.PORT ?? 4000)
const store = createStore(process.env.STORE_FILE || null)
const server = createServer(createApp({ store }))

server.listen(port, () => console.log(`notes-hub server listening on http://localhost:${server.address().port}`))

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)))
