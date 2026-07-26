// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { callLlmProvider } from './provider-client.mjs'

const provider = {
  provider: 'openai',
  apiKey: 'session-only-key',
  model: 'gpt-test',
  baseUrl: 'https://provider.example/v1',
}

const messages = [{ role: 'user', content: 'Hello.' }]

describe('AI provider error privacy', () => {
  it('does not expose an upstream response error payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'PROVIDER_RESPONSE_SENTINEL' },
    }), { status: 429 }))

    await expect(callLlmProvider(provider, messages, { fetchImpl })).rejects.toMatchObject({
      status: 502,
      message: 'AI provider returned 429.',
    })
  })

  it('does not expose a network runtime error message', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('PROVIDER_RUNTIME_SENTINEL'))

    await expect(callLlmProvider(provider, messages, { fetchImpl })).rejects.toMatchObject({
      status: 502,
      message: 'AI provider request failed.',
    })
  })
})
