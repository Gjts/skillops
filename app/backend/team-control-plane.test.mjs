// @vitest-environment node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTeamControlPlane } from './team-control-plane.mjs'
import { canonicalJson } from './evaluations/suite-registry.mjs'
import { DEFAULT_GATE_POLICY, gatePolicyHash } from './governance/capability-policy.mjs'
import { createCapabilityRegistry } from './governance/capability-registry.mjs'
import { createSkeletonLock } from './governance/skeleton-lock.mjs'

const roots = []
const principal = (id, displayName = id) => ({ id, displayName, assurance: 'test' })

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-team-'))
  roots.push(dataDir)
  let instant = Date.parse('2026-07-22T00:00:00.000Z')
  const capability = {
    id: 'cap-review',
    stage: 'ready',
    owner: 'owner',
    targetSkeleton: 'project-a',
    artifact: { kind: 'skill', artifactId: 'review', contentHash: 'a'.repeat(64) },
    evidence: { evidenceHash: 'e'.repeat(64), qualityRunId: 'quality-1', redteamRunId: 'redteam-1' },
    originEvaluationRunId: 'origin-1',
    latestEvidenceRunId: 'latest-1',
  }
  const artifactVersion = {
    id: 'skill:review:a',
    kind: 'skill',
    sourceArtifactId: 'review',
    version: '2.0.0',
    contentHash: 'a'.repeat(64),
    source: 'github',
    status: 'candidate',
  }
  const controlPlane = createTeamControlPlane({
    dataDir,
    now: () => new Date(instant),
    artifactRegistry: { list: async () => ({ versions: [artifactVersion] }) },
    governance: { list: async () => [capability] },
    ...options,
  })
  return {
    dataDir,
    controlPlane,
    advance(days) { instant += days * 86_400_000 },
  }
}

