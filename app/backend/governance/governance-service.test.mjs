import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { artifactContentHash } from '../evaluations/artifact-definition.mjs'
import { computeEvaluationEvidenceHash, createEvaluationStore } from '../evaluations/evaluation-store.mjs'
import { DEFAULT_GATE_POLICY, evaluateGatePolicy, gatePolicyHash } from './capability-policy.mjs'
import { createCapabilityRegistry } from './capability-registry.mjs'
import { createGovernanceAuditLog } from './governance-audit.mjs'
import { createGovernanceServices } from './governance-api.mjs'
import { createGovernanceService } from './governance-service.mjs'
import { createSkeletonLock } from './skeleton-lock.mjs'
import { createSkeletonInstaller } from './skeleton-installer.mjs'
import { createTeamControlPlane } from '../team-control-plane.mjs'

const temporaryDirectories = []
const CANARY_PROJECT_ROOT = path.resolve(os.tmpdir(), 'skillops-canary-project')

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const artifact = (version, hash, revision = hash) => ({
  kind: 'skill', artifactId: 'review-skill', version, source: 'github',
  sourceRef: `github:https://github.com/acme/review/blob/${revision.repeat(40)}/SKILL.md#SKILL.md`,
  contentHash: hash.repeat(64), gitCommit: revision.repeat(40),
})

function runSummary(id, candidate, baseline = artifact('0.9.0', '9'), overrides = {}) {
  const { gatePolicy, ...summaryOverrides } = overrides
  const now = '2026-07-21T00:00:00.000Z'
  const summary = {
    id, mode: 'suite', status: 'completed', suiteId: 'quality', suiteVersion: '1.0.0', suiteHash: 'd'.repeat(64), datasetHash: 'e'.repeat(64),
    baseline, candidate, engine: { name: 'promptfoo', version: '0.121.19' }, provider: { id: 'openai', model: 'gpt-test' },
    metrics: {
      baselineScore: 80, candidateScore: 90, scoreDeltaPp: 10, casesPassed: 2, casesTotal: 2, passRatePct: 100,
      regressionRatePct: 0, baselineTokens: null, candidateTokens: null, baselineCostUsd: null, candidateCostUsd: null,
      costDeltaPct: null, baselineP95LatencyMs: 10, candidateP95LatencyMs: 11, latencyDeltaPct: 10,
      attackSuccessRatePct: null, criticalFindings: 0, highFindings: 0,
    },
    evidenceHash: null, gateResult: 'not-evaluated', requestedBy: 'qa', requestedAt: now, startedAt: now, completedAt: now, errorCode: null,
    ...summaryOverrides,
  }
  const gated = evaluateGatePolicy(summary, gatePolicy)
  summary.policyHash = gated.policyHash
  summary.gates = gated.gates
  summary.gateResult = gated.gateResult
  summary.evidenceHash = computeEvaluationEvidenceHash(summary)
  return summary
}

async function setup(policy) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-governance-'))
  temporaryDirectories.push(dataDir)
  const stableProjectRoot = path.join(dataDir, 'stable-project')
  const evaluations = createEvaluationStore({ dataDir })
  const registry = createCapabilityRegistry({ dataDir })
  const skeletonLock = createSkeletonLock({ dataDir })
  const previews = new Map()
  const restorePreviews = []
  let recoveryCounter = 0
  const revertedTokens = []
  async function preview(capability, context = {}) {
    const previewToken = `preview-${capability.id}-${previews.size}`
    previews.set(previewToken, capability.artifact.contentHash)
    return { previewToken, capabilityId: capability.id, target: capability.targetSkeleton, projectRoot: context.projectRoot, conflict: false }
  }
  const installer = {
    targetKey: async (target, projectRoot) => `${projectRoot ? `${projectRoot}:` : ''}${target}`.toLocaleLowerCase('en-US'),
    projectIdentity: async (_target, projectRoot) => {
      const root = projectRoot || stableProjectRoot
      return { projectRoot: root, key: `directory:${root.toLocaleLowerCase('en-US')}` }
    },
    preview,
    previewInstall: preview,
    previewRemoval: preview,
    async previewRestore(capability, recoveryToken, context) {
      restorePreviews.push({ capability, recoveryToken, context })
      return preview(capability)
    },
    async apply(previewToken, { confirm }) {
      if (!confirm || !previews.has(previewToken)) throw new Error('Missing confirmed preview.')
      const contentHash = previews.get(previewToken)
      previews.delete(previewToken)
      recoveryCounter += 1
      return {
        applied: true,
        contentHash,
        rollback: { restored: false },
        recoveryToken: `00000000-0000-4000-8000-${String(recoveryCounter).padStart(12, '0')}`,
      }
    },
    async verify(capability, targetSkeleton, projectRoot) {
      return { target: targetSkeleton, projectRoot, contentHash: capability.artifact.contentHash, observedAt: new Date().toISOString() }
    },
    async revert(token) { revertedTokens.push(token); return { restored: true } },
    async commitRecovery() {},
  }
  return { dataDir, stableProjectRoot, evaluations, registry, skeletonLock, installer, restorePreviews, revertedTokens, service: createGovernanceService({ evaluations, registry, skeletonLock, installer, policy }) }
}

async function promote(service, capabilityId) {
  const preview = await service.previewPromotion(capabilityId)
  return service.promote(capabilityId, { previewToken: preview.previewToken, confirm: true, actor: 'Operator' })
}

async function rollback(service, capabilityId) {
  const preview = await service.previewRollback(capabilityId)
  return service.rollback(capabilityId, { previewToken: preview.previewToken, confirm: true, actor: 'Operator' })
}
async function startCanary(service, capabilityId, actor = 'Operator', targetSkeleton = `canary:${capabilityId}`, projectRoot = CANARY_PROJECT_ROOT) {
  const preview = await service.previewCanary(capabilityId, { targetSkeleton, projectRoot })
  return service.canary(capabilityId, { previewToken: preview.previewToken, targetSkeleton, projectRoot, confirm: true, actor })
}


