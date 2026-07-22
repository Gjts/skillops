// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { EvaluationError } from '../evaluations/errors.mjs'
import { handlePromptHubApi } from './prompthub-api.mjs'

function request(method, url, body, headers = {}, remoteAddress = '127.0.0.1') {
  const bytes = Buffer.from(body === undefined ? '' : JSON.stringify(body))
  return {
    method, url,
    headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', ...(['POST', 'PUT'].includes(method) ? { 'content-type': 'application/json' } : {}), ...headers },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { if (bytes.length) yield bytes },
  }
}

function response() {
  return { statusCode: 200, headers: {}, body: '', setHeader(name, value) { this.headers[name.toLowerCase()] = value }, end(value = '') { this.body += value } }
}
const componentHashes = Object.freeze({
  system: '1'.repeat(64),
  prompt: '2'.repeat(64),
  model: '3'.repeat(64),
  configuration: '4'.repeat(64),
  variables: '5'.repeat(64),
})

function gitCandidate(overrides = {}) {
  const commit = 'c'.repeat(40)
  const contentHash = 'b'.repeat(64)
  return {
    kind: 'prompt',
    artifactId: 'prompthub-4948',
    version: commit,
    source: 'git',
    sourceRef: `git:v1:${'d'.repeat(64)}:${commit}:prompts%2Fprompthub-4948.prompt.json:${contentHash}`,
    contentHash,
    gitCommit: commit,
    repository: `git-root:${commit}`,
    componentHashes,
    ...overrides,
  }
}


function services() {
  const artifact = {
    kind: 'prompt', artifactId: 'prompthub-4948', version: 'ed651609', source: 'prompthub',
    sourceRef: `prompthub:v1:4948:ed651609:${'a'.repeat(64)}`, contentHash: 'a'.repeat(64), componentHashes,
  }
  const version = { remoteId: '4948', remoteHash: 'ed651609', artifact, prompt: { messages: [{ role: 'user', content: 'private' }] } }
  const credentialStore = {
    get: vi.fn().mockResolvedValue('secret-token'),
    status: vi.fn().mockResolvedValue({ id: 'prompthub', configured: true }),
    set: vi.fn().mockResolvedValue({ id: 'prompthub', configured: true, storage: 'windows-dpapi' }),
    remove: vi.fn().mockResolvedValue({ id: 'prompthub', configured: false }),
  }
  const governance = {
    nominate: vi.fn(async (input) => ({ capability: { id: 'cap-1', stage: 'candidate', artifact: input.artifact }, reused: false })),
    retractCandidate: vi.fn().mockResolvedValue({ id: 'cap-1', stage: 'deprecated', artifact }),
  }
  const teamControlPlane = {
    authorize: vi.fn().mockResolvedValue({ role: 'Owner' }),
    recordConnectorCredentialChange: vi.fn().mockResolvedValue({ stateRevision: 2 }),
  }
  const connector = {
    metadata: { id: 'prompthub', apiVersion: 'v1', strategy: 'manual', teamId: '42', capabilities: { pull: true, push: false } },
    listArtifacts: vi.fn().mockResolvedValue([{ remoteId: '4948', name: 'Review prompt' }]),
    getVersion: vi.fn().mockResolvedValue(version),
    previewImport: vi.fn().mockResolvedValue({ previewToken: 'preview-1', targetStatus: 'candidate', version, diff: { changed: true, changedComponents: ['prompt'], content: { before: null, after: 'private' } } }),
    applyImport: vi.fn(async (_token, importer) => importer(version)),
    compareState: vi.fn().mockResolvedValue([{ remoteId: '4948', type: 'synchronized' }]),
    publishVersion: vi.fn().mockRejectedValue(new EvaluationError('PromptHub public API v1 does not expose a version publishing endpoint.', 501)),
  }
  const artifactResolver = { resolve: vi.fn().mockResolvedValue({ artifact: gitCandidate() }) }
  return { connector, credentialStore, governance, teamControlPlane, artifactResolver }
}

async function call(method, pathname, body, injected = services(), headers, remoteAddress) {
  const res = response()
  const handled = await handlePromptHubApi(request(method, pathname, body, headers, remoteAddress), res, pathname, {
    promptHubServices: injected,
    environment: {},
    resolveGovernancePrincipal: async () => ({ id: 'Operator', assurance: 'test' }),
  })
  return { handled, response: res, json: res.body ? JSON.parse(res.body) : null, services: injected }
}

