import { describe, expect, it, vi } from 'vitest'
import { createPromptfooProvider, encodePromptMessages } from './promptfoo-provider.mjs'

function openAiResponse(content) {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('SkillOps Promptfoo provider bridge', () => {
  it('routes encoded messages through the existing OpenAI-compatible client', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(openAiResponse('OpenAI result'))
    const provider = createPromptfooProvider({
      provider: 'openai', apiKey: 'session-secret', model: 'gpt-test', baseUrl: 'https://example.test/v1',
    }, { providerOptions: { fetchImpl } })
    const response = await provider.callApi(encodePromptMessages([
      { role: 'system', content: 'System rule' },
      { role: 'user', content: 'Test case' },
    ]))

    expect(provider.id()).toBe('skillops:openai:gpt-test')
    expect(response).toEqual(expect.objectContaining({
      output: 'OpenAI result',
      tokenUsage: { total: 10, prompt: 7, completion: 3 },
    }))
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(request.messages).toEqual([
      { role: 'system', content: 'System rule' },
      { role: 'user', content: 'Test case' },
    ])
    expect(response).not.toHaveProperty('headers')
    expect(response).not.toHaveProperty('config')
  })

  it('routes Anthropic through the same bridge without exposing config', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'Anthropic result' }],
      usage: { input_tokens: 4, output_tokens: 2 },
    }), { status: 200 }))
    const provider = createPromptfooProvider({ provider: 'anthropic', apiKey: 'secret', model: 'claude-test' }, { providerOptions: { fetchImpl } })
    await expect(provider.callApi('Hello')).resolves.toEqual(expect.objectContaining({
      output: 'Anthropic result', tokenUsage: { total: 6, prompt: 4, completion: 2 },
    }))
    expect(fetchImpl.mock.calls[0][0]).toContain('/v1/messages')
  })

  it('allows keyless loopback Ollama and propagates cancellation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(openAiResponse('Local result'))
    const provider = createPromptfooProvider({ provider: 'ollama', model: 'llama3.2', baseUrl: 'http://127.0.0.1:11434/v1' }, { providerOptions: { fetchImpl } })
    await expect(provider.callApi('Hello')).resolves.toEqual(expect.objectContaining({ output: 'Local result' }))

    const controller = new AbortController()
    const waitingFetch = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const cancellable = createPromptfooProvider({ provider: 'ollama', model: 'llama3.2', baseUrl: 'http://127.0.0.1:11434/v1' }, {
      signal: controller.signal,
      providerOptions: { fetchImpl: waitingFetch, timeoutMs: 30_000 },
    })
    const request = cancellable.callApi('Wait')
    controller.abort()
    await expect(request).rejects.toThrow('cancelled')
  })
})
