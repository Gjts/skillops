// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createArtifactRegistry } from './artifact-registry.mjs'
import { handleArtifactRegistryApi } from './artifact-registry-api.mjs'

const roots = []
const hash = (value) => value.repeat(64)
const commit = (value) => value.repeat(40)
const githubRef = (revision, sourcePath) => `github:https://github.com/acme/assets/blob/${revision}/${sourcePath}#${encodeURIComponent(sourcePath)}`
const gitRef = (revision, sourcePath, contentHash) => `git:v1:${hash('a')}:${revision}:${encodeURIComponent(sourcePath)}:${contentHash}`

function artifact(overrides = {}) {
  return {
    kind: 'skill',
    artifactId: 'review',
    version: '2.0.0',
    source: 'github',
    sourceRef: githubRef(commit('a'), 'skills/review/SKILL.md'),
    contentHash: hash('3'),
    gitCommit: commit('a'),
    repository: 'https://github.com/acme/assets',
    dependencies: ['rules:secure-defaults'],
    ...overrides,
  }
}

async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'skillops-artifact-registry-'))
  roots.push(dataDir)
  const stable = artifact({ gitCommit: undefined })
  const missing = artifact({ artifactId: 'missing', contentHash: hash('4'), sourceRef: githubRef(commit('f'), 'skills/missing/SKILL.md'), gitCommit: commit('f') })
  const scans = [
    {
      skillId: 'review', skillVersion: '1.0.0', runtime: 'codex', source: 'project',
      sourcePath: '/repo/.codex/skills/review/SKILL.md', kind: 'skill', provider: 'Project', enabled: true,
      status: 'active', scope: 'project', projectRoot: '/repo', contentHash: hash('1'), description: 'Review code.',
    },
    {
      skillId: 'review', skillVersion: 'legacy', runtime: 'claude-code', source: 'project',
      sourcePath: '/repo/.claude/commands/review.md', kind: 'command', provider: 'Project', enabled: true,
      status: 'active', scope: 'project', projectRoot: '/repo', contentHash: hash('2'), description: 'Review command.',
    },
    {
      skillId: 'review', skillVersion: '1.0.0', runtime: 'claude-code', source: 'project',
      sourcePath: '/repo/.claude/skills/review/SKILL.md', kind: 'skill', provider: 'Project', enabled: true,
      status: 'active', scope: 'project', projectRoot: '/repo', contentHash: hash('1'), description: 'Review code.',
    },
    {
      skillId: 'ghost', skillVersion: 'unversioned', runtime: 'claude-code', source: 'project',
      sourcePath: '/repo/.claude/skills/ghost/SKILL.md', kind: 'skill', provider: 'Project', enabled: false,
      status: 'missing', scope: 'project', projectRoot: '/repo',
    },
  ]
  const blocked = artifact({ kind: 'rules', artifactId: 'secure-defaults', contentHash: hash('6') })
  const retired = artifact({ kind: 'workflow', artifactId: 'legacy-release', contentHash: hash('7') })
  const workflowCandidate = artifact({
    kind: 'workflow', artifactId: 'legacy-release', version: '3.0.0',
    contentHash: hash('9'), sourceRef: githubRef(commit('c'), 'workflows/release.md'), gitCommit: commit('c'),
  })
  const promptStable = artifact({
    kind: 'prompt', artifactId: 'release-summary', source: 'prompt-registry',
    sourceRef: `prompt-registry:${commit('b')}:prompts%2Frelease.prompt.json:${hash('8')}`,
    contentHash: hash('8'), gitCommit: undefined,
  })
  const promptCurrent = artifact({
    kind: 'prompt', artifactId: 'release-summary', source: 'prompt-registry',
    sourceRef: `prompt-registry:${commit('d')}:prompts%2Frelease.prompt.json:${hash('8')}`,
    contentHash: hash('8'), gitCommit: undefined,
  })
  const gitPrompt = artifact({
    kind: 'prompt', artifactId: 'git-release-summary', source: 'git',
    sourceRef: gitRef(commit('e'), 'prompts/release.prompt.json', hash('e')),
    contentHash: hash('e'), gitCommit: commit('e'),
  })
  const gitAgent = artifact({
    kind: 'agent',
    artifactId: 'review-agent',
    version: '1.0.0',
    source: 'git',
    sourceRef: gitRef(commit('e'), 'agents/review.md', hash('a')),
    contentHash: hash('a'),
    gitCommit: commit('e'),
    repository: `git-root:${commit('1')}`,
    runtimeTargets: ['claude-code'],
  })
  const approvedPolicy = artifact({
    kind: 'policy-pack', artifactId: 'secure-release', version: '1.0.0',
    sourceRef: githubRef(commit('9'), 'policies/secure-release.json'), contentHash: hash('9'), gitCommit: commit('9'),
  })
  const evaluationSuite = artifact({
    kind: 'evaluation-suite', artifactId: 'ci-quality', version: '1.0.0',
    sourceRef: githubRef(commit('8'), 'evals/suites/ci-quality.json'), contentHash: hash('8'), gitCommit: commit('8'),
  })
  const capabilities = [
    { id: 'cap-retired-review', artifact: artifact({ version: '0.9.0', contentHash: hash('0'), sourceRef: githubRef(commit('0'), 'skills/review/SKILL.md'), gitCommit: commit('0') }), owner: 'former-owner', stage: 'rolled-back', createdAt: '2026-07-21T00:00:00.000Z' },
    { id: 'cap-stable', artifact: stable, owner: 'platform', stage: 'stable', createdAt: '2026-07-22T00:00:00.000Z' },
    { id: 'cap-blocked', artifact: blocked, owner: 'security', stage: 'blocked', createdAt: '2026-07-22T00:00:00.000Z' },
    { id: 'cap-retired', artifact: retired, owner: 'release', stage: 'deprecated', createdAt: '2026-07-22T00:00:00.000Z' },
    { id: 'cap-workflow-candidate', artifact: workflowCandidate, owner: 'release', stage: 'candidate', createdAt: '2026-07-22T00:00:00.000Z' },
    { id: 'cap-prompt', artifact: promptStable, owner: 'prompt-owner', stage: 'stable', createdAt: '2026-07-22T00:00:00.000Z' },
    { id: 'cap-agent-ready', artifact: gitAgent, owner: 'agents', stage: 'ready', createdAt: '2026-07-22T00:00:00.000Z' },
    { id: 'cap-policy-approved', artifact: approvedPolicy, owner: 'security', stage: 'approved', createdAt: '2026-07-22T00:00:00.000Z' },
  ]
  const targets = {
    'local-scan:codex:/repo/.codex/skills/review/SKILL.md': { stable: { capabilityId: 'cap-stable', artifact: stable }, canary: null, previous: [] },
    'local-scan:claude-code:/repo/.claude/skills/missing/SKILL.md': { stable: { capabilityId: 'cap-missing', artifact: missing }, canary: null, previous: [] },
    'prompt:release-summary': { stable: { capabilityId: 'cap-prompt', artifact: promptStable }, canary: { capabilityId: 'cap-prompt-current', artifact: promptCurrent }, previous: [] },
    'prompt:git-release-summary': { stable: { capabilityId: 'cap-git-prompt', artifact: gitPrompt }, canary: null, previous: [] },
    'evaluation-suite:ci-quality': { stable: { capabilityId: 'cap-evaluation-suite', artifact: evaluationSuite }, canary: null, previous: [] },
    'policy-pack:secure-release': { stable: { capabilityId: 'cap-policy-pack', artifact: approvedPolicy }, canary: null, previous: [] },
  }
  const discover = vi.fn(async () => ({
    definition: { artifact: artifact({ contentHash: hash('5'), gitCommit: commit('e'), sourceRef: githubRef(commit('e'), 'skills/review/SKILL.md') }), contents: 'private candidate body' },
    candidates: [],
  }))
  const registryOptions = {
    dataDir,
    scanInstalledSkills: async () => scans,
    capabilityRegistry: { list: async () => capabilities },
    skeletonLock: { read: async () => ({ schemaVersion: 1, updatedAt: null, targets }) },
    promptRegistry: { list: async () => ({ items: [{ artifact: promptCurrent, discoveredAt: '2026-07-22T00:30:00.000Z' }] }) },
    discoverCandidateArtifact: discover,
    gitArtifactSource: { list: async () => ({ items: [{ artifact: gitAgent }] }) },
    now: () => new Date('2026-07-22T01:00:00.000Z'),
  }
  const registry = createArtifactRegistry(registryOptions)
  return { dataDir, registry, registryOptions, scans, discover }
}