describe('PromptHub connector API', () => {
  it('returns connector metadata and credential status without returning credentials', async () => {
    const status = await call('GET', '/api/connectors/prompthub')
    expect(status.json).toEqual(expect.objectContaining({ id: 'prompthub', apiVersion: 'v1', credentialConfigured: true }))
    expect(status.response.body).not.toContain('secret-token')
    expect((await call('GET', '/api/connectors/prompthub/credential')).json).toEqual({ id: 'prompthub', configured: true })

    const configured = await call('PUT', '/api/connectors/prompthub/credential', { apiKey: 'new-secret' })
    expect(configured.services.credentialStore.set).toHaveBeenCalledWith('prompthub', 'new-secret')
    expect(configured.response.body).not.toContain('new-secret')
    expect((await call('DELETE', '/api/connectors/prompthub/credential')).json.configured).toBe(false)
    expect(configured.services.teamControlPlane.authorize).toHaveBeenCalledWith(expect.objectContaining({ id: 'Operator' }), 'Owner')
    expect(configured.services.teamControlPlane.recordConnectorCredentialChange).toHaveBeenCalledWith('prompthub', true, expect.objectContaining({ id: 'Operator' }))
    expect((await call('DELETE', '/api/connectors/prompthub/credential')).services.teamControlPlane.recordConnectorCredentialChange).toHaveBeenCalledWith('prompthub', false, expect.objectContaining({ id: 'Operator' }))
  })

  it('lists, previews, imports as a governance Candidate, and reports drift', async () => {
    expect((await call('GET', '/api/connectors/prompthub/projects')).json.items).toEqual([{ remoteId: '4948', name: 'Review prompt' }])
    const fetchedVersion = await call('POST', '/api/connectors/prompthub/version', { projectId: '4948' })
    expect(fetchedVersion.json.remoteHash).toBe('ed651609')
    expect(fetchedVersion.response.body).not.toContain('private')
    expect(fetchedVersion.json.prompt).toBeUndefined()
    const preview = await call('POST', '/api/connectors/prompthub/import-preview', { projectId: '4948' })
    expect(preview.json.targetStatus).toBe('candidate')
    expect(preview.response.body).not.toContain('private')
    expect(preview.json.diff).toEqual({ changed: true, changedComponents: ['prompt'] })

    const injected = services()
    const sourceRef = gitCandidate().sourceRef
    const imported = await call('POST', '/api/connectors/prompthub/import', { previewToken: 'preview-1', gitSourceRef: sourceRef, targetSkeleton: 'prompt:review', projectId: 'project-a' }, injected)
    expect(imported.response.statusCode).toBe(201)
    expect(imported.json.capability.stage).toBe('candidate')
    expect(injected.artifactResolver.resolve).toHaveBeenCalledWith(sourceRef)
    expect(injected.governance.nominate).toHaveBeenCalledWith(expect.objectContaining({
      artifact: expect.objectContaining({ source: 'git', sourceRef }), owner: 'Operator', ownerIdentityAssurance: 'test', targetSkeleton: 'prompt:review', projectId: 'project-a',
    }))
    expect(injected.teamControlPlane.authorize).toHaveBeenCalledWith(expect.objectContaining({ id: 'Operator' }), 'Developer')
    expect((await call('GET', '/api/connectors/prompthub/drift')).json.items).toEqual([{ remoteId: '4948', type: 'synchronized' }])
  })

  it('retracts only a newly nominated Candidate when PromptHub import finalization fails', async () => {
    const injected = services()
    injected.connector.applyImport.mockImplementation(async (_token, importer, compensate) => {
      const remote = await injected.connector.getVersion()
      const imported = await importer(remote)
      await compensate(imported)
      throw new EvaluationError('PromptHub audit failed.', 500)
    })
    const failed = await call('POST', '/api/connectors/prompthub/import', { previewToken: 'preview-1', gitSourceRef: gitCandidate().sourceRef, targetSkeleton: 'prompt:review' }, injected)
    expect(failed.response.statusCode).toBe(500)
    expect(injected.governance.retractCandidate).toHaveBeenCalledWith('cap-1', { actor: 'Operator' })

    const compensate = injected.connector.applyImport.mock.calls[0][2]
    await compensate({ capability: { id: 'existing' }, reused: true })
    expect(injected.governance.retractCandidate).toHaveBeenCalledTimes(1)
  })

  it('rejects unauthorized Candidate imports and credential mutations before changing state', async () => {
    const injected = services()
    injected.teamControlPlane.authorize.mockRejectedValue(new EvaluationError('Team role is required.', 403))
    const sourceRef = gitCandidate().sourceRef
    expect((await call('POST', '/api/connectors/prompthub/import', { previewToken: 'preview-1', gitSourceRef: sourceRef, targetSkeleton: 'prompt:review' }, injected)).response.statusCode).toBe(403)
    expect((await call('PUT', '/api/connectors/prompthub/credential', { apiKey: 'new-secret' }, injected)).response.statusCode).toBe(403)
    expect(injected.governance.nominate).not.toHaveBeenCalled()
    expect(injected.credentialStore.set).not.toHaveBeenCalled()
  })

  it('rejects unsafe requests and reports unsupported PromptHub publishing honestly', async () => {
    expect((await call('POST', '/api/connectors/prompthub/import-preview', { projectId: '4948' }, services(), {}, '10.0.0.8')).response.statusCode).toBe(403)
    expect((await call('POST', '/api/connectors/prompthub/import-preview', { projectId: '4948', apiKey: 'leak' })).response.statusCode).toBe(422)
    expect((await call('POST', '/api/connectors/prompthub/import', { previewToken: 'preview-1' })).response.statusCode).toBe(422)
    const mismatched = services()
    mismatched.artifactResolver.resolve.mockResolvedValue({
      artifact: gitCandidate({ componentHashes: { ...componentHashes, prompt: 'f'.repeat(64) } }),
    })
    expect((await call('POST', '/api/connectors/prompthub/import', {
      previewToken: 'preview-1',
      gitSourceRef: gitCandidate().sourceRef,
      targetSkeleton: 'prompt:review',
    }, mismatched)).response.statusCode).toBe(409)
    const mismatchedVariables = services()
    mismatchedVariables.artifactResolver.resolve.mockResolvedValue({
      artifact: gitCandidate({ componentHashes: { ...componentHashes, variables: 'f'.repeat(64) } }),
    })
    expect((await call('POST', '/api/connectors/prompthub/import', {
      previewToken: 'preview-1',
      gitSourceRef: gitCandidate().sourceRef,
      targetSkeleton: 'prompt:review',
    }, mismatchedVariables)).response.statusCode).toBe(409)
    const publish = await call('POST', '/api/connectors/prompthub/publish', { artifact: {} })
    expect(publish.response.statusCode).toBe(501)
    expect(publish.json.error.message).toContain('does not expose')
  })
})
