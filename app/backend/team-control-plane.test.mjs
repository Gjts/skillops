// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTeamControlPlane } from './team-control-plane.mjs'
import { DEFAULT_GATE_POLICY, gatePolicyHash } from './governance/capability-policy.mjs'

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
    latestEvidenceRunId: 'quality-1',
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
    expect(await restarted.audit(owner)).toHaveLength(2)
    await expect(readFile(path.join(dataDir, 'team-control-plane.transaction.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('derives the Team catalog and approval/release queues from Registry and governance facts', async () => {
    const { controlPlane } = await fixture()
    const owner = principal('user:owner')
    await controlPlane.initialize({ id: 'acme', name: 'Acme' }, owner)
    await controlPlane.saveEntity('workspace', { id: 'engineering', name: 'Engineering' }, owner)
    await controlPlane.saveEntity('project', { id: 'project-a', workspaceId: 'engineering', name: 'Project A', artifactIds: ['skill:review'] }, owner)

    expect(await controlPlane.catalog(owner)).toEqual([
      expect.objectContaining({
        artifactId: 'skill:review',
        lifecycleStatus: 'ready',
        owner: 'owner',
        usedByProjectIds: ['project-a'],
        evidenceHash: 'e'.repeat(64),
      }),
    ])
    expect(await controlPlane.queues(owner)).toEqual({
      approvalInbox: [{ capabilityId: 'cap-review', artifactId: 'review', owner: 'owner', evidenceHash: 'e'.repeat(64) }],
      releaseQueue: [],
    })
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

    const exception = await controlPlane.requestException({ projectId: 'project-a', policyId: 'secure-defaults', reason: 'Temporary runtime compatibility' }, developer)
    await expect(controlPlane.reviewException(exception.id, 'approved', developer)).rejects.toThrow('Reviewer')
    await expect(controlPlane.reviewException(exception.id, 'approved', reviewer)).resolves.toMatchObject({ status: 'approved', reviewedBy: reviewer.id })

    const audit = await controlPlane.audit(owner)
    expect(audit.at(-1)).toMatchObject({ action: 'exception.reviewed', actorId: reviewer.id, subjectId: exception.id })
    expect(audit.every((record, index) => record.sequence === index + 1 && record.previousHash === (audit[index - 1]?.hash || null))).toBe(true)
    const rawAudit = await readFile(path.join(dataDir, 'team-audit.jsonl'), 'utf8')
    expect(rawAudit).not.toContain('Temporary runtime compatibility')
    expect(rawAudit).not.toContain('git:abc123')
  })

  it('restores sanitized backups and enforces retention across Team, event, and evaluation stores', async () => {
    const evaluations = {
      pruneBefore: vi.fn(async () => ({
        removedRuns: 2,
        removedRecords: 3,
        retainedRuns: 4,
        removedBackups: 1,
        backupFile: 'evaluations.jsonl.backup-current',
      })),
    }
    const { controlPlane, dataDir, advance } = await fixture({ evaluations })
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
    await writeFile(path.join(dataDir, 'backups', 'team-backup-expired.json'), JSON.stringify({ exportedAt: '2026-07-20T00:00:00.000Z' }), 'utf8')

    const auditCount = (await controlPlane.audit(owner)).length
    await expect(controlPlane.applyRetention(1, principal('user:unknown'))).rejects.toThrow('Owner')
    await expect(controlPlane.applyRetention(1, owner)).resolves.toEqual({
      retentionDays: 1,
      retainedCollectorRecords: 0,
      removedCollectorRecords: 1,
      events: { removed: 1, retained: 1, removedBackups: 1 },
      evaluationEvidence: { removedRuns: 2, retainedRuns: 4, removedBackups: 1, preservedRuns: 2 },
      removedTeamBackups: 1,
    })
    expect(evaluations.pruneBefore).toHaveBeenCalledWith(new Date('2026-07-23T00:00:00.000Z'), {
      preserveRunIds: ['quality-1', 'redteam-1'],
    })
    expect((await controlPlane.audit(owner)).length).toBe(auditCount + 1)
    expect(await readFile(path.join(dataDir, 'team-collector.jsonl'), 'utf8')).toBe('')
    expect(await readFile(path.join(dataDir, 'events.jsonl'), 'utf8')).not.toContain('"id":"old"')
    await expect(readFile(path.join(dataDir, 'events.jsonl.backup-expired'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(dataDir, 'backups', 'team-backup-expired.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(backupPath, 'utf8')).toBe(backupBody)
  })
})