function request(method = 'GET', body) {
  const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body))
  return {
    method,
    headers: {
      host: '127.0.0.1:4173',
      origin: 'http://127.0.0.1:4173',
      ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.byteLength) } : {}),
    },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (bytes) yield bytes },
  }
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(value = '') { this.body += value },
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('unified Artifact Registry', () => {
  it('keeps kind-scoped identities, immutable versions, compatibility, and desired/observed drift', async () => {
    const { registry } = await fixture()
    const snapshot = await registry.list()

    expect(snapshot.artifacts.map((item) => item.id)).toEqual(expect.arrayContaining(['skill:review', 'workflow:review', 'agent:review-agent']))
    expect(snapshot.artifacts).toContainEqual(expect.objectContaining({ id: 'skill:review', status: 'stable', owner: 'platform' }))
    expect(snapshot.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rules:secure-defaults', status: 'blocked' }),
      expect.objectContaining({ id: 'workflow:legacy-release', status: 'candidate' }),
      expect.objectContaining({ id: 'agent:review-agent', status: 'ready' }),
      expect.objectContaining({ id: 'policy-pack:secure-release', status: 'stable' }),
    ]))
    expect(snapshot.versions).toContainEqual(expect.objectContaining({
      id: `skill:review@${commit('a')}:${hash('3')}`,
      artifactId: 'skill:review',
      gitCommit: commit('a'),
      status: 'stable',
      dependencies: ['rules:secure-defaults'],
    }))
    expect(snapshot.versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifactId: 'agent:review-agent', status: 'ready' }),
      expect.objectContaining({ artifactId: 'policy-pack:secure-release', status: 'stable' }),
    ]))
    expect(snapshot.versions).toContainEqual(expect.objectContaining({
      id: `prompt:release-summary@${commit('b')}:${hash('8')}`,
      gitCommit: commit('b'),
    }))
    expect(snapshot.versions).toContainEqual(expect.objectContaining({
      id: `prompt:release-summary@${commit('d')}:${hash('8')}`,
      gitCommit: commit('d'),
      status: 'canary',
    }))
    expect(snapshot.versions).toContainEqual(expect.objectContaining({
      id: `skill:review@working-tree:${hash('1')}`,
      runtimeTargets: ['claude-code', 'codex'],
      status: 'draft',
    }))
    expect(snapshot.artifacts).toContainEqual(expect.objectContaining({ id: 'skill:missing', status: 'stable' }))
    expect(snapshot.artifacts.find((item) => item.id === 'skill:ghost')).toBeUndefined()
    expect(snapshot.versions).toContainEqual(expect.objectContaining({
      artifactId: 'workflow:legacy-release',
      status: 'deprecated',
    }))
    expect(snapshot.compatibility.workflow).toEqual({ codex: 'supported', 'claude-code': 'supported', cursor: 'preview' })
    expect(snapshot.installations).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetPath: '/repo/.codex/skills/review/SKILL.md', desiredState: 'present', observedState: 'drifted', observedHash: hash('1') }),
      expect.objectContaining({ targetPath: '/repo/.claude/skills/missing/SKILL.md', runtime: 'claude-code', desiredState: 'present', observedState: 'missing' }),
      expect.objectContaining({ targetPath: 'prompt:release-summary', desiredState: 'present', observedState: 'present', observedHash: hash('8') }),
      expect.objectContaining({ targetPath: 'prompt:git-release-summary', desiredState: 'present', observedState: 'present', observedHash: hash('e') }),
      expect.objectContaining({ targetPath: 'evaluation-suite:ci-quality', desiredState: 'present', observedState: 'present', observedHash: hash('8') }),
      expect.objectContaining({ targetPath: 'policy-pack:secure-release', desiredState: 'present', observedState: 'present', observedHash: hash('9') }),
    ]))
    expect(snapshot.installations.filter((item) => item.targetPath === 'prompt:release-summary')).toHaveLength(2)
    expect(JSON.stringify(snapshot)).not.toContain('private candidate body')
  })

  it('resolves relative scan paths against the configured managed root', async () => {
    const { dataDir, registryOptions, scans } = await fixture()
    scans.push({
      skillId: 'relative', skillVersion: '1.0.0', runtime: 'codex', source: 'project',
      sourcePath: 'skills/relative/SKILL.md', kind: 'skill', provider: 'Project', enabled: true,
      status: 'active', scope: 'project', projectRoot: dataDir, contentHash: hash('5'),
    })
    registryOptions.skeletonRoot = dataDir
    const relativeArtifact = artifact({ artifactId: 'relative', contentHash: hash('5') })
    registryOptions.skeletonLock = {
      read: async () => ({
        schemaVersion: 1,
        targets: {
          'local-scan:codex:skills/relative/SKILL.md': {
            stable: { capabilityId: 'cap-relative', artifact: relativeArtifact },
            canary: null,
            previous: [],
          },
        },
      }),
    }
    const snapshot = await createArtifactRegistry(registryOptions).list()
    const relativeInstallations = snapshot.installations.filter((item) => item.targetPath === path.join(dataDir, 'skills/relative/SKILL.md'))
    expect(relativeInstallations).toEqual([
      expect.objectContaining({ observedState: 'present', observedHash: hash('5') }),
    ])
  })

  it('reconciles each Canary against its own project scan', async () => {
    const { dataDir, registryOptions } = await fixture()
    const canaryRoot = path.join(dataDir, 'canary-project')
    const targetSkeleton = path.join('skills', 'review', 'SKILL.md')
    const targetFile = path.join(canaryRoot, targetSkeleton)
    const candidate = artifact({ contentHash: hash('c'), runtimeTargets: ['codex'] })
    await mkdir(canaryRoot)
    registryOptions.skeletonRoot = dataDir
    registryOptions.skeletonLock = {
      read: async () => ({
        schemaVersion: 1,
        targets: {
          [targetSkeleton]: {
            stable: null,
            canary: { artifact: candidate, projectRoot: canaryRoot, targetSkeleton },
            previous: [],
          },
        },
      }),
    }
    registryOptions.scanInstalledSkills = vi.fn(async ({ projectRoot }) => (
      path.resolve(projectRoot) === path.resolve(canaryRoot)
        ? [{
            skillId: 'review', skillVersion: '2.0.0', runtime: 'codex', source: 'project',
            sourcePath: targetFile, kind: 'skill', provider: 'Project', enabled: true,
            status: 'active', scope: 'project', projectRoot: canaryRoot, contentHash: candidate.contentHash,
          }]
        : []
    ))

    const snapshot = await createArtifactRegistry(registryOptions).list()

    expect(registryOptions.scanInstalledSkills.mock.calls.map(([options]) => path.resolve(options.projectRoot))).toEqual(
      expect.arrayContaining([path.resolve(dataDir), path.resolve(canaryRoot)]),
    )
    expect(snapshot.installations).toContainEqual(expect.objectContaining({
      targetPath: targetFile,
      observedState: 'present',
      observedHash: candidate.contentHash,
    }))
  })

  it('does not promote commitless scans from matching released content hashes', async () => {
    const { registryOptions } = await fixture()
    const released = {
      ...artifact({ contentHash: hash('1') }),
      source: 'local-scan',
      sourceRef: 'local-scan:codex:/repo/.codex/skills/review/SKILL.md',
      gitCommit: undefined,
    }
    registryOptions.capabilityRegistry = {
      list: async () => [{ id: 'cap-stable', artifact: released, owner: 'platform', stage: 'stable' }],
    }
    registryOptions.skeletonLock = { read: async () => ({ schemaVersion: 1, targets: {} }) }

    const snapshot = await createArtifactRegistry(registryOptions).list()
    expect(snapshot.versions).toContainEqual(expect.objectContaining({
      id: `skill:review@working-tree:${hash('1')}`,
      gitCommit: null,
      status: 'ready',
    }))
  })

  it('keeps live and locked assets available when the Prompt source is offline', async () => {
    const { registryOptions } = await fixture()
    registryOptions.promptRegistry = { list: async () => { throw new Error('workspace unavailable') } }
    registryOptions.capabilityRegistry = { list: async () => [] }
    const snapshot = await createArtifactRegistry(registryOptions).list()

    expect(snapshot.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'skill:review' }),
      expect.objectContaining({ id: 'prompt:release-summary', status: 'stable' }),
    ]))
    expect(snapshot.warnings).toEqual([{ source: 'prompt-registry', code: 'PROMPT_SOURCE_UNAVAILABLE' }])
  })

  it('previews GitHub Candidates without persistence and returns metadata-only version Diff', async () => {
    const { registry, discover } = await fixture()
    const before = await registry.list()
    const preview = await registry.previewImport({
      sourceUrl: 'https://github.com/acme/assets',
      sourcePath: 'skills/review/SKILL.md',
    })
    const after = await registry.list()

    expect(preview).toEqual(expect.objectContaining({ mode: 'preview', persisted: false }))
    expect(preview.version).toEqual(expect.objectContaining({ status: 'candidate', gitCommit: commit('e') }))
    expect(discover).toHaveBeenCalledWith({
      sourceUrl: 'https://github.com/acme/assets',
      candidatePath: 'skills/review/SKILL.md',
    }, expect.any(Object))
    expect(JSON.stringify(preview)).not.toContain('private candidate body')
    expect(after.versions).toEqual(before.versions)

    const left = before.versions.find((item) => item.contentHash === hash('1'))
    const right = before.versions.find((item) => item.contentHash === hash('3'))
    const diff = await registry.diff({ leftId: left.id, rightId: right.id })
    expect(diff).toEqual(expect.objectContaining({ changed: true, artifactId: 'skill:review' }))
    expect(diff.changedFields).toEqual(expect.arrayContaining(['contentHash', 'gitCommit', 'source']))
  })

  it('applies a one-time legacy snapshot migration and rolls it back', async () => {
    const { dataDir, registry, scans } = await fixture()
    const preview = await registry.previewMigration()
    expect(preview).toEqual(expect.objectContaining({
      action: 'create',
      backupHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expiresAt: '2026-07-22T01:10:00.000Z',
    }))

    const applied = await registry.applyMigration(preview.previewToken)
    const file = path.join(dataDir, 'artifact-registry.json')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(expect.objectContaining({ schemaVersion: 1, migration: expect.objectContaining({ id: applied.migrationId, appliedAt: '2026-07-22T01:00:00.000Z' }) }))
    expect(await registry.previewMigration()).toEqual(expect.objectContaining({
      action: 'noop',
      migrationId: applied.migrationId,
      backupHash: applied.backupHash,
      previewToken: null,
    }))

    scans.splice(0)
    expect((await registry.list()).artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'workflow:review', status: 'deprecated' }),
    ]))

    const validMigration = await readFile(file)
    const changedAfterApply = JSON.parse(validMigration.toString('utf8'))
    changedAfterApply.artifacts[0].name = 'tampered'
    await writeFile(file, JSON.stringify(changedAfterApply), 'utf8')
    await expect(registry.list()).rejects.toThrow('changed after migration apply')
    await expect(registry.previewMigration()).rejects.toThrow('changed after migration apply')
    await expect(registry.rollbackMigration(applied.migrationId)).rejects.toThrow('changed after migration apply')
    await writeFile(file, validMigration)
    const corruptMigration = JSON.parse(validMigration.toString('utf8'))
    corruptMigration.versions.push({ kind: 'unknown' })
    await writeFile(file, JSON.stringify(corruptMigration), 'utf8')
    await expect(registry.list()).rejects.toThrow('changed after migration apply')
    await writeFile(file, validMigration)

    await registry.rollbackMigration(applied.migrationId)
    expect((await registry.list()).artifacts.find((item) => item.id === 'workflow:review')).toBeUndefined()
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(file, Buffer.from('legacy registry bytes\r\n', 'utf8'))
    await expect(registry.previewMigration()).rejects.toThrow('format is not recognized')
    const legacy = Buffer.from(`${JSON.stringify({
      schemaVersion: 0,
      definitions: [{
        skillId: 'legacy-review',
        skillVersion: '0.5.0',
        runtime: 'codex',
        sourcePath: '/legacy/review/SKILL.md',
        contentHash: hash('b'),
        kind: 'skill',
        description: 'Legacy review metadata.',
        discoveredAt: '2026-07-20T00:00:00.000Z',
      }],
    })}\n`, 'utf8')
    await writeFile(file, legacy)
    const replacement = await registry.previewMigration()
    expect(replacement.action).toBe('replace')
    const replaced = await registry.applyMigration(replacement.previewToken)
    expect(JSON.parse(await readFile(file, 'utf8')).versions).toContainEqual(expect.objectContaining({
      artifactId: 'skill:legacy-review',
      status: 'deprecated',
      contentHash: hash('b'),
    }))
    const migrated = JSON.parse(await readFile(file, 'utf8'))
    const backupFile = migrated.migration.backupFile
    migrated.migration.previousExisted = false
    await writeFile(file, JSON.stringify(migrated), 'utf8')
    await expect(registry.rollbackMigration(replaced.migrationId)).rejects.toThrow('changed after migration apply')
    migrated.migration.previousExisted = true
    migrated.migration.backupFile = '../outside'
    await writeFile(file, JSON.stringify(migrated), 'utf8')
    await expect(registry.rollbackMigration(replaced.migrationId)).rejects.toThrow('backup reference')
    migrated.migration.backupFile = backupFile
    await writeFile(file, JSON.stringify(migrated), 'utf8')
    await registry.rollbackMigration(replaced.migrationId)
    expect(await readFile(file)).toEqual(legacy)
    await rm(file)
    await mkdir(file)
    await expect(registry.previewMigration()).rejects.toThrow('regular non-symlink file')
  })

  it('serializes migration apply across instances and distinguishes absent from empty files', async () => {
    const { dataDir, registry, registryOptions } = await fixture()
    const other = createArtifactRegistry(registryOptions)
    const [left, right] = await Promise.all([registry.previewMigration(), other.previewMigration()])
    const results = await Promise.allSettled([
      registry.applyMigration(left.previewToken),
      other.applyMigration(right.previewToken),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')?.reason.message).toContain('changed after migration preview')

    const file = path.join(dataDir, 'artifact-registry.json')
    await rm(file)
    const preview = await registry.previewMigration()
    await writeFile(file, Buffer.alloc(0))
    await expect(registry.applyMigration(preview.previewToken)).rejects.toThrow('changed after migration preview')
  })
})

