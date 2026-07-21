// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let dataDirectory
let store

beforeEach(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), 'skillops-ai-settings-'))
  process.env.SKILLOPS_DATA_DIR = dataDirectory
  const moduleUrl = `${pathToFileURL(path.resolve('app/backend/ai-settings-store.mjs')).href}?test=${Date.now()}-${Math.random()}`
  store = await import(/* @vite-ignore */ moduleUrl)
})

afterEach(async () => {
  delete process.env.SKILLOPS_DATA_DIR
  await rm(dataDirectory, { recursive: true, force: true })
})

describe('ai-settings-store', () => {
  it('returns catalog defaults when the settings file is missing', async () => {
    const settings = await store.readAiSettings()
    expect(settings.activeProvider).toBe('gemini')
    expect(settings.providers.openai.model).toBeTruthy()
    expect(settings.providers.openai.apiKey).toBe('')
    expect(settings.version).toBe(1)
  })

  it('round-trips full provider settings including API keys', async () => {
    const written = await store.writeAiSettings({
      activeProvider: 'openai',
      providers: {
        openai: {
          apiKey: 'sk-test-secret',
          model: 'gpt-test',
          baseUrl: 'https://api.openai.com/v1',
          reasoningEffort: 'none',
        },
      },
    })

    expect(written.activeProvider).toBe('openai')
    expect(written.providers.openai.apiKey).toBe('sk-test-secret')
    expect(written.providers.gemini.model).toBeTruthy()

    const raw = JSON.parse(await readFile(store.aiSettingsFile, 'utf8'))
    expect(raw.providers.openai.apiKey).toBe('sk-test-secret')
    expect(await store.readAiSettings()).toEqual(written)
  })

  it('strips unknown providers and merges missing slots from defaults', async () => {
    const written = await store.writeAiSettings({
      activeProvider: 'ollama',
      providers: {
        ollama: { apiKey: '', model: 'llama3.2', baseUrl: 'http://127.0.0.1:11434/v1', reasoningEffort: '' },
        'not-a-provider': { apiKey: 'x', model: 'y', baseUrl: 'https://example.test', reasoningEffort: '' },
      },
    })
    expect(written.providers['not-a-provider']).toBeUndefined()
    expect(written.providers.openai.model).toBeTruthy()
  })

  it('rejects invalid reasoning effort and oversized fields on write', async () => {
    await expect(store.writeAiSettings({
      activeProvider: 'openai',
      providers: {
        openai: { apiKey: 'k', model: 'm', baseUrl: 'https://example.test', reasoningEffort: 'extreme' },
      },
    })).rejects.toThrow(/reasoning/i)

    await expect(store.writeAiSettings({
      activeProvider: 'openai',
      providers: {
        openai: { apiKey: 'k'.repeat(3_000), model: 'm', baseUrl: 'https://example.test', reasoningEffort: '' },
      },
    })).rejects.toThrow(/too long/i)
  })

  it('falls back to defaults for corrupt or unsupported files', async () => {
    await writeFile(store.aiSettingsFile, '{not-json', 'utf8')
    const corrupt = await store.readAiSettings()
    expect(corrupt.activeProvider).toBe('gemini')

    await writeFile(store.aiSettingsFile, JSON.stringify({ version: 99, activeProvider: 'openai', providers: {} }), 'utf8')
    const unsupported = await store.readAiSettings()
    expect(unsupported.activeProvider).toBe('gemini')
  })
})
