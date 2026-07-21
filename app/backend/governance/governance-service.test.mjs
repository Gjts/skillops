import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeEvaluationEvidenceHash, createEvaluationStore } from '../evaluations/evaluation-store.mjs'
import { DEFAULT_GATE_POLICY, evaluateGatePolicy } from './capability-policy.mjs'
import { createCapabilityRegistry } from './capability-registry.mjs'
import { createGovernanceService } from './governance-service.mjs'
import { createSkeletonLock } from './skeleton-lock.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const artifact = (version, hash) => ({
  kind: 'skill', artifactId: 'review-skill', version, source: 'github', sourceRef: `github:review-skill@${version}`, contentHash: hash.repeat(64),
})

function runSummary(id, candidate, baseline = artifact('0.9.0', '9'), overrides = {}) {
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
    ...overrides,
  }
  const gated = evaluateGatePolicy(summary)
  summary.policyHash = gated.policyHash
  summary.gates = gated.gates
  summary.gateResult = gated.gateResult
  summary.evidenceHash = computeEvaluationEvidenceHash(summary)
  return summary
}

async function setup(policy) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-governance-'))
  temporaryDirectories.push(dataDir)
  const evaluations = createEvaluationStore({ dataDir })
  const registry = createCapabilityRegistry({ dataDir })
  const skeletonLock = createSkeletonLock({ dataDir })
  const previews = new Set()
  const installer = {
    async preview(capability) { const previewToken = `preview-${capability.id}`; previews.add(previewToken); return { previewToken, capabilityId: capability.id, conflict: false } },
    async apply(previewToken, { confirm }) {
      if (!confirm || !previews.has(previewToken)) throw new Error('Missing confirmed preview.')
      previews.delete(previewToken)
      return { applied: true, contentHash: 'a'.repeat(64), rollback: { restored: false } }
    },
  }
  return { dataDir, evaluations, registry, skeletonLock, installer, service: createGovernanceService({ evaluations, registry, skeletonLock, installer, policy }) }
}

async function promote(service, capabilityId) {
  const preview = await service.previewPromotion(capabilityId)
  return service.promote(capabilityId, { previewToken: preview.previewToken, confirm: true })
}

async function rollback(service, capabilityId) {
  const preview = await service.previewRollback(capabilityId)
  return service.rollback(capabilityId, { previewToken: preview.previewToken, confirm: true })
}

async function ready(service, evaluations, candidate, suffix = '1') {
  const nominated = await service.nominate({ artifact: candidate, owner: 'Artifact Owner', targetSkeleton: 'codex:project-review' })
  const quality = runSummary(`quality-${suffix}`, candidate)
  await evaluations.appendRun(quality)
  return { capability: await service.bindEvidence(nominated.capability.id, { runId: quality.id }), quality }
}

