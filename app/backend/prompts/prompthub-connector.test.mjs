// @vitest-environment node
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { adaptPromptDefinition } from './prompt-definition.mjs'
import { createPromptHubConnector, PROMPTHUB_V1 } from './prompthub-connector.mjs'

const roots = []
const servers = []

function revision(overrides = {}) {
  return {
    id: 1167,
    project_id: 4948,
    user_id: 5,
    model: 'claude-3-5-sonnet-20241022',
    provider: 'Anthropic',
    formatted_request: {
      model: 'claude-3-5-sonnet-20241022',
      system: 'Act as a {{character}} reviewer.',
      messages: [{ role: 'user', content: 'Review {{input}}.' }],
      max_tokens: 8192,
      temperature: 0.5,
    },
    hash: 'ed651609',
    commit_title: 'review prompt',
    created_at: '2025-01-13T16:43:07+00:00',
    variables: { character: 'careful' },
    project: { id: 4948, type: 'chat', name: 'Review prompt', description: 'Reviews changes.', groups: [] },
    configuration: { id: 1243, max_tokens: 8192, temperature: 0.5, top_p: null },
    tools: [],
    ...overrides,
  }
}

async function mockPromptHub() {
  let current = revision()
  let projects = [{ id: 4948, type: 'chat', name: 'Review prompt', description: 'Reviews changes.', head: { id: 1167, hash: current.hash } }]
  let available = true
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization })
    if (!available) return request.socket.destroy()
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/api/v1/teams/42/projects') return response.end(JSON.stringify({ data: projects, status: 'OK', code: 200 }))
    if (request.url?.startsWith('/api/v1/projects/4948/head')) return response.end(JSON.stringify({ data: current, status: 'OK', code: 200 }))
    response.statusCode = 404
    response.end(JSON.stringify({ status: 'NOT_FOUND', code: 404 }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    change(next) { current = revision(next); projects = projects.map((item) => ({ ...item, head: { ...item.head, hash: current.hash } })) },
    deleteRemote() { projects = [] },
    fail() { available = false },
  }
}

