import { aiProviderDefinition } from '../../shared/ai-provider-catalog.mjs'
import { EvaluationError, optionalString, requiredString } from './errors.mjs'
import { boundedResponseText } from './response-limit.mjs'

const MAX_PROVIDER_RESPONSE_BYTES = 4_000_000
const REQUEST_TIMEOUT_MS = 120_000
const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max'])

function normalizedAddress(value) {
  const normalized = String(value || '').toLowerCase().replace(/^\[|\]$/g, '')
  return normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized
}

export function isLoopbackHostname(hostname) {
  const normalized = normalizedAddress(hostname)
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function normalizeBaseUrl(value, label, provider, apiKey) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new EvaluationError(`${label} must be a valid URL.`)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new EvaluationError(`${label} must be an HTTP(S) URL without embedded credentials.`)
  }
  if (url.search || url.hash) throw new EvaluationError(`${label} must not include a query string or fragment.`)
  if (url.protocol === 'http:') {
    if (provider === 'ollama' && !apiKey) {
      if (!isLoopbackHostname(url.hostname)) {
        throw new EvaluationError('Ollama HTTP endpoints must use a loopback address such as 127.0.0.1 or localhost.')
      }
    } else {
      throw new EvaluationError(`${label} must use HTTPS so API credentials are not sent in plaintext.`)
    }
  }
  return url.href.replace(/\/+$/, '')
}

export function normalizeProvider(config) {
  if (!config || typeof config !== 'object') throw new EvaluationError('AI provider settings are required.')
  const provider = requiredString(config.provider, 'Provider', 40)
  const definition = aiProviderDefinition(provider)
  if (!definition) throw new EvaluationError(`Unsupported AI provider: ${provider}.`)
  const model = optionalString(config.model, 200) || definition.defaultModel
  if (!model) throw new EvaluationError('A model or Azure deployment name is required.')
  const apiKey = optionalString(config.apiKey, 2_000)
  if (definition.requiresKey && !apiKey) throw new EvaluationError(`An API key is required for ${provider}.`)
  const rawBaseUrl = optionalString(config.baseUrl || config.endpoint, 2_000) || definition.defaultBaseUrl
  if (!rawBaseUrl) throw new EvaluationError('An Azure OpenAI endpoint is required.')
  const reasoningEffort = optionalString(config.reasoningEffort, 20)
  if (reasoningEffort && !REASONING_EFFORTS.has(reasoningEffort)) {
    throw new EvaluationError('AI reasoning effort must be none, low, medium, high, xhigh, or max.')
  }
  if (reasoningEffort && definition.transport === 'anthropic') {
    throw new EvaluationError('Reasoning effort is not available through the Anthropic transport.')
  }
  return {
    provider,
    transport: definition.transport,
    model,
    apiKey,
    baseUrl: normalizeBaseUrl(rawBaseUrl, provider === 'azure-openai' ? 'Azure endpoint' : 'Base URL', provider, apiKey),
    apiVersion: optionalString(config.apiVersion, 100) || 'v1',
    reasoningEffort,
  }
}

function responseContent(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => typeof part === 'string' ? part : part?.text || part?.content || '').join('')
}

function toolArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function openAiMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments || {}) },
        })),
      }
    }
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, name: message.name, content: message.content }
    }
    return { role: message.role, content: message.content }
  })
}

function anthropicMessages(messages) {
  const result = []
  for (const message of messages.filter((item) => item.role !== 'system')) {
    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
      result.push({
        role: 'assistant',
        content: [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...message.toolCalls.map((toolCall) => ({ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: toolCall.arguments || {} })),
        ],
      })
    } else if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }
      const previous = result.at(-1)
      if (previous?.role === 'user' && Array.isArray(previous.content) && previous.content.every((item) => item.type === 'tool_result')) previous.content.push(block)
      else result.push({ role: 'user', content: [block] })
    } else {
      result.push({ role: message.role, content: message.content })
    }
  }
  return result
}

function providerErrorMessage(text, status) {
  try {
    const parsed = JSON.parse(text)
    const message = parsed?.error?.message || parsed?.message || parsed?.detail
    if (typeof message === 'string') return `AI provider returned ${status}: ${message.slice(0, 500)}`
  } catch {}
  return `AI provider returned ${status}.`
}