describe('capability governance', () => {
  it('stores metadata only, nominates idempotently, and creates a new candidate for a changed hash', async () => {
    const { dataDir, service } = await setup()
    const first = await service.nominate({ artifact: artifact('1.0.0', 'a'), owner: 'Owner', targetSkeleton: 'codex:review' })
    const replay = await service.nominate({ artifact: artifact('1.0.0', 'a'), owner: 'Another owner', targetSkeleton: 'codex:other' })
    const changed = await service.nominate({ artifact: artifact('1.0.0', 'b'), owner: 'Owner', targetSkeleton: 'codex:review' })
    expect(replay).toEqual(expect.objectContaining({ reused: true, capability: expect.objectContaining({ id: first.capability.id }) }))
    expect(changed.capability.id).not.toBe(first.capability.id)
    const contents = await readFile(path.join(dataDir, 'capabilities.json'), 'utf8')
    expect(contents).not.toContain('contents')
    expect(contents).not.toContain('prompt')
  })

  it('rejects Quick/manual/forged evidence and binds only completed Managed Suite evidence', async () => {
    const { evaluations, service } = await setup()
    const candidate = artifact('1.0.0', 'a')
    const nominated = await service.nominate({ artifact: candidate, owner: 'Owner', targetSkeleton: 'codex:review' })
    const quick = runSummary('quick-1', candidate, undefined, { mode: 'quick' })
    await evaluations.appendRun(quick)
    await expect(service.bindEvidence(nominated.capability.id, { runId: quick.id, baselineScore: 100, candidateScore: 100 })).rejects.toThrow('Managed Suite')
    const forged = runSummary('forged-1', candidate)
    forged.evidenceHash = 'f'.repeat(64)
    await evaluations.appendRun(forged)
    await expect(service.bindEvidence(nominated.capability.id, { runId: forged.id })).rejects.toThrow('Managed Suite')
    const trusted = runSummary('trusted-1', candidate)
    await evaluations.appendRun(trusted)
    expect(await service.bindEvidence(nominated.capability.id, { runId: trusted.id })).toEqual(expect.objectContaining({ stage: 'ready', approvals: [] }))
  })

  it('requires fresh independent approval and enforces Approved → Canary → Stable', async () => {
    const { evaluations, service } = await setup()
    const { capability } = await ready(service, evaluations, artifact('1.0.0', 'a'))
    await expect(service.canary(capability.id)).rejects.toThrow('approved')
    await expect(service.approve(capability.id, { reviewer: '  ARTIFACT   owner ' })).rejects.toThrow('own candidate')
    const approved = await service.approve(capability.id, { reviewer: 'Local Reviewer', note: 'Looks safe.' })
    expect(approved).toEqual(expect.objectContaining({ stage: 'approved', reviewerIdentityAssurance: 'locally-declared' }))
    expect(approved.approvals[0].evidenceHash).toBe(approved.evidence.evidenceHash)
    expect((await service.canary(capability.id)).stage).toBe('canary')
    await expect(service.promote(capability.id, { confirm: true })).rejects.toThrow('preview')
    expect((await promote(service, capability.id)).capability.stage).toBe('stable')
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

  it('supersedes an old Stable candidate and rolls back only to an immutable previous lock', async () => {
    const { dataDir, evaluations, service } = await setup()
    const first = await ready(service, evaluations, artifact('1.0.0', 'a'), '1')
    await service.approve(first.capability.id, { reviewer: 'Reviewer One' })
    await service.canary(first.capability.id)
    await promote(service, first.capability.id)
    await expect(service.previewRollback(first.capability.id)).rejects.toThrow('No previous immutable')

    const second = await ready(service, evaluations, artifact('2.0.0', 'b'), '2')
    await service.approve(second.capability.id, { reviewer: 'Reviewer Two' })
    await service.canary(second.capability.id)
    await promote(service, second.capability.id)
    expect((await service.get(first.capability.id)).stage).toBe('superseded')
    const rolledBack = await rollback(service, second.capability.id)
    expect(rolledBack.restoredCapabilityId).toBe(first.capability.id)
    expect((await service.get(first.capability.id)).stage).toBe('stable')
    expect((await service.get(second.capability.id)).stage).toBe('rolled-back')
    const lock = JSON.parse(await readFile(path.join(dataDir, 'project-skeleton.lock.json'), 'utf8'))
    expect(lock.targets['codex:project-review'].stable.artifact.contentHash).toBe('a'.repeat(64))
  })

  it('serializes concurrent lock writes into valid atomic JSON', async () => {
    const { dataDir, skeletonLock } = await setup()
    const capability = {
      id: 'cap-a', artifact: artifact('1.0.0', 'a'), approvals: [{ reviewer: 'Reviewer', decision: 'approved', evidenceHash: 'f'.repeat(64) }],
      evidence: { qualityRunId: 'run-1', evidenceHash: 'f'.repeat(64) },
    }
    await Promise.all(Array.from({ length: 6 }, (_, index) => skeletonLock.setCanary(`target-${index}`, capability)))
    const lock = JSON.parse(await readFile(path.join(dataDir, 'project-skeleton.lock.json'), 'utf8'))
    expect(Object.keys(lock.targets)).toHaveLength(6)
  })
})
