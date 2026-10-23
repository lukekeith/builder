/** An error a handler throws to answer with that status and `{ error: message }`. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status)
    return res.end()
  }
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** The request body parsed as JSON — `{}` when empty; a 400 when it is not JSON or over 64 KB. */
export async function readJson(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 64 * 1024) throw new HttpError(413, 'body too large')
  }
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'body is not valid JSON')
  }
}
