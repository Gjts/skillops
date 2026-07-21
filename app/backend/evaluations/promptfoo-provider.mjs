import { EvaluationError } from './errors.mjs'
import { callLlmProvider, normalizeProvider } from './provider-client.mjs'

const MESSAGE_PREFIX = 'skillops-messages-v1:'

export function encodePromptMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new EvaluationError('Promptfoo messages are required.', 422)
  const normalized = messages.map((message) => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
      throw new EvaluationError('Promptfoo messages are invalid.', 422)
    }
    return { role: message.role, content: message.content }
  })
  return `${MESSAGE_PREFIX}${Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64url')}`
}

export function promptfooPromptToMessages(prompt) {
  if (typeof prompt !== 'string') throw new EvaluationError('Promptfoo rendered prompt must be text.', 422)
  if (!prompt.startsWith(MESSAGE_PREFIX)) return [{ role: 'user', content: prompt }]
  try {
    const messages = JSON.parse(Buffer.from(prompt.slice(MESSAGE_PREFIX.length), 'base64url').toString('utf8'))
    if (!Array.isArray(messages) || !messages.length) throw new Error('empty')
    return messages.map((message) => {
      if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') throw new Error('invalid')
      return { role: message.role, content: message.content }
    })
  } catch {
    throw new EvaluationError('Promptfoo rendered messages are invalid.', 422)
  }
}

export function createPromptfooProvider(settings, options = {}) {
  const config = normalizeProvider(settings)
  const callProvider = options.callProvider || callLlmProvider
  return {
    id: () => `skillops:${config.provider}:${config.model}`,
    async callApi(prompt, context = {}) {
      const startedAt = Date.now()
      const result = await callProvider(config, promptfooPromptToMessages(prompt), {
        ...(options.providerOptions || {}),
        signal: context.abortSignal || options.signal,
      })
      return {
        output: result.content,
        tokenUsage: {
          total: result.usage.totalTokens,
          prompt: result.usage.inputTokens,
          completion: result.usage.outputTokens,
        },
        ...(typeof result.costUsd === 'number' && Number.isFinite(result.costUsd) ? { cost: result.costUsd } : {}),
        metadata: {
          latencyMs: Date.now() - startedAt,
          skillopsTokenUsageReported: result.usageReported !== false,
          skillopsCostReported: typeof result.costUsd === 'number' && Number.isFinite(result.costUsd),
        },
      }
    },
  }
}