export async function callLlmProvider(settings, messages, options = {}) {
  const config = normalizeProvider(settings)
  const fetchImpl = options.fetchImpl || fetch
  const controller = new AbortController()
  const requestSignal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let url
  let headers
  let payload
  if (config.transport === 'anthropic') {
    url = `${config.baseUrl}/v1/messages`
    const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n')
    payload = {
      model: config.model,
      max_tokens: options.maxTokens || 2_048,
      ...(system ? { system } : {}),
      messages: anthropicMessages(messages),
      ...(options.tools ? { tools: options.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}),
    }
    headers = { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }
  } else {
    if (options.tools?.length && /^gpt-5\.6(?:-|$)/i.test(config.model) && config.reasoningEffort !== 'none') {
      throw new EvaluationError('GPT-5.6 Chat Completions tools require reasoning effort none. Choose None or use prompt-only mode.')
    }
    let base = config.baseUrl
    if (config.provider === 'azure-openai' && !/\/openai\/v1$/i.test(base)) base = `${base}/openai/v1`
    url = `${base}/chat/completions`
    if (config.provider === 'azure-openai') url += `?api-version=${encodeURIComponent(config.apiVersion)}`
    payload = {
      model: config.model,
      messages: openAiMessages(messages),
      max_tokens: options.maxTokens || 2_048,
      ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
      ...(options.tools ? {
        tools: options.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
        tool_choice: 'auto',
      } : {}),
    }
    headers = {
      'Content-Type': 'application/json',
      ...(config.provider === 'azure-openai'
        ? { 'api-key': config.apiKey }
        : { Authorization: `Bearer ${config.apiKey || 'ollama'}` }),
      ...(config.provider === 'openrouter' ? { 'X-OpenRouter-Title': 'SkillOps' } : {}),
    }
  }
  try {
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: requestSignal })
    const text = await boundedResponseText(response, MAX_PROVIDER_RESPONSE_BYTES, 'AI provider response exceeded the safe size limit.')
    if (!response.ok) throw new EvaluationError(providerErrorMessage(text, response.status), 502)
    let data
    try { data = JSON.parse(text) } catch { throw new EvaluationError('AI provider returned invalid JSON.', 502) }
    const content = config.transport === 'anthropic'
      ? responseContent(data.content)
      : responseContent(data.choices?.[0]?.message?.content)
    const toolCalls = config.transport === 'anthropic'
      ? (Array.isArray(data.content) ? data.content : []).filter((part) => part?.type === 'tool_use').map((part) => ({ id: part.id, name: part.name, arguments: toolArguments(part.input) }))
      : (Array.isArray(data.choices?.[0]?.message?.tool_calls) ? data.choices[0].message.tool_calls : []).map((toolCall) => ({ id: toolCall.id, name: toolCall.function?.name, arguments: toolArguments(toolCall.function?.arguments) }))
    if (!content.trim() && !toolCalls.length) throw new EvaluationError('AI provider returned an empty response.', 502)
    const rawInputTokens = data.usage?.prompt_tokens ?? data.usage?.input_tokens
    const rawOutputTokens = data.usage?.completion_tokens ?? data.usage?.output_tokens
    const inputTokens = Number(rawInputTokens ?? 0)
    const outputTokens = Number(rawOutputTokens ?? 0)
    return {
      content,
      toolCalls,
      usage: {
        inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
        outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
        totalTokens: Number.isFinite(inputTokens + outputTokens) ? inputTokens + outputTokens : 0,
      },
      usageReported: rawInputTokens !== undefined && rawOutputTokens !== undefined,
      provider: config.provider,
      model: config.model,
    }
  } catch (error) {
    if (error instanceof EvaluationError) throw error
    if (options.signal?.aborted) throw new EvaluationError('AI provider request was cancelled.', 409)
    if (controller.signal.aborted) throw new EvaluationError('AI provider request timed out.', 504)
    throw new EvaluationError(error instanceof Error ? `AI provider request failed: ${error.message}` : 'AI provider request failed.', 502)
  } finally {
    clearTimeout(timer)
  }
}