describe('local-first Team control plane', () => {
  it('models Team entities and enforces Owner, Maintainer, Reviewer, Developer, and Viewer permissions', async () => {
    const { controlPlane, dataDir } = await fixture()
    const owner = principal('user:owner', 'Owner')
    const maintainer = principal('user:maintainer')
    const developer = principal('user:developer')
    const viewer = principal('user:viewer')

    expect(await controlPlane.snapshot(principal('unconfigured'))).toMatchObject({ team: null, revision: 0 })
    const initialized = await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)
    expect(initialized).toMatchObject({ team: { id: 'acme' }, capabilities: { deployment: 'local-git', networkApi: false, sso: false, scim: false } })
    await expect(controlPlane.saveEntity('member', { id: owner.id, role: 'Viewer' }, owner)).rejects.toThrow('active Owner')
    await controlPlane.saveEntity('member', { id: maintainer.id, role: 'Maintainer' }, owner)
    await controlPlane.saveEntity('member', { id: developer.id, role: 'Developer' }, owner)
    await controlPlane.saveEntity('member', { id: viewer.id, role: 'Viewer' }, owner)
    await controlPlane.saveEntity('workspace', { id: 'engineering', name: 'Engineering' }, maintainer)
    const projectRoot = path.join(dataDir, 'project-a')
    const managedContents = '# Managed rules\n'
    await mkdir(path.join(projectRoot, '.skillops'), { recursive: true })
    await writeFile(path.join(projectRoot, 'AGENTS.md'), managedContents)
    await writeFile(path.join(projectRoot, '.skillops', 'team-template.lock.json'), `${JSON.stringify({
      schemaVersion: 1,
      template: { id: 'team-default', version: '1.0.0', templateHash: 'f'.repeat(64) },
      files: [{
        path: 'AGENTS.md',
        contentHash: createHash('sha256').update(managedContents).digest('hex'),
        sourceRef: `git:${'a'.repeat(40)}:AGENTS.md`,
        mode: 0o644,
      }],
      previousStableCommit: null,
    }, null, 2)}\n`)
    await controlPlane.saveEntity('project', {
      id: 'project-a',
      workspaceId: 'engineering',
      name: 'Project A',
      projectRoot,
      repository: 'git@example.invalid:acme/a.git',
      artifactIds: ['skill:review'],
      template: { id: 'team-default', version: '1.0.0', status: 'current', candidateVersion: '2.0.0' },
    }, maintainer)
    expect(await controlPlane.resolveProjectRoot('project-a')).toBe(path.join(dataDir, 'project-a'))
    await expect(controlPlane.resolveProjectRoot()).rejects.toThrow('Project ID')
    await expect(controlPlane.saveEntity('project', {
      id: 'project-b',
      workspaceId: 'engineering',
      name: 'Project B',
      projectRoot: 'relative/project',
    }, maintainer)).rejects.toThrow('absolute')
    await controlPlane.saveEntity('environment', { id: 'production', projectId: 'project-a', name: 'Production', channel: 'stable' }, maintainer)

    await expect(controlPlane.saveEntity('workspace', { id: 'forbidden', name: 'Forbidden' }, developer)).rejects.toThrow('Maintainer')
    await expect(controlPlane.registerDevice({ id: 'other', name: 'Other', memberId: developer.id }, viewer)).rejects.toThrow('Developer')
    expect(await controlPlane.snapshot(viewer)).toMatchObject({
      workspaces: [{ id: 'engineering' }],
      projects: [{ id: 'project-a', artifactIds: ['skill:review'], template: { id: 'team-default', version: '1.0.0', status: 'upgrade-available', candidateVersion: '2.0.0' } }],
      environments: [{ id: 'production', channel: 'stable' }],
      templateAdoption: { totalProjects: 1, adoptedProjects: 1, currentProjects: 0, driftedProjects: 0, pendingUpgradeProjects: 1, adoptionRatePct: 100 },
    })
    await writeFile(path.join(projectRoot, 'AGENTS.md'), '# Local drift\n')
    expect(await controlPlane.snapshot(viewer)).toMatchObject({
      projects: [{ id: 'project-a', template: { status: 'drifted', version: '1.0.0', candidateVersion: '2.0.0' } }],
      templateAdoption: { driftedProjects: 1, pendingUpgradeProjects: 0 },
    })
    await expect(controlPlane.snapshot(principal('unknown'))).rejects.toThrow('Viewer')
    await expect(controlPlane.removeEntity('project', 'project-a', maintainer)).rejects.toThrow('Environments')
    await controlPlane.removeEntity('environment', 'production', maintainer)
    await controlPlane.removeEntity('project', 'project-a', maintainer)
    await controlPlane.removeEntity('workspace', 'engineering', maintainer)
    expect(await controlPlane.snapshot(viewer)).toMatchObject({ workspaces: [], projects: [], environments: [] })
  })

  it('registers revocable least-privilege devices and persists only collector allowlisted metadata', async () => {
    const { controlPlane, dataDir } = await fixture()
    const owner = principal('user:owner')
    const developer = principal('user:developer')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)
    await controlPlane.saveEntity('member', { id: developer.id, role: 'Developer' }, owner)

    const registered = await controlPlane.registerDevice({ id: 'laptop', name: 'Laptop' }, developer)
    expect(registered.token).toHaveLength(43)
    expect(registered.device).toMatchObject({ id: 'laptop', scopes: ['collector:write'], status: 'active' })
    expect(registered.device).not.toHaveProperty('tokenHash')

    await expect(controlPlane.collect(registered.token, {
      events: [{
        id: 'account@example.com/session-123',
        event: 'skill.completed',
        skillId: 'review',
        runtime: 'codex',
        timestamp: '2026-07-22T00:00:00.000Z',
        outcome: 'success',
        project: 'secret-project',
        sourcePath: 'C:/secret/SKILL.md',
        error: 'raw failure',
        prompt: 'private prompt',
      }],
      evidence: [{ capabilityId: 'cap-review', artifactId: 'review', version: '2.0.0', contentHash: 'a'.repeat(64), evidenceHash: 'e'.repeat(64), gateResult: 'passed', score: 0.9 }],
    })).resolves.toEqual({ accepted: true, eventCount: 1, evidenceCount: 1 })

    const persisted = `${await readFile(path.join(dataDir, 'team-control-plane.json'), 'utf8')}\n${await readFile(path.join(dataDir, 'team-collector.jsonl'), 'utf8')}`
    expect(persisted).not.toContain(registered.token)
    expect(persisted).not.toContain('secret-project')
    expect(persisted).not.toContain('C:/secret')
    expect(persisted).not.toContain('raw failure')
    expect(persisted).not.toContain('private prompt')
    expect(persisted).not.toContain('account@example.com/session-123')
    expect(persisted).toContain('cap-review')

    await controlPlane.revokeDevice('laptop', developer)
    await expect(controlPlane.collect(registered.token, { events: [] })).rejects.toThrow('revoked')
  })

  it('rolls back collector state and metadata when its audit record cannot commit', async () => {
    const { controlPlane, dataDir } = await fixture()
    const owner = principal('user:owner')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)
    const registered = await controlPlane.registerDevice({ id: 'laptop', name: 'Laptop' }, owner)
    const stateBefore = await readFile(path.join(dataDir, 'team-control-plane.json'), 'utf8')
    await writeFile(path.join(dataDir, 'team-audit.jsonl'), 'invalid-audit-record\n', { flag: 'a' })

    await expect(controlPlane.collect(registered.token, { events: [{ event: 'session.started', runtime: 'codex' }] })).rejects.toThrow('audit log is invalid')
    expect(await readFile(path.join(dataDir, 'team-control-plane.json'), 'utf8')).toBe(stateBefore)
    expect(await readFile(path.join(dataDir, 'team-collector.jsonl'), 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error))).toBe('')
  })

  it('serves a verified Team audit prefix as partial while every audit mutation stays fail-closed', async () => {
    const { controlPlane, dataDir } = await fixture()
    const owner = principal('user:owner')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)
    const auditFile = path.join(dataDir, 'team-audit.jsonl')
    const validPrefix = await readFile(auditFile, 'utf8')
    await writeFile(auditFile, `${validPrefix}{"schemaVersion":1`, 'utf8')

    await expect(controlPlane.audit(owner)).resolves.toMatchObject({
      sourceStatus: 'partial',
      page: 1,
      pageSize: 50,
      totalItems: 1,
      totalPages: 1,
      revision: 1,
      items: [expect.objectContaining({ action: 'team.created' })],
    })
    const stateBefore = await readFile(path.join(dataDir, 'team-control-plane.json'), 'utf8')
    await expect(controlPlane.saveEntity('workspace', { id: 'engineering', name: 'Engineering' }, owner)).rejects.toThrow('partial trailing record')
    expect(await readFile(path.join(dataDir, 'team-control-plane.json'), 'utf8')).toBe(stateBefore)
    expect(await readFile(auditFile, 'utf8')).toBe(`${validPrefix}{"schemaVersion":1`)

    await writeFile(auditFile, `${validPrefix}not-json`, 'utf8')
    await expect(controlPlane.audit(owner, { page: 1_000_000, pageSize: 20 })).rejects.toThrow('audit log is invalid')

    const unsigned = { sequence: 1, previousHash: null }
    const semanticCorruption = { ...unsigned, hash: createHash('sha256').update(canonicalJson(unsigned)).digest('hex') }
    await writeFile(auditFile, `${JSON.stringify(semanticCorruption)}\n`, 'utf8')
    await expect(controlPlane.audit(owner, { page: 1_000_000, pageSize: 20 })).rejects.toThrow('audit log is invalid')
  })

  it('rejects partial or corrupt collector history before collection, retention, or backup GC changes', async () => {
    const pruneEvents = vi.fn()
    const evaluations = { pruneBefore: vi.fn() }
    const { controlPlane, dataDir } = await fixture({ pruneEvents, evaluations })
    const owner = principal('user:owner')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)
    const registered = await controlPlane.registerDevice({ id: 'laptop', name: 'Laptop' }, owner)
    await controlPlane.collect(registered.token, { events: [] })
    const collectorFile = path.join(dataDir, 'team-collector.jsonl')
    const validPrefix = await readFile(collectorFile, 'utf8')
    const stateBefore = await readFile(path.join(dataDir, 'team-control-plane.json'), 'utf8')
    const auditBefore = await readFile(path.join(dataDir, 'team-audit.jsonl'), 'utf8')

    await writeFile(collectorFile, `${validPrefix}{"schemaVersion":1`, 'utf8')
    await expect(controlPlane.collect(registered.token, { events: [] })).rejects.toThrow('partial trailing record')
    await expect(controlPlane.applyRetention(30, owner)).rejects.toThrow('partial trailing record')
    expect(await readFile(collectorFile, 'utf8')).toBe(`${validPrefix}{"schemaVersion":1`)
    expect(await readFile(path.join(dataDir, 'team-control-plane.json'), 'utf8')).toBe(stateBefore)
    expect(await readFile(path.join(dataDir, 'team-audit.jsonl'), 'utf8')).toBe(auditBefore)
    expect(pruneEvents).not.toHaveBeenCalled()
    expect(evaluations.pruneBefore).not.toHaveBeenCalled()

    await writeFile(collectorFile, `${validPrefix}not-json`, 'utf8')
    await expect(controlPlane.collect(registered.token, { events: [] })).rejects.toThrow('collector store is invalid')
    await expect(controlPlane.applyRetention(30, owner)).rejects.toThrow('collector store is invalid')
    expect(await readFile(collectorFile, 'utf8')).toBe(`${validPrefix}not-json`)
    expect(pruneEvents).not.toHaveBeenCalled()
    expect(evaluations.pruneBefore).not.toHaveBeenCalled()

    await writeFile(collectorFile, '{"foo":"bar"}\n', 'utf8')
    await expect(controlPlane.collect(registered.token, { events: [] })).rejects.toThrow('collector store is invalid')
    await expect(controlPlane.applyRetention(30, owner)).rejects.toThrow('collector store is invalid')
    expect(await readFile(collectorFile, 'utf8')).toBe('{"foo":"bar"}\n')
    expect(pruneEvents).not.toHaveBeenCalled()
    expect(evaluations.pruneBefore).not.toHaveBeenCalled()
  })

  it('recovers a prepared Team state and audit transaction before serving reads', async () => {
    const { controlPlane, dataDir } = await fixture()
    const owner = principal('user:owner')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)
    await controlPlane.saveEntity('workspace', { id: 'engineering', name: 'Engineering' }, owner)
    const state = await readFile(path.join(dataDir, 'team-control-plane.json'), 'utf8')
    const audit = await readFile(path.join(dataDir, 'team-audit.jsonl'), 'utf8')
    await writeFile(path.join(dataDir, 'team-control-plane.transaction.json'), `${JSON.stringify({ schemaVersion: 1, state, audit })}\n`)
    await writeFile(path.join(dataDir, 'team-control-plane.json'), '{"interrupted":true}\n')
    await writeFile(path.join(dataDir, 'team-audit.jsonl'), 'interrupted\n')

    const restarted = createTeamControlPlane({ dataDir })
    expect(await restarted.snapshot(owner)).toMatchObject({ revision: 2, workspaces: [{ id: 'engineering' }] })
    expect(await restarted.audit(owner)).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ action: 'team.created' })]), sourceStatus: 'ok' })
    await expect(readFile(path.join(dataDir, 'team-control-plane.transaction.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('derives the Team catalog and approval/release queues from Registry and governance facts', async () => {
    const { controlPlane } = await fixture()
    const owner = principal('user:owner')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)
    await controlPlane.saveEntity('workspace', { id: 'engineering', name: 'Engineering' }, owner)
    await controlPlane.saveEntity('project', { id: 'project-a', workspaceId: 'engineering', name: 'Project A', artifactIds: ['skill:review'] }, owner)

    expect(await controlPlane.catalog(owner)).toMatchObject({
      items: [expect.objectContaining({
        artifactId: 'skill:review',
        lifecycleStatus: 'ready',
        owner: 'owner',
        usedByProjectIds: ['project-a'],
        evidenceHash: 'e'.repeat(64),
      })],
      page: 1,
      pageSize: 50,
      totalItems: 1,
      totalPages: 1,
      revision: 3,
    })
    expect(await controlPlane.queues(owner, 'approval')).toMatchObject({
      items: [{ capabilityId: 'cap-review', artifactId: 'review', owner: 'owner', evidenceHash: 'e'.repeat(64) }],
      totalItems: 1,
      revision: 3,
    })
    expect(await controlPlane.queues(owner, 'release')).toMatchObject({
      items: [],
      totalItems: 0,
      revision: 3,
    })
  })

  it('sorts Team catalog and queue rows before applying bounded pages', async () => {
    const numbered = Array.from({ length: 101 }, (_, index) => String(index + 1).padStart(3, '0'))
    const versions = numbered.toReversed().map((number) => ({
      id: `skill:item-${number}:${number}`,
      kind: 'skill',
      sourceArtifactId: `item-${number}`,
      version: '1.0.0',
      contentHash: number.padStart(64, '0'),
      source: 'github',
      status: 'candidate',
    }))
    const capabilities = [
      ...numbered.toReversed().map((number) => ({
        id: `cap-approval-${number}`,
        stage: 'ready',
        owner: 'owner',
        targetSkeleton: 'project-a',
        artifact: { kind: 'skill', artifactId: `item-${number}`, contentHash: number.padStart(64, '0') },
        evidence: null,
      })),
      ...numbered.toReversed().map((number) => ({
        id: `cap-release-${number}`,
        stage: 'approved',
        owner: 'owner',
        targetSkeleton: 'project-a',
        artifact: { kind: 'skill', artifactId: `release-${number}`, contentHash: number.padStart(64, '0') },
        evidence: null,
      })),
    ]
    const { controlPlane } = await fixture({
      artifactRegistry: { list: async () => ({ versions }) },
      governance: { list: async () => capabilities },
    })
    const owner = principal('user:owner')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)

    await expect(controlPlane.catalog(owner, { page: '2', pageSize: '100' })).resolves.toMatchObject({
      items: [expect.objectContaining({ artifactId: 'skill:item-101' })],
      page: 2,
      pageSize: 100,
      totalItems: 101,
      totalPages: 2,
      hasPrevious: true,
      hasNext: false,
      revision: 1,
    })
    await expect(controlPlane.queues(owner, 'approval', { page: 2, pageSize: 100 })).resolves.toMatchObject({
      items: [expect.objectContaining({ artifactId: 'item-101' })],
      totalItems: 101,
      totalPages: 2,
    })
    await expect(controlPlane.queues(owner, 'release', { page: 2, pageSize: 100 })).resolves.toMatchObject({
      items: [expect.objectContaining({ artifactId: 'release-101' })],
      totalItems: 101,
      totalPages: 2,
    })
    const exported = await controlPlane.exportTeam(owner)
    expect(exported.catalog).toHaveLength(101)
    expect(exported.queues.approvalInbox).toHaveLength(101)
    expect(exported.queues.releaseQueue).toHaveLength(101)
    await expect(controlPlane.catalog(owner, { pageSize: 25 })).rejects.toThrow('pageSize must be 20, 50, or 100')
    await expect(controlPlane.catalog(owner, { pageSize: 101 })).rejects.toThrow('pageSize must be between 1 and 100')
    await expect(controlPlane.audit(owner, { page: 1_000_001 })).rejects.toThrow('page must be between 1 and 1000000')
    await expect(controlPlane.queues(owner, 'unknown')).rejects.toThrow('approval or release')
  })

  it('requires independent review for policy exceptions and records a verifiable metadata-only audit chain', async () => {
    const { controlPlane, dataDir } = await fixture()
    const owner = principal('user:owner')
    const reviewer = principal('user:reviewer')
    const developer = principal('user:developer')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)
    await controlPlane.saveEntity('member', { id: reviewer.id, role: 'Reviewer' }, owner)
    await controlPlane.saveEntity('member', { id: developer.id, role: 'Developer' }, owner)
    await controlPlane.saveEntity('workspace', { id: 'engineering', name: 'Engineering' }, owner)
    await controlPlane.saveEntity('project', { id: 'project-a', workspaceId: 'engineering', name: 'Project A' }, owner)
    const gatePolicy = { ...DEFAULT_GATE_POLICY, id: 'secure-defaults' }
    const policyPack = {
      id: gatePolicy.id,
      version: '1.0.0',
      sourceRef: 'git:abc123:policy.json',
      contentHash: gatePolicyHash(gatePolicy),
      gatePolicy,
    }
    await expect(controlPlane.saveEntity('policyPack', { ...policyPack, contentHash: 'b'.repeat(64) }, owner)).rejects.toThrow('does not match')
    await controlPlane.saveEntity('policyPack', policyPack, owner)

    const stateFile = path.join(dataDir, 'team-control-plane.json')
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    const legacyPolicy = { ...gatePolicy }
    delete legacyPolicy.minSuiteCaseCoveragePct
    state.policyPacks[0].gatePolicy = legacyPolicy
    state.policyPacks[0].contentHash = createHash('sha256').update(canonicalJson(legacyPolicy), 'utf8').digest('hex')
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await expect(controlPlane.resolveGatePolicy({ policyId: gatePolicy.id })).resolves.toMatchObject({
      policy: { id: gatePolicy.id, minSuiteCaseCoveragePct: 100 },
    })

    const exception = await controlPlane.requestException({ projectId: 'project-a', policyId: 'secure-defaults', reason: 'Temporary runtime compatibility' }, developer)
    await expect(controlPlane.reviewException(exception.id, 'approved', developer)).rejects.toThrow('Reviewer')
    await expect(controlPlane.reviewException(exception.id, 'approved', reviewer)).resolves.toMatchObject({ status: 'approved', reviewedBy: reviewer.id })

    const audit = (await controlPlane.audit(owner)).items
    expect(audit.at(-1)).toMatchObject({ action: 'exception.reviewed', actorId: reviewer.id, subjectId: exception.id })
    expect(audit.every((record, index) => record.sequence === index + 1 && record.previousHash === (audit[index - 1]?.hash || null))).toBe(true)
    const rawAudit = await readFile(path.join(dataDir, 'team-audit.jsonl'), 'utf8')
    expect(rawAudit).not.toContain('Temporary runtime compatibility')
    expect(rawAudit).not.toContain('git:abc123')
  })

  it('restores sanitized backups and enforces retention across Team, event, and evaluation stores', async () => {
    let retentionDataDir
    const evaluations = {
      pruneBefore: vi.fn(async () => ({
        removedRuns: 2,
        removedRecords: 3,
        retainedRuns: 4,
        removedBackups: 0,
        backupFile: 'evaluations.jsonl.backup-current',
        expiredBackupFiles: [path.join(retentionDataDir, 'evaluations.jsonl.backup-expired')],
      })),
    }
    const { controlPlane, dataDir, advance } = await fixture({ evaluations })
    retentionDataDir = dataDir
    const owner = principal('user:owner')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)
    const maintainer = principal('user:maintainer')
    await controlPlane.saveEntity('member', { id: maintainer.id, role: 'Maintainer' }, owner)
    await expect(controlPlane.exportTeam(maintainer)).rejects.toThrow('Owner')
    await expect(controlPlane.backup(maintainer)).rejects.toThrow('Owner')
    const registered = await controlPlane.registerDevice({ id: 'laptop', name: 'Laptop' }, owner)
    await controlPlane.collect(registered.token, { events: [{ event: 'session.started', runtime: 'codex' }] })
    advance(2)

    const backup = await controlPlane.backup(owner)
    const backupPath = path.join(dataDir, 'backups', backup.file)
    const backupBody = await readFile(backupPath, 'utf8')
    expect(backupBody).not.toContain('tokenHash')
    expect(backupBody).not.toContain(registered.token)
    expect(JSON.parse(backupBody)).toEqual(expect.objectContaining({
      backupHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      state: expect.objectContaining({ team: expect.objectContaining({ id: 'acme' }) }),
    }))
    await controlPlane.saveEntity('member', { id: 'user:temporary', role: 'Viewer' }, owner)
    await expect(controlPlane.restoreBackup('../outside.json', owner)).rejects.toThrow('invalid')
    const restored = await controlPlane.restoreBackup(backup.file, owner)
    expect(restored.state.members.some((member) => member.id === 'user:temporary')).toBe(false)
    expect(restored.state.devices).toEqual([])

    await writeFile(path.join(dataDir, 'events.jsonl'), [
      JSON.stringify({ id: 'old', event: 'session.started', runtime: 'codex', timestamp: '2026-07-22T00:00:00.000Z' }),
      JSON.stringify({ id: 'current', event: 'session.started', runtime: 'codex', timestamp: '2026-07-24T00:00:00.000Z' }),
      '',
    ].join('\n'), 'utf8')
    await writeFile(path.join(dataDir, 'events.jsonl.backup-expired'), 'expired', 'utf8')
    await utimes(path.join(dataDir, 'events.jsonl.backup-expired'), new Date('2026-07-22T00:00:00.000Z'), new Date('2026-07-22T00:00:00.000Z'))
    await writeFile(path.join(dataDir, 'evaluations.jsonl.backup-expired'), 'expired', 'utf8')
    await utimes(path.join(dataDir, 'evaluations.jsonl.backup-expired'), new Date('2026-07-22T00:00:00.000Z'), new Date('2026-07-22T00:00:00.000Z'))
    await writeFile(path.join(dataDir, 'backups', 'team-backup-expired.json'), JSON.stringify({ exportedAt: '2026-07-20T00:00:00.000Z' }), 'utf8')

    const auditCount = (await controlPlane.audit(owner)).items.length
    await expect(controlPlane.applyRetention(1, principal('user:unknown'))).rejects.toThrow('Owner')
    await expect(controlPlane.applyRetention(1, owner)).resolves.toEqual({
      retentionDays: 1,
      retainedCollectorRecords: 0,
      removedCollectorRecords: 1,
      events: { removed: 1, retained: 1, removedBackups: 1 },
      evaluationEvidence: { removedRuns: 2, retainedRuns: 4, removedBackups: 1, preservedRuns: 4 },
      removedTeamBackups: 1,
    })
    expect(evaluations.pruneBefore).toHaveBeenCalledWith(new Date('2026-07-23T00:00:00.000Z'), {
      preserveRunIds: ['origin-1', 'latest-1', 'quality-1', 'redteam-1'],
      deferBackupCleanup: true,
    })
    expect((await controlPlane.audit(owner)).items.length).toBe(auditCount + 1)
    expect(await readFile(path.join(dataDir, 'team-collector.jsonl'), 'utf8')).toBe('')
    expect(await readFile(path.join(dataDir, 'events.jsonl'), 'utf8')).not.toContain('"id":"old"')
    await expect(readFile(path.join(dataDir, 'events.jsonl.backup-expired'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(dataDir, 'evaluations.jsonl.backup-expired'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(dataDir, 'backups', 'team-backup-expired.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(backupPath, 'utf8')).toBe(backupBody)
  })

  it('restores every pruned data store when a later retention step fails', async () => {
    let dataDir
    let failAfterPrune = false
    let oldEventLine
    const oldEvaluationLine = JSON.stringify({ id: 'old-evaluation' })
    const currentEvaluationLine = JSON.stringify({ id: 'current-evaluation' })
    const evaluations = {
      pruneBefore: vi.fn(async () => {
        const file = path.join(dataDir, 'evaluations.jsonl')
        const backupFile = `${file}.backup-injected`
        await writeFile(backupFile, await readFile(file, 'utf8'), 'utf8')
        await writeFile(file, `${currentEvaluationLine}\n${oldEvaluationLine}\n`, 'utf8')
        const eventFile = path.join(dataDir, 'events.jsonl')
        await writeFile(eventFile, `${await readFile(eventFile, 'utf8')}${oldEventLine}\n`, 'utf8')
        failAfterPrune = true
        return {
          removedRuns: 1,
          retainedRuns: 1,
          removedBackups: 0,
          backupFile,
          recoveryPostimage: `${currentEvaluationLine}\n`,
          expiredBackupFiles: [path.join(dataDir, 'evaluations.jsonl.backup-expired')],
        }
      }),
    }
    const result = await fixture({
      evaluations,
      now: () => {
        if (failAfterPrune) throw new Error('LATE_RETENTION_FAILURE')
        return new Date('2026-07-24T00:00:00.000Z')
      },
    })
    dataDir = result.dataDir
    const { controlPlane } = result
    const owner = principal('user:owner')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)
    const eventFile = path.join(dataDir, 'events.jsonl')
    oldEventLine = JSON.stringify({ id: 'old', event: 'session.started', runtime: 'codex', timestamp: '2026-07-20T00:00:00.000Z' })
    const eventBefore = [
      oldEventLine,
      JSON.stringify({ id: 'current', event: 'session.started', runtime: 'codex', timestamp: '2026-07-24T00:00:00.000Z' }),
      '',
    ].join('\n')
    const evaluationFile = path.join(dataDir, 'evaluations.jsonl')
    const evaluationBefore = `${oldEvaluationLine}\n${currentEvaluationLine}\n`
    await writeFile(eventFile, eventBefore, 'utf8')
    await writeFile(evaluationFile, evaluationBefore, 'utf8')
    const eventExpiredBackup = path.join(dataDir, 'events.jsonl.backup-expired')
    const evaluationExpiredBackup = path.join(dataDir, 'evaluations.jsonl.backup-expired')
    await writeFile(eventExpiredBackup, 'event backup', 'utf8')
    await writeFile(evaluationExpiredBackup, 'evaluation backup', 'utf8')
    const expiredAt = new Date('2026-07-20T00:00:00.000Z')
    await utimes(eventExpiredBackup, expiredAt, expiredAt)
    await utimes(evaluationExpiredBackup, expiredAt, expiredAt)

    await expect(controlPlane.applyRetention(1, owner)).rejects.toThrow('LATE_RETENTION_FAILURE')

    expect(await readFile(eventFile, 'utf8')).toBe(`${eventBefore}${oldEventLine}\n`)
    expect(await readFile(evaluationFile, 'utf8')).toBe(`${evaluationBefore}${oldEvaluationLine}\n`)
    expect(await readFile(eventExpiredBackup, 'utf8')).toBe('event backup')
    expect(await readFile(evaluationExpiredBackup, 'utf8')).toBe('evaluation backup')
    expect(JSON.parse(await readFile(path.join(dataDir, 'discovery-index.json'), 'utf8'))).toEqual([])
    expect((await controlPlane.snapshot(owner)).retentionDays).toBe(90)
  })

  it('does not commit Team retention when the event index fails after replacement', async () => {
    const evaluations = {
      pruneBefore: vi.fn(async () => ({ removedRuns: 0, retainedRuns: 0, removedBackups: 0 })),
    }
    const { controlPlane, dataDir } = await fixture({ evaluations })
    const owner = principal('user:owner')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)
    const eventFile = path.join(dataDir, 'events.jsonl')
    const before = [
      JSON.stringify({ id: 'old', event: 'session.started', runtime: 'codex', timestamp: '2026-07-20T00:00:00.000Z' }),
      JSON.stringify({ id: 'current', event: 'session.started', runtime: 'codex', timestamp: '2026-07-24T00:00:00.000Z' }),
      '',
    ].join('\n')
    await writeFile(eventFile, before, 'utf8')
    await mkdir(path.join(dataDir, 'discovery-index.json'))

    await expect(controlPlane.applyRetention(1, owner)).rejects.toThrow()

    expect(await readFile(eventFile, 'utf8')).toBe(before)
    expect((await controlPlane.snapshot(owner)).retentionDays).toBe(90)
    const recoveryBackups = (await readdir(dataDir)).filter((name) => name.startsWith('events.jsonl.backup-'))
    expect(recoveryBackups).toHaveLength(1)
    expect(await readFile(path.join(dataDir, recoveryBackups[0]), 'utf8')).toBe(before)
    expect(evaluations.pruneBefore).not.toHaveBeenCalled()
  })

  it('uses a thrown store recovery journal before reporting retention failure', async () => {
    let dataDir
    const oldLine = JSON.stringify({ id: 'old', event: 'session.started', runtime: 'codex', timestamp: '2026-07-20T00:00:00.000Z' })
    const currentLine = JSON.stringify({ id: 'current', event: 'session.started', runtime: 'codex', timestamp: '2026-07-24T00:00:00.000Z' })
    const before = `${oldLine}\n${currentLine}\n`
    const pruneEvents = vi.fn(async () => {
      const file = path.join(dataDir, 'events.jsonl')
      const backupFile = `${file}.backup-recovery-journal`
      const postimage = `${currentLine}\n`
      await writeFile(backupFile, before, 'utf8')
      await writeFile(file, `${postimage}${oldLine}\n`, 'utf8')
      const error = new AggregateError([new Error('INDEX_FAILED'), new Error('STORE_ROLLBACK_FAILED')], 'STORE_RECOVERY_FAILED')
      error.retentionRecovery = { store: 'events', backupFile, recoveryPostimage: postimage }
      throw error
    })
    const evaluations = { pruneBefore: vi.fn() }
    const result = await fixture({ pruneEvents, evaluations })
    dataDir = result.dataDir
    const { controlPlane } = result
    const owner = principal('user:owner')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)
    const file = path.join(dataDir, 'events.jsonl')
    await writeFile(file, before, 'utf8')

    await expect(controlPlane.applyRetention(1, owner)).rejects.toThrow('STORE_RECOVERY_FAILED')

    expect(await readFile(file, 'utf8')).toBe(`${before}${oldLine}\n`)
    expect((await controlPlane.snapshot(owner)).retentionDays).toBe(90)
    expect(evaluations.pruneBefore).not.toHaveBeenCalled()
  })

  it('reports successful retention when post-commit backup cleanup safely lags', async () => {
    let teamBackup
    let evaluationBackup
    const evaluations = {
      pruneBefore: vi.fn(async () => {
        await rm(teamBackup)
        await mkdir(teamBackup)
        await writeFile(path.join(teamBackup, 'still-present'), 'team backup', 'utf8')
        return {
          removedRuns: 0,
          retainedRuns: 0,
          removedBackups: 0,
          expiredBackupFiles: [evaluationBackup],
        }
      }),
    }
    const { controlPlane, dataDir } = await fixture({ evaluations })
    const owner = principal('user:owner')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)
    teamBackup = path.join(dataDir, 'backups', 'team-backup-expired.json')
    evaluationBackup = path.join(dataDir, 'evaluations.jsonl.backup-expired')
    await mkdir(path.dirname(teamBackup), { recursive: true })
    await mkdir(evaluationBackup)
    await writeFile(path.join(evaluationBackup, 'still-present'), 'evaluation backup', 'utf8')
    await writeFile(teamBackup, JSON.stringify({ exportedAt: '2026-07-20T00:00:00.000Z' }), 'utf8')

    await expect(controlPlane.applyRetention(1, owner)).resolves.toMatchObject({
      retentionDays: 1,
      evaluationEvidence: { removedBackups: 0 },
      removedTeamBackups: 0,
    })
    expect((await controlPlane.snapshot(owner)).retentionDays).toBe(1)
    expect(await readFile(path.join(teamBackup, 'still-present'), 'utf8')).toBe('team backup')
    expect(await readFile(path.join(evaluationBackup, 'still-present'), 'utf8')).toBe('evaluation backup')
  })

  it('holds the capability lock until referenced evaluation evidence is pruned', async () => {
    let announcePrune
    let releasePrune
    const pruneStarted = new Promise((resolve) => { announcePrune = resolve })
    const pruneReleased = new Promise((resolve) => { releasePrune = resolve })
    const evaluations = {
      pruneBefore: vi.fn(async () => {
        announcePrune()
        await pruneReleased
        return { removedRuns: 0, retainedRuns: 0, removedBackups: 0 }
      }),
    }
    const { controlPlane, dataDir } = await fixture({ evaluations })
    const owner = principal('user:owner')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)

    const retention = controlPlane.applyRetention(1, owner)
    await pruneStarted
    let mutationSettled = false
    const mutation = createCapabilityRegistry({ dataDir }).replaceAll([]).then(() => { mutationSettled = true })
    await new Promise((resolve) => setImmediate(resolve))
    const mutationWasBlocked = !mutationSettled
    releasePrune()
    await Promise.all([retention, mutation])

    expect(mutationWasBlocked).toBe(true)
  })

  it('holds the capability lock against a separate process while pruning', async () => {
    let announcePrune
    let releasePrune
    const pruneStarted = new Promise((resolve) => { announcePrune = resolve })
    const pruneReleased = new Promise((resolve) => { releasePrune = resolve })
    const evaluations = {
      pruneBefore: vi.fn(async () => {
        announcePrune()
        await pruneReleased
        return { removedRuns: 0, retainedRuns: 0, removedBackups: 0 }
      }),
    }
    const { controlPlane, dataDir } = await fixture({ evaluations })
    const owner = principal('user:owner')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)

    const retention = controlPlane.applyRetention(1, owner)
    await pruneStarted
    const registryModule = new URL('./governance/capability-registry.mjs', import.meta.url).href
    const child = spawn(process.execPath, ['--input-type=module', '-e', [
      `const { createCapabilityRegistry } = await import(${JSON.stringify(registryModule)})`,
      "process.stdout.write('ready\\n')",
      `await createCapabilityRegistry({ dataDir: ${JSON.stringify(dataDir)} }).replaceAll([])`,
      "process.stdout.write('done\\n')",
    ].join(';')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let errors = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { errors += chunk })
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
    for (let attempt = 0; attempt < 100 && !output.includes('ready'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    const completedDuringPrune = output.includes('done') || child.exitCode !== null
    releasePrune()
    const exitCode = await exited
    await retention

    expect(output).toContain('ready')
    expect(completedDuringPrune).toBe(false)
    expect(exitCode, errors).toBe(0)
    expect(output).toContain('done')
  })

  it('waits for the governance release transaction before pruning evaluation evidence', async () => {
    let announcePrune
    let releasePrune
    const pruneStarted = new Promise((resolve) => { announcePrune = resolve })
    const pruneFinished = new Promise((resolve) => { releasePrune = resolve })
    const evaluations = {
      pruneBefore: vi.fn(async () => {
        announcePrune()
        await pruneFinished
        return { removedRuns: 0, retainedRuns: 0, removedBackups: 0 }
      }),
    }
    const { controlPlane, dataDir } = await fixture({ evaluations })
    const owner = principal('user:owner')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)

    const retention = controlPlane.applyRetention(1, owner)
    await pruneStarted
    let transactionSettled = false
    const overlappingRelease = createSkeletonLock({ dataDir }).transaction(async () => undefined)
      .then(() => { transactionSettled = true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const releaseWasBlocked = !transactionSettled
    releasePrune()
    await Promise.all([overlappingRelease, retention])

    expect(releaseWasBlocked).toBe(true)
  })

  it('uses the raw capability registry for retention snapshots', async () => {
    const registryList = vi.fn(async () => [])
    const publicList = vi.fn(async () => { throw new Error('PUBLIC_GOVERNANCE_LIST_REENTERED') })
    const evaluations = {
      pruneBefore: vi.fn(async () => ({ removedRuns: 0, retainedRuns: 0, removedBackups: 0 })),
    }
    const { controlPlane } = await fixture({
      evaluations,
      governance: { list: publicList, registry: { list: registryList } },
    })
    const owner = principal('user:owner')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)

    await expect(controlPlane.applyRetention(1, owner)).resolves.toMatchObject({
      evaluationEvidence: { preservedRuns: 0 },
    })
    expect(registryList).toHaveBeenCalledOnce()
    expect(publicList).not.toHaveBeenCalled()
  })
})
