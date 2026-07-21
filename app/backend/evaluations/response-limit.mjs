import { EvaluationError } from './errors.mjs'

export async function boundedResponseText(response, maxBytes, limitMessage) {
  const declaredLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new EvaluationError(limitMessage, 413)
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new EvaluationError(limitMessage, 413)
    return new TextDecoder().decode(bytes)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let output = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new EvaluationError(limitMessage, 413)
      }
      output += decoder.decode(value, { stream: true })
    }
    return output + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}