async function ready(service, evaluations, candidate, suffix = '1', baseline, nomination = {}) {
  const nominated = await service.nominate({ artifact: candidate, owner: 'Artifact Owner', targetSkeleton: 'codex:project-review', ...nomination })
  const quality = runSummary(`quality-${suffix}`, candidate, baseline)
  await evaluations.appendRun(quality)
  return { capability: await service.bindEvidence(nominated.capability.id, { runId: quality.id, actor: 'Operator' }), quality }
}

describe('capability governance', () => {
  it('stores metadata only, nominates idempotently, and creates a new candidate for a changed hash', async () => {
    const { dataDir, service } = await setup()
    const first = await service.nominate({ artifact: artifact('1.0.0', 'a'), owner: 'Owner', targetSkeleton: 'codex:review' })
    const sameTargetReplay = await service.nominate({ artifact: artifact('1.0.0', 'a'), owner: 'Another owner', targetSkeleton: 'codex:review' })
    const replay = await service.nominate({ artifact: artifact('1.0.0', 'a'), owner: 'Another owner', targetSkeleton: 'codex:other' })
    const changed = await service.nominate({ artifact: artifact('1.0.0', 'b'), owner: 'Owner', targetSkeleton: 'codex:review' })
    const moved = await service.nominate({ artifact: artifact('1.0.0', 'a', 'c'), owner: 'Owner', targetSkeleton: 'codex:review' })
    expect(sameTargetReplay).toEqual(expect.objectContaining({ reused: true, capability: expect.objectContaining({ id: first.capability.id }) }))
    expect(replay).toEqual(expect.objectContaining({ reused: false }))
    expect(replay.capability.id).not.toBe(first.capability.id)
    expect(changed.capability.id).not.toBe(first.capability.id)
    expect(moved.capability.id).not.toBe(first.capability.id)
    await expect(service.nominate({
      artifact: artifact('2.0.0', 'd'),
      owner: 'Owner',
      targetSkeleton: 'skills/./review/SKILL.md',
    })).rejects.toThrow('canonical')
    await expect(service.nominate({
      artifact: { ...artifact('1.0.0', 'a'), sourceRef: 'github:https://github.com/acme/review/tree/main/SKILL.md', gitCommit: undefined },
      owner: 'Owner',
      targetSkeleton: 'codex:review',
    })).rejects.toThrow('immutable Git commit')
    await expect(service.nominate({
      artifact: {
        ...artifact('1.0.0', 'a'),
        kind: 'prompt',
        source: 'prompthub',
        sourceRef: `prompthub:v1:4948:ed651609:${'a'.repeat(64)}`,
        gitCommit: undefined,
      },
      owner: 'Owner',
      targetSkeleton: 'prompt:review',
    })).rejects.toThrow('imported into Git')
    await expect(service.nominate({
      artifact: artifact('2.0.0', 'c'),
      owner: 'Owner',
      targetSkeleton: 'codex:review',
      policyId: 'unknown-v1',
    })).rejects.toThrow('policy')
    const contents = await readFile(path.join(dataDir, 'capabilities.json'), 'utf8')
    expect(contents).not.toContain('contents')
    expect(contents).not.toContain('prompt')
  })

  it.each(['evaluation-suite', 'policy-pack'])('governs %s with shared evidence, approval, and release stages', async (kind) => {
    const { evaluations, service } = await setup()
    const candidate = {
      ...artifact('1.0.0', kind === 'evaluation-suite' ? 'e' : 'f'),
      kind,
      artifactId: `${kind}-quality`,
    }
    const result = await ready(service, evaluations, candidate, kind)
    await service.approve(result.capability.id, { reviewer: 'Independent Reviewer' })
    await startCanary(service, result.capability.id, 'Operator', `canary:${kind}`)
    await expect(promote(service, result.capability.id)).resolves.toEqual(expect.objectContaining({
      capability: expect.objectContaining({ stage: 'stable', artifact: expect.objectContaining({ kind }) }),
    }))
  })

  it('retracts only an unevaluated Candidate as an audited import compensation', async () => {
    const { service } = await setup()
    const nominated = await service.nominate({ artifact: artifact('1.0.0', 'a'), owner: 'Owner', targetSkeleton: 'codex:review' })

    expect(await service.retractCandidate(nominated.capability.id, { actor: 'Operator' })).toEqual(expect.objectContaining({ stage: 'deprecated' }))
    expect((await service.listAudit({ capabilityId: nominated.capability.id }))[0]).toEqual(expect.objectContaining({
      action: 'candidate.retracted',
      actor: 'Operator',
      fromStage: 'candidate',
      toStage: 'deprecated',
      outcome: 'committed',
    }))
    await expect(service.retractCandidate(nominated.capability.id, { actor: 'Operator' })).rejects.toThrow('unevaluated Candidate')
  })

  it('rejects Quick/manual/forged evidence and binds only completed Managed Suite evidence', async () => {
    const { evaluations, service } = await setup()
    const candidate = artifact('1.0.0', 'a')
    const nominated = await service.nominate({ artifact: candidate, owner: 'Owner', targetSkeleton: 'codex:review' })
    const quick = runSummary('quick-1', candidate, undefined, { mode: 'quick' })
    await evaluations.appendRun(quick)
    await expect(service.bindEvidence(nominated.capability.id, { runId: quick.id, baselineScore: 100, candidateScore: 100, actor: 'Operator' })).rejects.toThrow('Managed Suite')
    const forged = runSummary('forged-1', candidate)
    forged.evidenceHash = 'f'.repeat(64)

    await evaluations.appendRun(forged)
    await expect(service.bindEvidence(nominated.capability.id, { runId: forged.id, actor: 'Operator' })).rejects.toThrow('Managed Suite')
    const trusted = runSummary('trusted-1', candidate)
    await evaluations.appendRun(trusted)
    expect(await service.bindEvidence(nominated.capability.id, { runId: trusted.id, actor: 'Operator' })).toEqual(expect.objectContaining({ stage: 'ready', approvals: [] }))
  })
  it('applies a Team Policy Pack and only waives it after independent exception approval', async () => {
    const setupResult = await setup()
    const owner = { id: 'user:owner', displayName: 'Owner' }
    const developer = { id: 'user:developer', displayName: 'Developer' }
    const reviewer = { id: 'user:reviewer', displayName: 'Reviewer' }
    const strictPolicy = { ...DEFAULT_GATE_POLICY, id: 'strict-v1', minCandidateScore: 95 }
    const team = createTeamControlPlane({ dataDir: setupResult.dataDir })
    await team.initialize({ id: 'acme', name: 'Acme' }, owner)
    await team.saveEntity('member', { id: developer.id, role: 'Developer' }, owner)
    await team.saveEntity('member', { id: reviewer.id, role: 'Reviewer' }, owner)
    await team.saveEntity('workspace', { id: 'engineering', name: 'Engineering' }, owner)
    await team.saveEntity('project', { id: 'project-a', workspaceId: 'engineering', name: 'Project A', projectRoot: setupResult.stableProjectRoot }, owner)
    await team.saveEntity('policyPack', {
      id: strictPolicy.id,
      version: '1.0.0',
      sourceRef: 'git:abc123:strict-policy.json',
      contentHash: gatePolicyHash(strictPolicy),
      gatePolicy: strictPolicy,
    }, owner)
    const { governance: service } = await createGovernanceServices({
      evaluations: setupResult.evaluations,
      registry: setupResult.registry,
      skeletonLock: setupResult.skeletonLock,
      installer: setupResult.installer,
      teamControlPlane: team,
    })
    const candidate = artifact('1.0.0', 'a')
    const nominated = await service.nominate({
      artifact: candidate,
      owner: 'Artifact Owner',
      targetSkeleton: 'codex:review',
      projectId: 'project-a',
      policyId: strictPolicy.id,
    })
    const quality = runSummary('team-policy-quality', candidate)
    await setupResult.evaluations.appendRun(quality)

    expect(await service.bindEvidence(nominated.capability.id, { runId: quality.id, actor: 'Operator' })).toEqual(expect.objectContaining({
      projectId: 'project-a',
      policyId: strictPolicy.id,
      stage: 'blocked',
      evidence: expect.objectContaining({ policyHash: gatePolicyHash(strictPolicy) }),
    }))

    const exception = await team.requestException({
      projectId: 'project-a',
      policyId: strictPolicy.id,
      reason: 'Temporary compatibility waiver',
    }, developer)
    expect((await service.get(nominated.capability.id)).evidenceStale).toBe(false)
    await team.reviewException(exception.id, 'approved', reviewer)
    expect((await service.get(nominated.capability.id)).evidenceStale).toBe(true)
    expect(await service.bindEvidence(nominated.capability.id, { runId: quality.id, actor: 'Operator' })).toEqual(expect.objectContaining({
      stage: 'ready',
      evidence: expect.objectContaining({ policyHash: gatePolicyHash(DEFAULT_GATE_POLICY) }),
    }))
  })
  it('binds Team releases to the registered project root through Stable apply and locking', async () => {
    const setupResult = await setup()
    const projectRoot = path.join(setupResult.dataDir, 'registered-project')
    let registeredProjectRoot = projectRoot
    const applyContexts = []
    const apply = setupResult.installer.apply
    setupResult.installer.apply = async (token, context) => {
      applyContexts.push(context)
      return apply(token, context)
    }
    const service = createGovernanceService({
      evaluations: setupResult.evaluations,
      registry: setupResult.registry,
      skeletonLock: setupResult.skeletonLock,
      installer: setupResult.installer,
      resolveProjectRoot: async (projectId) => {
        if (projectId !== 'project-a') throw new Error('Project was not found.')
        return registeredProjectRoot
      },
    })
    const { capability } = await ready(service, setupResult.evaluations, artifact('1.0.0', 'a'), 'team', undefined, { projectId: 'project-a' })
    expect(capability.projectId).toBe('project-a')
    expect(capability.projectRoot).toBe(projectRoot)
    expect(capability.targetKey).toBe(`${projectRoot}:codex:project-review`.toLocaleLowerCase('en-US'))
    registeredProjectRoot = path.join(setupResult.dataDir, 'moved-project')
    await expect(service.approve(capability.id, { reviewer: 'Reviewer' })).rejects.toThrow('registered Team Project')
    registeredProjectRoot = projectRoot
    await service.approve(capability.id, { reviewer: 'Reviewer' })
    await startCanary(service, capability.id)
    const preview = await service.previewPromotion(capability.id)
    expect(preview.projectRoot).toBe(projectRoot)
    await service.promote(capability.id, { previewToken: preview.previewToken, confirm: true, actor: 'Operator' })
    expect(applyContexts.at(-1).projectRoot).toBe(projectRoot)
    expect((await service.lockState()).targets[capability.targetKey].stable.capabilityId).toBe(capability.id)
  })

  it('reuses the canonical target when a physical target alias already has a Stable owner', async () => {
    const { evaluations, service } = await setup()
    const firstArtifact = artifact('1.0.0', 'a')
    const first = await service.nominate({ artifact: firstArtifact, owner: 'Owner', targetSkeleton: 'Skills/Review/SKILL.md' })
    const firstRun = runSummary('target-alias-first', firstArtifact)
    await evaluations.appendRun(firstRun)
    await service.bindEvidence(first.capability.id, { runId: firstRun.id, actor: 'Operator' })
    await service.approve(first.capability.id, { reviewer: 'Reviewer' })
    await startCanary(service, first.capability.id, 'Operator')
    await promote(service, first.capability.id)

    const second = await service.nominate({
      artifact: artifact('2.0.0', 'b'),
      owner: 'Owner',
      targetSkeleton: 'skills/review/skill.md',
    })
    expect(second.capability).toEqual(expect.objectContaining({
      targetSkeleton: 'Skills/Review/SKILL.md',
      baseline: firstArtifact,
    }))
  })


  it('does not let an unrelated drifted Stable target block nomination', async () => {
    const setupResult = await setup()
    const { capability } = await ready(setupResult.service, setupResult.evaluations, artifact('1.0.0', 'a'))
    await setupResult.service.approve(capability.id, { reviewer: 'Reviewer' })
    await startCanary(setupResult.service, capability.id, 'Operator')
    await promote(setupResult.service, capability.id)
    setupResult.installer.targetKey = async (target) => {
      if (target === capability.targetSkeleton) throw new Error('drifted unrelated target')
      return target
    }

    await expect(setupResult.service.nominate({
      artifact: artifact('2.0.0', 'b'),
      owner: 'Owner',
      targetSkeleton: 'codex:other',
    })).resolves.toEqual(expect.objectContaining({ capability: expect.objectContaining({ targetSkeleton: 'codex:other' }) }))
  })

  it('requires fresh independent approval and enforces Approved → Canary → Stable', async () => {
    const { evaluations, installer, service, stableProjectRoot } = await setup()
    const { capability } = await ready(service, evaluations, artifact('1.0.0', 'a'))
    await expect(service.canary(capability.id)).rejects.toThrow('approved')
    await expect(service.approve(capability.id, { reviewer: '  ARTIFACT   owner ' })).rejects.toThrow('own candidate')
    const approved = await service.approve(capability.id, { reviewer: 'Local Reviewer' })
    expect(approved).toEqual(expect.objectContaining({ stage: 'approved', reviewerIdentityAssurance: 'server-resolved' }))
    expect(approved.approvals[0].evidenceHash).toBe(approved.evidence.evidenceHash)
    expect(approved.ownerIdentityAssurance).toBe('server-resolved')
    expect(approved.approvals[0].identityAssurance).toBe('server-resolved')
    await expect(service.previewCanary(capability.id, { targetSkeleton: capability.targetSkeleton, projectRoot: stableProjectRoot })).rejects.toThrow('separate')
    const canaryPreview = await service.previewCanary(capability.id, { targetSkeleton: 'canary/review/SKILL.md', projectRoot: CANARY_PROJECT_ROOT })
    const canary = await service.canary(capability.id, {
      previewToken: canaryPreview.previewToken,
      targetSkeleton: 'canary/review/SKILL.md',
      projectRoot: CANARY_PROJECT_ROOT,
      confirm: true,
      actor: 'Operator',
    })
    expect(canary.capability.stage).toBe('canary')
    expect((await service.lockState()).targets['codex:project-review'].canary).toEqual(expect.objectContaining({
      targetSkeleton: 'canary/review/SKILL.md',
      observedContentHash: capability.artifact.contentHash,
    }))
    installer.verify = async () => { throw new Error('Canary deployment drifted.') }
    await expect(service.previewPromotion(capability.id)).rejects.toThrow('drifted')
    installer.verify = async (current, targetSkeleton, projectRoot) => ({
      target: targetSkeleton,
      projectRoot,
      contentHash: current.artifact.contentHash,
      observedAt: new Date().toISOString(),
    })
    await expect(service.promote(capability.id, { confirm: true, actor: 'Operator' })).rejects.toThrow('preview')
    expect((await promote(service, capability.id)).capability.stage).toBe('stable')
    await expect(service.bindEvidence(capability.id, { runId: capability.latestEvidenceRunId, actor: 'Operator' })).rejects.toThrow('cannot be rebound')
    expect((await service.lockState()).targets['codex:project-review'].stable.capabilityId).toBe(capability.id)
    const audit = await service.listAudit({ capabilityId: capability.id })
    expect(audit.filter((entry) => entry.outcome === 'committed').map((entry) => entry.action)).toEqual([
      'stable.promoted', 'canary.started', 'approval.decided', 'evidence.bound', 'candidate.nominated',
    ])
    expect(audit[0]).toEqual(expect.objectContaining({

      actor: 'Operator',
      artifact: expect.objectContaining({ version: '1.0.0', contentHash: 'a'.repeat(64) }),
      evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      fromStage: 'canary',
      toStage: 'stable',
      at: expect.any(String),
    }))
  })
  it('blocks Stable preview when the verified Canary deployment drifts', async () => {
    const { evaluations, installer, service } = await setup()
    const { capability } = await ready(service, evaluations, artifact('1.0.0', 'a'))
    await service.approve(capability.id, { reviewer: 'Reviewer' })
    await startCanary(service, capability.id)
    installer.verify = async (_capability, target, projectRoot) => ({
      target,
      projectRoot,
      contentHash: 'f'.repeat(64),
      observedAt: new Date().toISOString(),
    })
    await expect(service.previewPromotion(capability.id)).rejects.toThrow('changed after verification')
  })


  it('serializes approval across service instances', async () => {
    const setupResult = await setup()
    const { capability } = await ready(setupResult.service, setupResult.evaluations, artifact('1.0.0', 'a'))
    const peer = createGovernanceService({
      evaluations: setupResult.evaluations,
      registry: createCapabilityRegistry({ dataDir: setupResult.dataDir }),
      skeletonLock: createSkeletonLock({ dataDir: setupResult.dataDir }),
      installer: setupResult.installer,
      audit: createGovernanceAuditLog({ dataDir: setupResult.dataDir }),
    })
    await peer.initialize()
    const outcomes = await Promise.allSettled([
      setupResult.service.approve(capability.id, { reviewer: 'Reviewer One' }),
      peer.approve(capability.id, { reviewer: 'Reviewer Two' }),
    ])
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1)
    expect((await setupResult.service.get(capability.id)).approvals).toHaveLength(1)
  })

  it('finishes a release after restart when the lock committed before the registry', async () => {
    const setupResult = await setup()
    const { evaluations, registry, skeletonLock, installer, service } = setupResult
    const { capability } = await ready(service, evaluations, artifact('1.0.0', 'a'))
    await service.approve(capability.id, { reviewer: 'Local Reviewer' })
    await startCanary(service, capability.id, 'Operator')
    const canary = await registry.get(capability.id)
    await service.audit.prepare({
      action: 'stable.promoted',
      actor: 'Operator',
      capability: { ...canary, stage: 'stable' },
      fromStage: 'canary',
      toStage: 'stable',
    })
    await skeletonLock.promoteStable(canary.targetSkeleton, canary)

    const restarted = createGovernanceService({
      evaluations,
      registry: createCapabilityRegistry({ dataDir: setupResult.dataDir }),
      skeletonLock: createSkeletonLock({ dataDir: setupResult.dataDir }),
      installer,
      audit: createGovernanceAuditLog({ dataDir: setupResult.dataDir }),
    })
    await restarted.initialize()

    expect(await restarted.get(capability.id)).toEqual(expect.objectContaining({ stage: 'stable' }))
    expect(await restarted.listAudit({ capabilityId: capability.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'stable.promoted', outcome: 'committed' }),
    ]))
  })

  it('downgrades a Canary whose observed deployment lock was lost', async () => {
    const setupResult = await setup()
    const { evaluations, registry, skeletonLock, installer, service } = setupResult
    const first = await ready(service, evaluations, artifact('1.0.0', 'a'))
    await service.approve(first.capability.id, { reviewer: 'Local Reviewer' })
    await startCanary(service, first.capability.id, 'Operator')
    await promote(service, first.capability.id)
    const second = await ready(service, evaluations, artifact('2.0.0', 'b'), '2', artifact('1.0.0', 'a'))
    await service.approve(second.capability.id, { reviewer: 'Local Reviewer' })
    await startCanary(service, second.capability.id, 'Operator')
    const canary = await registry.get(second.capability.id)
    await skeletonLock.clearCanary(canary.targetSkeleton, canary)

    const restarted = createGovernanceService({
      evaluations,
      registry: createCapabilityRegistry({ dataDir: setupResult.dataDir }),
      skeletonLock: createSkeletonLock({ dataDir: setupResult.dataDir }),
      installer,
      audit: createGovernanceAuditLog({ dataDir: setupResult.dataDir }),
    })
    await restarted.initialize()

    expect((await restarted.lockState()).targets[canary.targetSkeleton].canary).toBeNull()
    expect((await restarted.get(canary.id)).stage).toBe('approved')
  })

  it('commits a pending local capability audit after restart', async () => {
    const setupResult = await setup()
    const { evaluations, registry, skeletonLock, installer, service } = setupResult
    const nominated = await service.nominate({
      artifact: {
        kind: 'skill',
        artifactId: 'local-review',
        version: '1.0.0',
        source: 'local-scan',
        sourceRef: 'local-scan:codex:local-review',
        contentHash: 'c'.repeat(64),
      },
      owner: 'Local Owner',
      targetSkeleton: 'codex:local-review',
    })
    const prepared = await service.audit.prepare({
      action: 'candidate.nominated',
      actor: 'Local Owner',
      capability: nominated.capability,
      fromStage: null,
      toStage: 'candidate',
    })
    const restarted = createGovernanceService({
      evaluations,
      registry: createCapabilityRegistry({ dataDir: setupResult.dataDir }),
      skeletonLock: createSkeletonLock({ dataDir: setupResult.dataDir }),
      installer,
      audit: createGovernanceAuditLog({ dataDir: setupResult.dataDir }),
    })

    await restarted.initialize()

    expect((await restarted.listAudit({ capabilityId: nominated.capability.id }))
      .find((record) => record.transactionId === prepared.transactionId)?.outcome).toBe('committed')
  })


  it('compensates the file, registry, and lock when audit commit fails', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-governance-audit-failure-'))
    temporaryDirectories.push(dataDir)
    const stableRoot = path.join(dataDir, 'stable-project')
    const canaryRoot = path.join(dataDir, 'canary-project')
    const targetFile = path.join(stableRoot, 'SKILL.md')
    const canaryFile = path.join(canaryRoot, 'SKILL.md')
    await Promise.all([mkdir(stableRoot), mkdir(canaryRoot)])
    const currentContents = '# Stable baseline\r\n'
    const candidateContents = '# Candidate release\n'
    await writeFile(targetFile, currentContents, 'utf8')
    const candidate = { ...artifact('1.0.0', 'a'), contentHash: artifactContentHash(candidateContents) }
    const baseline = {
      ...artifact('0.9.0', '9'),
      source: 'local-scan',
      sourceRef: 'local-scan:codex:review-skill',
      contentHash: artifactContentHash(currentContents),
      gitCommit: undefined,
    }
    const evaluations = createEvaluationStore({ dataDir })
    const registry = createCapabilityRegistry({ dataDir })
    const skeletonLock = createSkeletonLock({ dataDir })
    const installer = createSkeletonInstaller({
      dataDir,
      skeletonRoot: stableRoot,
      artifacts: { resolve: async () => ({ artifact: candidate, contents: candidateContents }) },
      resolveTarget: async (_target, projectRoot) => path.join(projectRoot || stableRoot, 'SKILL.md'),
      scanInstalledSkills: async ({ projectRoot }) => [{ sourcePath: path.join(projectRoot, 'SKILL.md'), kind: 'skill', runtime: 'codex' }],
    })
    const auditLog = createGovernanceAuditLog({ dataDir })
    const audit = {
      prepare: (...args) => auditLog.prepare(...args),
      commit: async (record) => {
        if (record.action === 'stable.promoted') throw new Error('audit commit failed')
        return auditLog.commit(record)
      },
      fail: (...args) => auditLog.fail(...args),
      list: (...args) => auditLog.list(...args),
    }
    const service = createGovernanceService({ dataDir, evaluations, registry, skeletonLock, installer, audit })
    const nominated = await service.nominate({ artifact: candidate, baseline, owner: 'Artifact Owner', targetSkeleton: 'codex:project-review' })
    const quality = runSummary('audit-failure', candidate, baseline)
    await evaluations.appendRun(quality)
    await service.bindEvidence(nominated.capability.id, { runId: quality.id, actor: 'Operator' })
    await service.approve(nominated.capability.id, { reviewer: 'Reviewer One' })
    await startCanary(service, nominated.capability.id, 'Operator', 'SKILL.md', canaryRoot)
    const preview = await service.previewPromotion(nominated.capability.id)
    await expect(service.promote(nominated.capability.id, { previewToken: preview.previewToken, confirm: true, actor: 'Operator' })).rejects.toThrow('audit commit failed')
    expect(await readFile(targetFile, 'utf8')).toBe(currentContents)
    expect(await service.get(nominated.capability.id)).toEqual(expect.objectContaining({ stage: 'canary' }))
    expect((await service.lockState()).targets['codex:project-review']).toEqual(expect.objectContaining({
      stable: null,
      canary: expect.objectContaining({ capabilityId: nominated.capability.id }),
    }))
    expect(await service.listAudit({ capabilityId: nominated.capability.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'stable.promoted', outcome: 'failed' }),
    ]))
  })
  it('retains installer recovery when lock compensation is not durable', async () => {
    const setupResult = await setup()
    const candidate = artifact('1.0.0', 'a')
    const { capability } = await ready(setupResult.service, setupResult.evaluations, candidate)
    await setupResult.service.approve(capability.id, { reviewer: 'Reviewer' })
    await startCanary(setupResult.service, capability.id, 'Operator')
    let reverted = false
    const installer = {
      ...setupResult.installer,
      async revert() {
        reverted = true
        return { restored: true }
      },
    }
    const skeletonLock = {
      ...setupResult.skeletonLock,
      async restoreTarget() { throw new Error('lock restore failed') },
    }
    const auditLog = createGovernanceAuditLog({ dataDir: setupResult.dataDir })
    const audit = {
      prepare: (...args) => auditLog.prepare(...args),
      commit: async (record) => {
        if (record.action === 'stable.promoted') throw new Error('audit commit failed')
        return auditLog.commit(record)
      },
      fail: (...args) => auditLog.fail(...args),
      list: (...args) => auditLog.list(...args),
    }
    const service = createGovernanceService({
      evaluations: setupResult.evaluations,
      registry: setupResult.registry,
      skeletonLock,
      installer,
      audit,
    })
    const preview = await service.previewPromotion(capability.id)
    await expect(service.promote(capability.id, {
      previewToken: preview.previewToken,
      confirm: true,
      actor: 'Operator',
    })).rejects.toThrow('automatic recovery was incomplete')
    expect(reverted).toBe(false)
  })

  it('reverts approval metadata when its audit commit fails', async () => {
    const setupResult = await setup()
    const { capability } = await ready(setupResult.service, setupResult.evaluations, artifact('1.0.0', 'a'))
    const audit = {
      async prepare(record) { return record },
      async commit() { throw new Error('approval audit failed') },
      async fail() {},
      async list() { return [] },
    }
    const failingService = createGovernanceService({
      evaluations: setupResult.evaluations,
      registry: setupResult.registry,
      skeletonLock: setupResult.skeletonLock,
      installer: setupResult.installer,
      audit,
    })

    await expect(failingService.approve(capability.id, { reviewer: 'Reviewer' })).rejects.toThrow('approval audit failed')

    expect(await setupResult.service.get(capability.id)).toEqual(expect.objectContaining({ stage: 'ready', approvals: [] }))
  })
  it('does not approve evidence that changed after reviewer validation', async () => {
    const setupResult = await setup()
    const { capability } = await ready(setupResult.service, setupResult.evaluations, artifact('1.0.0', 'a'))
    const racingRegistry = {
      ...setupResult.registry,
      update(id, updater, beforeCommit) {
        return setupResult.registry.update(id, (current) => updater({
          ...current,
          evidence: { ...current.evidence, evidenceHash: '0'.repeat(64) },
        }), beforeCommit)
      },
    }
    const racingService = createGovernanceService({
      evaluations: setupResult.evaluations,
      registry: racingRegistry,
      skeletonLock: setupResult.skeletonLock,
      installer: setupResult.installer,
    })

    await expect(racingService.approve(capability.id, { reviewer: 'Reviewer' })).rejects.toThrow('changed before approval')
    expect(await setupResult.service.get(capability.id)).toEqual(expect.objectContaining({ stage: 'ready', approvals: [] }))
  })



  it('keeps commitless local candidates out of Canary and Stable', async () => {
    const { evaluations, service } = await setup()
    const candidate = {
      ...artifact('1.0.0', 'a'),
      source: 'local-scan',
      sourceRef: 'local-scan:codex:/repo/.codex/skills/review/SKILL.md',
      gitCommit: undefined,
    }
    const { capability } = await ready(service, evaluations, candidate)
    await service.approve(capability.id, { reviewer: 'Local Reviewer' })
    await expect(service.canary(capability.id)).rejects.toThrow('immutable Git commit')
  })

  it('marks old evidence and approvals stale after a policy change', async () => {
    const setupResult = await setup()
    const { capability } = await ready(setupResult.service, setupResult.evaluations, artifact('1.0.0', 'a'))
    await setupResult.service.approve(capability.id, { reviewer: 'Reviewer' })
    const changedPolicy = { ...DEFAULT_GATE_POLICY, minCandidateScore: 91 }
    const changedService = createGovernanceService({ evaluations: setupResult.evaluations, registry: setupResult.registry, skeletonLock: setupResult.skeletonLock, installer: setupResult.installer, policy: changedPolicy })
    const stale = await changedService.get(capability.id)
    expect(stale.evidenceStale).toBe(true)
    expect(stale.approvals).toEqual([])
    await expect(changedService.canary(capability.id)).rejects.toThrow('stale')
  })
  it('re-evaluates a Canary by clearing its lock and invalidating approval', async () => {
    const { evaluations, revertedTokens, service } = await setup()
    const candidate = artifact('1.0.0', 'a')
    const { capability } = await ready(service, evaluations, candidate)
    await service.approve(capability.id, { reviewer: 'Reviewer' })

    await startCanary(service, capability.id, 'Operator')
    const rerun = runSummary('quality-rerun', candidate)
    await evaluations.appendRun(rerun)

    const rebound = await service.bindEvidence(capability.id, { runId: rerun.id, actor: 'Operator' })

    expect(rebound).toEqual(expect.objectContaining({ stage: 'ready', approvals: [] }))
    expect((await service.lockState()).targets['codex:project-review'].canary).toBeNull()
    expect(revertedTokens).toHaveLength(1)
    await service.approve(capability.id, { reviewer: 'Reviewer Two' })
    expect((await startCanary(service, capability.id, 'Operator')).capability.stage).toBe('canary')
  })
  it('reclaims a legacy Canary under the authenticated owner and clears its lock', async () => {
    const { dataDir, evaluations, registry, skeletonLock, installer, service } = await setup()
    const candidate = artifact('1.0.0', 'a')
    const { capability } = await ready(service, evaluations, candidate)
    await service.approve(capability.id, { reviewer: 'Reviewer' })
    await startCanary(service, capability.id, 'Operator')
    await registry.update(capability.id, (current) => ({
      ...current,
      ownerIdentityAssurance: undefined,
      approvals: current.approvals.map(({ identityAssurance: _identityAssurance, ...approval }) => approval),
    }))
    const legacy = await registry.get(capability.id)
    await skeletonLock.clearCanary(legacy.targetSkeleton, legacy)
    const restarted = createGovernanceService({
      evaluations,
      registry: createCapabilityRegistry({ dataDir }),
      skeletonLock: createSkeletonLock({ dataDir }),
      installer,
      audit: createGovernanceAuditLog({ dataDir }),
    })
    await restarted.initialize()
    expect((await restarted.lockState()).targets[legacy.targetSkeleton].canary).toBeNull()
    expect((await restarted.get(legacy.id)).stage).toBe('ready')

    const reclaimed = await restarted.nominate({
      artifact: candidate,
      owner: 'Authenticated Owner',
      ownerIdentityAssurance: 'configured-bearer-token',
      targetSkeleton: 'codex:project-review',
    })

    expect(reclaimed).toEqual(expect.objectContaining({
      reclaimed: true,
      capability: expect.objectContaining({
        id: capability.id,
        stage: 'candidate',
        owner: 'Authenticated Owner',
        ownerIdentityAssurance: 'configured-bearer-token',
        approvals: [],
      }),
    }))
    expect((await service.lockState()).targets['codex:project-review'].canary).toBeNull()
  })



  it('installs a new Stable target, deprecates it, and restores it through rollback', async () => {
    const setupResult = await setup()
    const { evaluations, service } = setupResult
    const { capability } = await ready(service, evaluations, artifact('1.0.0', 'a'))
    await service.approve(capability.id, { reviewer: 'Reviewer' })
    await startCanary(service, capability.id, 'Operator')

    const installPreview = await service.previewInstallation(capability.id)
    expect((await service.install(capability.id, { previewToken: installPreview.previewToken, confirm: true, actor: 'Operator' })).capability.stage).toBe('stable')
    const changedPolicy = { ...DEFAULT_GATE_POLICY, minCandidateScore: 89 }
    const changedService = createGovernanceService({
      evaluations,
      registry: setupResult.registry,
      skeletonLock: setupResult.skeletonLock,
      installer: setupResult.installer,
      policy: changedPolicy,
    })
    expect((await changedService.get(capability.id)).evidenceStale).toBe(true)
    const removalPreview = await changedService.previewDeprecation(capability.id)
    expect((await changedService.deprecate(capability.id, { previewToken: removalPreview.previewToken, confirm: true, actor: 'Operator' })).capability.stage).toBe('deprecated')
    await expect(changedService.previewRollback(capability.id)).rejects.toThrow('fresh evaluation')
    const freshRun = runSummary('deprecated-requalified', capability.artifact, capability.baseline, { gatePolicy: changedPolicy })
    await evaluations.appendRun(freshRun)
    const requalified = await changedService.bindEvidence(capability.id, { runId: freshRun.id, actor: 'Operator' })
    expect(requalified).toEqual(expect.objectContaining({ stage: 'ready', requalifiesStage: 'deprecated' }))
    await changedService.approve(capability.id, { reviewer: 'Reviewer Two' })
    await expect(changedService.canary(capability.id, { actor: 'Operator' })).rejects.toThrow('requalified')
    const restorePreview = await changedService.previewRollback(capability.id)
    expect((await changedService.rollback(capability.id, {
      previewToken: restorePreview.previewToken,
      confirm: true,
      actor: 'Operator',
    })).capability.stage).toBe('stable')

    expect((await service.listAudit({ capabilityId: capability.id })).slice(0, 5).map((entry) => entry.action)).toEqual([
      'stable.restored', 'approval.decided', 'evidence.bound', 'stable.deprecated', 'stable.installed',
    ])
  })

  it('routes a requalified Deprecated predecessor through the current Stable rollback', async () => {
    const setupResult = await setup()
    const { evaluations, service } = setupResult
    const first = await ready(service, evaluations, artifact('1.0.0', 'a'), '1')
    await service.approve(first.capability.id, { reviewer: 'Reviewer One' })
    await startCanary(service, first.capability.id, 'Operator')
    await promote(service, first.capability.id)
    const removalPreview = await service.previewDeprecation(first.capability.id)
    await service.deprecate(first.capability.id, {
      previewToken: removalPreview.previewToken,
      confirm: true,
      actor: 'Operator',
    })

    const replacement = { ...artifact('2.0.0', 'b'), artifactId: 'replacement-skill' }
    const second = await ready(service, evaluations, replacement, '2', first.capability.artifact)
    await service.approve(second.capability.id, { reviewer: 'Reviewer Two' })
    await startCanary(service, second.capability.id, 'Operator')
    await promote(service, second.capability.id)

    const changedPolicy = { ...DEFAULT_GATE_POLICY, minCandidateScore: 89 }
    const changedService = createGovernanceService({
      evaluations,
      registry: setupResult.registry,
      skeletonLock: setupResult.skeletonLock,
      installer: setupResult.installer,
      policy: changedPolicy,
    })
    const requalificationRun = runSummary('deprecated-predecessor-requalified', first.capability.artifact, second.capability.artifact, {
      gatePolicy: changedPolicy,
    })
    await evaluations.appendRun(requalificationRun)
    await changedService.bindEvidence(first.capability.id, { runId: requalificationRun.id, actor: 'Operator' })
    await changedService.approve(first.capability.id, { reviewer: 'Reviewer Three' })

    const preview = await changedService.previewRollback(first.capability.id)
    expect(setupResult.restorePreviews.at(-1)?.context).toEqual(expect.objectContaining({
      purpose: 'rollback',
      subjectCapabilityId: second.capability.id,
    }))
    const result = await changedService.rollback(first.capability.id, {
      previewToken: preview.previewToken,
      confirm: true,
      actor: 'Operator',
    })
    expect(result).toEqual(expect.objectContaining({
      capability: expect.objectContaining({ id: second.capability.id, stage: 'rolled-back' }),
      restoredCapabilityId: first.capability.id,
    }))
    expect(await changedService.get(first.capability.id)).toEqual(expect.objectContaining({
      stage: 'stable',
      requalifiesStage: null,
    }))
  })

  it('supersedes an old Stable candidate and rolls back only to an immutable previous lock', async () => {
    const setupResult = await setup()
    const { dataDir, evaluations, restorePreviews, service } = setupResult
    const first = await ready(service, evaluations, artifact('1.0.0', 'a'), '1')
    await service.approve(first.capability.id, { reviewer: 'Reviewer One' })
    await startCanary(service, first.capability.id, 'Operator')
    await promote(service, first.capability.id)
    await expect(service.previewRollback(first.capability.id)).rejects.toThrow('No previous immutable')

    const replacement = { ...artifact('2.0.0', 'b'), artifactId: 'replacement-skill' }
    const second = await ready(service, evaluations, replacement, '2', first.capability.artifact)
    await service.approve(second.capability.id, { reviewer: 'Reviewer Two' })
    await startCanary(service, second.capability.id, 'Operator')
    await promote(service, second.capability.id)
    expect((await service.get(first.capability.id)).stage).toBe('superseded')
    const changedPolicy = { ...DEFAULT_GATE_POLICY, minCandidateScore: 89 }
    const stalePolicyService = createGovernanceService({
      evaluations,
      registry: setupResult.registry,
      skeletonLock: setupResult.skeletonLock,
      installer: setupResult.installer,
      policy: changedPolicy,
    })
    const rolledBack = await rollback(stalePolicyService, second.capability.id)
    expect(restorePreviews.at(-1)).toEqual(expect.objectContaining({
      recoveryToken: expect.stringMatching(/^[a-f0-9-]{36}$/),
      context: expect.objectContaining({ purpose: 'rollback', currentHash: replacement.contentHash }),
    }))
    expect(rolledBack.restoredCapabilityId).toBe(first.capability.id)
    expect((await service.get(first.capability.id)).stage).toBe('stable')
    expect((await service.get(second.capability.id)).stage).toBe('rolled-back')
    const lock = JSON.parse(await readFile(path.join(dataDir, 'project-skeleton.lock.json'), 'utf8'))
    expect(lock.targets['codex:project-review'].stable.artifact.contentHash).toBe('a'.repeat(64))
    expect((await service.listAudit({ capabilityId: first.capability.id })).slice(0, 2).map((entry) => entry.action)).toEqual([
      'stable.restored', 'stable.superseded',
    ])
    expect((await service.listAudit({ capabilityId: second.capability.id })).slice(0, 2).map((entry) => entry.action)).toEqual([
      'stable.rolled-back', 'stable.promoted',
    ])
  })

  it('does not erase a nomination that races with a Stable release', async () => {
    const { evaluations, installer, service } = await setup()
    const first = await ready(service, evaluations, artifact('1.0.0', 'a'))
    await service.approve(first.capability.id, { reviewer: 'Reviewer One' })
    await startCanary(service, first.capability.id, 'Operator')
    const preview = await service.previewPromotion(first.capability.id)
    const apply = installer.apply.bind(installer)
    let releaseEntered
    let resumeRelease
    const entered = new Promise((resolve) => { releaseEntered = resolve })
    const gate = new Promise((resolve) => { resumeRelease = resolve })
    installer.apply = async (...args) => {
      releaseEntered()
      await gate
      return apply(...args)
    }
    const promotion = service.promote(first.capability.id, { previewToken: preview.previewToken, confirm: true, actor: 'Operator' })
    await entered
    const nomination = service.nominate({ artifact: artifact('2.0.0', 'b'), owner: 'Another Owner', targetSkeleton: 'codex:project-review' })
    resumeRelease()
    const [promoted, nominated] = await Promise.all([promotion, nomination])
    expect(promoted.capability.stage).toBe('stable')
    expect(nominated.capability).toEqual(expect.objectContaining({
      stage: 'candidate',
      baseline: first.capability.artifact,
    }))
    expect(await service.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.capability.id, stage: 'stable' }),
      expect.objectContaining({ id: nominated.capability.id, stage: 'candidate' }),
    ]))
  })

  it('serializes concurrent lock writes into valid atomic JSON', async () => {
    const { dataDir, skeletonLock } = await setup()
    const capability = {
      id: 'cap-a', artifact: artifact('1.0.0', 'a'), approvals: [{ reviewer: 'Reviewer', decision: 'approved', evidenceHash: 'f'.repeat(64) }],
      evidence: { qualityRunId: 'run-1', evidenceHash: 'f'.repeat(64) },
    }
    await Promise.all(Array.from({ length: 6 }, (_, index) => skeletonLock.setCanary(`target-${index}`, capability, {
      targetSkeleton: `canary-${index}`,
      projectRoot: path.join(dataDir, `canary-project-${index}`),
      observedContentHash: capability.artifact.contentHash,
      observedAt: new Date().toISOString(),
    })))
    await skeletonLock.setCanary('__proto__', capability, {
      targetSkeleton: 'canary-prototype',
      projectRoot: path.join(dataDir, 'canary-project-prototype'),
      observedContentHash: capability.artifact.contentHash,
      observedAt: new Date().toISOString(),
    })
    const lock = JSON.parse(await readFile(path.join(dataDir, 'project-skeleton.lock.json'), 'utf8'))
    expect(Object.keys(lock.targets)).toHaveLength(7)
    expect(Object.hasOwn(lock.targets, '__proto__')).toBe(true)
    expect(Object.prototype.canary).toBeUndefined()
  })
})
