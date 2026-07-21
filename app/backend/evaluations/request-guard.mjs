import { EvaluationError } from './errors.mjs'
import { isLoopbackHostname } from './provider-client.mjs'

export const MAX_EVALUATION_REQUEST_BYTES = 512_000

function requestHeader(request, name) {
  const headers = request.headers
  if (headers?.get) return headers.get(name)
  return headers?.[name.toLowerCase()]
}

export function assertLocalApiRequest(request, { requireJson = false } = {}) {
  if (!isLoopbackHostname(request.socket?.remoteAddress)) {
    throw new EvaluationError('Evaluation APIs accept loopback socket peers only.', 403)
  }
  const host = requestHeader(request, 'host')
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    throw new EvaluationError('A valid loopback Host header is required.', 403)
  }
  if (hostUrl.username || hostUrl.password || hostUrl.pathname !== '/' || hostUrl.search || hostUrl.hash || !isLoopbackHostname(hostUrl.hostname)) {
    throw new EvaluationError('Evaluation APIs accept loopback requests only.', 403)
  }
  if (String(requestHeader(request, 'sec-fetch-site') || '').toLowerCase() === 'cross-site') throw new EvaluationError('Cross-site evaluation requests are not allowed.', 403)
  const origin = requestHeader(request, 'origin')
  if (origin) {
    let originUrl
    try {
      originUrl = new URL(origin)
    } catch {
      throw new EvaluationError('The request Origin is invalid.', 403)
    }
    if (originUrl.protocol !== 'http:' || !isLoopbackHostname(originUrl.hostname) || originUrl.host !== hostUrl.host) {
      throw new EvaluationError('Cross-origin evaluation requests are not allowed.', 403)
    }
  }
  if (requireJson) {
    const contentType = requestHeader(request, 'content-type') || ''
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new EvaluationError('Evaluation requests must use application/json.', 415)
  }
}

export function assertLocalBrowserRequest(request) {
  return assertLocalApiRequest(request, { requireJson: true })
}

export async function readEvaluationJsonBody(request) {
  const declaredLength = Number(requestHeader(request, 'content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_EVALUATION_REQUEST_BYTES) {
    throw new EvaluationError('Evaluation request body exceeds the 512 KB limit.', 413)
  }
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.byteLength
    if (total > MAX_EVALUATION_REQUEST_BYTES) throw new EvaluationError('Evaluation request body exceeds the 512 KB limit.', 413)
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new EvaluationError('Evaluation request body must contain valid JSON.')
  }
}