describe('Artifact Registry API', () => {
  it('serves metadata and validates Candidate import previews', async () => {
    const artifactRegistry = {
      list: vi.fn().mockResolvedValue({ schemaVersion: 1, artifacts: [], versions: [], installations: [] }),
      previewImport: vi.fn().mockResolvedValue({ mode: 'preview', persisted: false }),
      refresh: vi.fn().mockResolvedValue({ refreshed: true }),
      diff: vi.fn().mockResolvedValue({ changed: true }),
      previewMigration: vi.fn().mockResolvedValue({ action: 'create', previewToken: 'preview' }),
      applyMigration: vi.fn().mockResolvedValue({ applied: true, migrationId: 'migration-1' }),
      rollbackMigration: vi.fn().mockResolvedValue({ rolledBack: true }),
    }
    const listResponse = response()
    expect(await handleArtifactRegistryApi(request(), listResponse, '/api/artifacts', { artifactRegistry })).toBe(true)
    expect(listResponse.statusCode).toBe(200)
    expect(JSON.parse(listResponse.body).schemaVersion).toBe(1)

    const previewResponse = response()
    await handleArtifactRegistryApi(request('POST', { sourceUrl: 'https://github.com/acme/assets' }), previewResponse, '/api/artifacts/import-preview', { artifactRegistry })
    expect(previewResponse.statusCode).toBe(200)
    expect(artifactRegistry.previewImport).toHaveBeenCalledWith({ sourceUrl: 'https://github.com/acme/assets', sourcePath: undefined })

    await handleArtifactRegistryApi(request('POST', {}), response(), '/api/artifacts/refresh', { artifactRegistry })
    await handleArtifactRegistryApi(request('POST', { leftId: 'left', rightId: 'right' }), response(), '/api/artifacts/diff', { artifactRegistry })
    await handleArtifactRegistryApi(request('POST', {}), response(), '/api/artifacts/migration/preview', { artifactRegistry })
    await handleArtifactRegistryApi(request('POST', { previewToken: 'preview' }), response(), '/api/artifacts/migration/apply', { artifactRegistry })
    await handleArtifactRegistryApi(request('POST', {}), response(), '/api/artifacts/migration/migration-1/rollback', { artifactRegistry })
    expect(artifactRegistry.refresh).toHaveBeenCalledOnce()
    expect(artifactRegistry.diff).toHaveBeenCalledWith({ leftId: 'left', rightId: 'right' })
    expect(artifactRegistry.applyMigration).toHaveBeenCalledWith('preview')
    expect(artifactRegistry.rollbackMigration).toHaveBeenCalledWith('migration-1')

    const malformed = response()
    await handleArtifactRegistryApi(request('POST', {}), malformed, '/api/artifacts/migration/%/rollback', { artifactRegistry })
    expect(malformed.statusCode).toBe(422)
  })
})
