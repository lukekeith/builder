import { HttpError, send, readJson } from './http.mjs'

/**
 * The request handler. `store` is a createStore(); `now` returns the current time in ms (tests
 * pass their own). Routes are [method, path pattern, handler(ctx)]; a handler returns
 * [status, body] or throws an HttpError.
 */
export function createApp({ store, now = () => Date.now() }) {
  const routes = [
    ['GET', /^\/health$/, () => [200, { ok: true }]],
    ['GET', /^\/notes$/, () => [200, store.all('notes')]],
    [
      'POST',
      /^\/notes$/,
      async ({ req }) => {
        const { text } = await readJson(req)
        if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'text is required')
        return [201, store.insert('notes', { text: text.trim(), createdAt: new Date(now()).toISOString() })]
      },
    ],
    ['GET', /^\/notes\/(\d+)$/, ({ params }) => [200, noteOr404(store, params[0])]],
    [
      'DELETE',
      /^\/notes\/(\d+)$/,
      ({ params }) => {
        noteOr404(store, params[0])
        store.remove('notes', Number(params[0]))
        return [204]
      },
    ],
  ]

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    try {
      const matches = routes.filter(([, re]) => re.test(url.pathname))
      if (!matches.length) throw new HttpError(404, `no route ${url.pathname}`)
      const route = matches.find(([method]) => method === req.method)
      if (!route) throw new HttpError(405, `${req.method} not allowed on ${url.pathname}`)
      const params = route[1].exec(url.pathname).slice(1)
      const [status, body] = await route[2]({ req, url, params })
      send(res, status, body)
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message })
      console.error(err)
      send(res, 500, { error: 'internal error' })
    }
  }
}

function noteOr404(store, id) {
  return store.get('notes', Number(id)) ?? (() => { throw new HttpError(404, `no note ${id}`) })()
}
