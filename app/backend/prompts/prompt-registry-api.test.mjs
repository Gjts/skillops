// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { handlePromptRegistryApi } from './prompt-registry-api.mjs'

function request(method, url, body) {
  const bytes = Buffer.from(body === undefined ? '' : JSON.stringify(body))
  return {
    method, url,
    headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (bytes.length) yield bytes },
  }
}

function response() {
  return { statusCode: 200, headers: {}, body: '', setHeader(name, value) { this.headers[name.toLowerCase()] = value }, end(value = '') { this.body += value } }
}

const artifact = {
  kind: 'prompt', artifactId: 'release-summary', version: 'a'.repeat(40), source: 'prompt-registry',
  sourceRef: `prompt-registry:${'a'.repeat(40)}:prompts%2Frelease.prompt.json:${'b'.repeat(64)}`,
  contentHash: 'b'.repeat(64), variables: ['release'],
}

function services() {
  const promptRegistry = {
    status: vi.fn().mockResolvedValue({ available: true, workspace: 'demo', branches: ['main'], persistence: 'git-source-only' }),
    list: vi.fn().mockResolvedValue({ revision: 'main', commit: 'a'.repeat(40), items: [{ artifact, name: '<img src=x>', model: 'gpt-test' }], warnings: [] }),
    compare: vi.fn().mockResolvedValue({ artifactId: 'release-summary', changed: true, changedFields: ['prompt'] }),
    resolveArtifact: vi.fn().mockResolvedValue({ artifact, prompt: { template: 'private prompt body' } }),
  }
  const governance = { nominate: vi.fn().mockResolvedValue({ capability: { id: 'cap-1', artifact }, reused: false }) }
  return { promptRegistry, governance, options: { promptRegistry, governanceServices: { governance } } }
}

async function call(method, url, body, options) {
  const res = response()
  const handled = await handlePromptRegistryApi(request(method, url, body), res, new URL(url, 'http://127.0.0.1').pathname, options)
  return { handled, response: res, json: res.body ? JSON.parse(res.body) : null }
}

describe('Prompt Registry local API', () => {
  it('returns Git metadata and a metadata-only filtered list', async () => {
    const { promptRegistry, options } = services()
    expect((await call('GET', '/api/prompt-registry/status', undefined, options)).json).toEqual(expect.objectContaining({ persistence: 'git-source-only' }))
    const listed = await call('POST', '/api/prompt-registry/prompts', { revision: 'main', provider: 'openai' }, options)
    expect(listed.response.statusCode).toBe(200)
    expect(listed.response.body).not.toContain('private prompt body')
    expect(promptRegistry.list).toHaveBeenCalledWith(expect.objectContaining({ revision: 'main', provider: 'openai' }))
  })

  it('compares versions and nominates an immutable reference without returning its body', async () => {
    const { promptRegistry, governance, options } = services()
    const compared = await call('POST', '/api/prompt-registry/compare', { leftRef: artifact.sourceRef, rightRef: artifact.sourceRef }, options)
    expect(compared.json.changedFields).toEqual(['prompt'])
    expect(promptRegistry.compare).toHaveBeenCalledWith(artifact.sourceRef, artifact.sourceRef)
    const nominated = await call('POST', '/api/prompt-registry/nominate', { sourceRef: artifact.sourceRef, owner: 'prompt-owner' }, options)
    expect(nominated.response.statusCode).toBe(201)
    expect(nominated.response.body).not.toContain('private prompt body')
    expect(governance.nominate).toHaveBeenCalledWith(expect.objectContaining({ artifact, targetSkeleton: 'prompt:release-summary' }))
  })

  it('rejects unsupported fields and non-local request methods before mutation', async () => {
    const { governance, options } = services()
    expect((await call('GET', '/api/prompt-registry/prompts?revision=main', undefined, options)).response.statusCode).toBe(405)
    expect((await call('POST', '/api/prompt-registry/nominate', { sourceRef: artifact.sourceRef, owner: 'owner', prompt: 'leak' }, options)).response.statusCode).toBe(422)
    expect(governance.nominate).not.toHaveBeenCalled()
  })
})