async function fixture(options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'skillops-prompthub-'))
  roots.push(dataDir)
  const remote = await mockPromptHub()
  const locals = []
  const connector = createPromptHubConnector({
    dataDir,
    baseUrl: remote.baseUrl,
    teamId: '42',
    getCredential: async () => 'test-token',
    listLocalArtifacts: async () => locals,
    ...options,
  })
  return { connector, dataDir, locals, remote }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PromptHub v1 connector contract', () => {
  it('lists projects and maps the documented head response to a non-Git Prompt Artifact', async () => {
    const { connector, remote } = await fixture()
    expect(connector.metadata).toEqual(expect.objectContaining({
      apiVersion: 'v1', authorization: 'bearer', strategy: 'pull-only', capabilities: PROMPTHUB_V1.capabilities,
    }))
    expect(await connector.listArtifacts()).toEqual([
      expect.objectContaining({ remoteId: '4948', name: 'Review prompt', head: expect.objectContaining({ revision: 'ed651609' }) }),
    ])
    const version = await connector.getVersion({ projectId: '4948' })
    expect(version.artifact).toEqual(expect.objectContaining({
      kind: 'prompt', artifactId: 'prompthub-4948', version: 'ed651609', source: 'prompthub',
      sourceRef: expect.stringMatching(/^prompthub:v1:4948:ed651609:[a-f0-9]{64}$/),
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }))
    expect(version.artifact).not.toHaveProperty('gitCommit')
    const gitEquivalent = adaptPromptDefinition({
      schemaVersion: 1,
      id: 'prompthub-4948',
      name: 'Review prompt',
      system: 'Act as a {{character}} reviewer.',
      messages: [{ role: 'user', content: 'Review {{input}}.' }],
      variables: ['character'],
      variableDefaults: { character: 'careful' },
    }, { commit: 'a'.repeat(40), relativePath: 'prompts/review.prompt.json' })
    expect(version.artifact.variables).toEqual(['character', 'input'])
    expect(version.artifact.componentHashes.variables).toBe(gitEquivalent.artifact.componentHashes.variables)
    expect(version.prompt.messages).toEqual([{ role: 'user', content: 'Review {{input}}.' }])
    expect(remote.requests.every((item) => item.authorization === 'Bearer test-token')).toBe(true)
    await expect(connector.getVersion({ projectId: '4948', revision: '00000000' })).rejects.toThrow('current branch head')
    await expect(connector.getVersion(
      version.artifact.sourceRef.replace(':ed651609:', ':deadbeef:'),
    )).rejects.toThrow('requested revision is unavailable')
    await expect(connector.getVersion(
      `${version.artifact.sourceRef.slice(0, -64)}${'f'.repeat(64)}`,
    )).rejects.toThrow('no longer matches the immutable reference')
    const branchVersion = await connector.getVersion({ projectId: '4948', branch: 'feature/review' })
    expect(branchVersion.ref).toEqual({ projectId: '4948', revision: 'ed651609', branch: 'feature/review' })
    expect(branchVersion.artifact.sourceRef).toMatch(/^prompthub:v1:4948:branch:feature%2Freview:ed651609:[a-f0-9]{64}$/)
    await connector.getVersion(branchVersion.artifact.sourceRef)
    expect(remote.requests.filter((item) => item.url === '/api/v1/projects/4948/head?branch=feature%2Freview')).toHaveLength(2)
  })

  it('previews component hashes, imports only as Candidate, and persists metadata-only sync audit', async () => {
    const { connector, dataDir, locals, remote } = await fixture()
    const preview = await connector.previewImport({ projectId: '4948', branch: 'feature/review' })
    expect(preview).toEqual(expect.objectContaining({
      mode: 'preview', persisted: false, targetStatus: 'candidate', replacesStable: false,
      version: expect.objectContaining({ artifact: expect.objectContaining({ componentHashes: expect.any(Object) }) }),
      diff: expect.objectContaining({ changed: true, changedComponents: expect.arrayContaining(['prompt']) }),
    }))
    expect(preview.version).not.toHaveProperty('prompt')
    expect(preview.diff).not.toHaveProperty('content')
    expect(JSON.stringify(preview)).not.toContain('Review {{input}}.')
    const imported = await connector.applyImport(preview.previewToken, async (version) => {
      const commit = 'c'.repeat(40)
      const contentHash = 'b'.repeat(64)
      const artifact = {
        ...version.artifact,
        version: commit,
        source: 'git',
        sourceRef: `git:v1:${'d'.repeat(64)}:${commit}:prompts%2Fprompthub-4948.prompt.json:${contentHash}`,
        contentHash,
        gitCommit: commit,
        repository: `git-root:${commit}`,
      }
      locals.push({ artifact })
      return { stage: 'candidate', artifact }
    })
    expect(imported).toEqual(expect.objectContaining({ stage: 'candidate' }))
    expect(imported.artifact.source).toBe('git')
    expect(await connector.compareState()).toEqual([
      expect.objectContaining({ remoteId: '4948', type: 'synchronized', blocking: false }),
    ])
    const persisted = `${await readFile(path.join(dataDir, 'prompthub-sync.json'), 'utf8')}\n${await readFile(path.join(dataDir, 'prompthub-sync-audit.jsonl'), 'utf8')}`
    expect(persisted).toContain('ed651609')
    expect(persisted).toContain('feature/review')
    expect(persisted).toContain('b'.repeat(64))
    expect(persisted).not.toContain('Act as a')
    expect(persisted).not.toContain('test-token')
    expect(persisted).not.toContain('Review {{input}}')

    remote.change({
      id: 1168,
      hash: 'ed651610',
      formatted_request: { ...revision().formatted_request, system: 'Act as a strict {{character}} reviewer.' },
    })
    const nextPreview = await connector.previewImport({ projectId: '4948', branch: 'feature/review' })
    expect(nextPreview.currentArtifact.contentHash).toBe(imported.artifact.contentHash)
    const nextLocalHash = 'e'.repeat(64)
    await connector.applyImport(nextPreview.previewToken, async (version) => {
      const commit = 'f'.repeat(40)
      const artifact = {
        ...version.artifact,
        version: commit,
        source: 'git',
        sourceRef: `git:v1:${'d'.repeat(64)}:${commit}:prompts%2Fprompthub-4948.prompt.json:${nextLocalHash}`,
        contentHash: nextLocalHash,
        gitCommit: commit,
        repository: `git-root:${commit}`,
      }
      locals.push({ artifact, stage: 'candidate' })
      return { stage: 'candidate', artifact }
    })
    expect(await connector.compareState()).toEqual([
      expect.objectContaining({ remoteId: '4948', type: 'synchronized', blocking: false }),
    ])
    locals.reverse()
    remote.change({
      id: 1169,
      hash: 'ed651611',
      formatted_request: { ...revision().formatted_request, system: 'Act as an exact {{character}} reviewer.' },
    })
    expect((await connector.previewImport({ projectId: '4948', branch: 'feature/review' })).currentArtifact.contentHash).toBe(nextLocalHash)
  })

  it('restores sync state and compensates a new Candidate when audit persistence fails', async () => {
    const { connector, dataDir } = await fixture()
    const preview = await connector.previewImport({ projectId: '4948' })
    const imported = { capability: { id: 'cap-1', stage: 'candidate', artifact: { contentHash: 'a'.repeat(64) } }, reused: false }
    const compensated = []
    await rm(path.join(dataDir, 'prompthub-sync-audit.jsonl'))
    await mkdir(path.join(dataDir, 'prompthub-sync-audit.jsonl'))

    await expect(connector.applyImport(
      preview.previewToken,
      async () => imported,
      async (result) => compensated.push(result),
    )).rejects.toThrow()

    expect(compensated).toEqual([imported])
    expect(JSON.parse(await readFile(path.join(dataDir, 'prompthub-sync.json'), 'utf8')).links).toEqual({})
  })

  it('blocks bidirectional conflicts and keeps local state when remote changes, disappears, or is unavailable', async () => {
    const { connector, locals, remote } = await fixture()
    const preview = await connector.previewImport({ projectId: '4948' })
    await connector.applyImport(preview.previewToken, async (version) => { locals.push(version); return version })
    locals[0].stage = 'stable'
    locals.push({ artifact: { ...locals[0].artifact, contentHash: 'e'.repeat(64) }, stage: 'candidate' })
    expect(await connector.compareState()).toEqual([
      expect.objectContaining({ remoteId: '4948', type: 'local-changed', blocking: true, localContentHash: 'e'.repeat(64) }),
    ])
    locals.pop()

    locals[0] = { ...locals[0], artifact: { ...locals[0].artifact, contentHash: 'f'.repeat(64) } }
    remote.change({ hash: 'deadbeef', formatted_request: { ...revision().formatted_request, system: 'Remote changed.' } })
    expect(await connector.compareState()).toEqual([
      expect.objectContaining({ remoteId: '4948', type: 'conflict', blocking: true, autoResolve: false }),
    ])

    remote.deleteRemote()
    expect(await connector.compareState()).toEqual([
      expect.objectContaining({ remoteId: '4948', type: 'remote-deleted', action: 'keep-local', localStablePreserved: true }),
    ])

    remote.fail()
    expect(await connector.compareState()).toEqual([
      expect.objectContaining({ remoteId: '4948', type: 'remote-unavailable', localStablePreserved: true }),
    ])
  })

  it('exposes only the documented read contract and rejects unsupported write strategies at configuration time', async () => {
    const pull = await fixture()
    await expect(pull.connector.publishVersion({})).rejects.toThrow('pull-only')
    await expect(fixture({ strategy: 'manual' })).rejects.toThrow('only pull-only')
    await expect(fixture({ strategy: 'push-only' })).rejects.toThrow('only pull-only')
  })
})
