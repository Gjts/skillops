import { createHash } from 'node:crypto'
import { normalizeArtifactDefinition } from '../../shared/evaluation-schema.mjs'
import { canonicalJson } from '../evaluations/suite-registry.mjs'
import { computeEvaluationEvidenceHash } from '../evaluations/evaluation-store.mjs'
import { EvaluationError } from '../evaluations/errors.mjs'
import { DEFAULT_GATE_POLICY, evaluateGatePolicy, gatePolicyHash } from './capability-policy.mjs'
import { createCapabilityRegistry, sanitizeCapability } from './capability-registry.mjs'
import { createSkeletonLock } from './skeleton-lock.mjs'
import { createSkeletonInstaller } from './skeleton-installer.mjs'

function identity(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new EvaluationError(`${label} is required.`, 422)
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (normalized.length > 200) throw new EvaluationError(`${label} is too long.`, 422)
  return normalized
}

function sameIdentity(left, right) {
  return identity(left, 'Identity').toLocaleLowerCase('en-US') === identity(right, 'Identity').toLocaleLowerCase('en-US')
}

function validRunEvidence(run) {
  return run?.status === 'completed'
    && typeof run.evidenceHash === 'string'
    && run.evidenceHash === computeEvaluationEvidenceHash({ ...run, evidenceHash: null })
}

function combinedEvidenceHash(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function assertCandidate(run, capability, label) {
  if (run.candidate.artifactId !== capability.artifact.artifactId
    || run.candidate.version !== capability.artifact.version
    || run.candidate.contentHash !== capability.artifact.contentHash) {
    throw new EvaluationError(`${label} candidate artifact does not match the capability.`, 409)
  }
}

export function createGovernanceService(options = {}) {
  if (!options.evaluations) throw new EvaluationError('Evaluation store is required for governance.', 500)
  const evaluations = options.evaluations
  const registry = options.registry || createCapabilityRegistry(options)
  const skeletonLock = options.skeletonLock || createSkeletonLock(options)
  const installer = options.installer || createSkeletonInstaller(options)
  const policy = options.policy || DEFAULT_GATE_POLICY
  const currentPolicyHash = () => gatePolicyHash(policy)
  let actions = Promise.resolve()

  function serialize(operation) {
    const pending = actions.then(operation)
    actions = pending.catch(() => undefined)
    return pending
  }

  async function evidenceStale(capability) {
    if (!capability.evidence) return false
    if (capability.evidence.policyHash !== currentPolicyHash() || capability.evidence.candidateHash !== capability.artifact.contentHash) return true
    const quality = await evaluations.getRun(capability.evidence.qualityRunId)
    if (!validRunEvidence(quality) || quality.evidenceHash !== capability.evidence.qualityEvidenceHash) return true
    if (capability.evidence.redteamRunId) {
      const redteam = await evaluations.getRun(capability.evidence.redteamRunId)
      if (!validRunEvidence(redteam) || redteam.evidenceHash !== capability.evidence.redteamEvidenceHash) return true
    }
    return combinedEvidenceHash({
      qualityRunId: capability.evidence.qualityRunId,
      redteamRunId: capability.evidence.redteamRunId,
      qualityEvidenceHash: capability.evidence.qualityEvidenceHash,
      redteamEvidenceHash: capability.evidence.redteamEvidenceHash,
      baselineHash: capability.evidence.baselineHash,
      candidateHash: capability.evidence.candidateHash,
      suiteHash: capability.evidence.suiteHash,
      datasetHash: capability.evidence.datasetHash,
      policyHash: capability.evidence.policyHash,
    }) !== capability.evidence.evidenceHash
  }

  async function publicCapability(capability) {
    const stale = await evidenceStale(capability)
    return {
      ...capability,
      evidenceStale: stale,
      approvals: stale ? [] : capability.approvals.filter((item) => item.evidenceHash === capability.evidence?.evidenceHash),
      reviewerIdentityAssurance: 'locally-declared',
    }
  }

  async function requireFresh(capability, stage) {
    if (capability.stage !== stage) throw new EvaluationError(`Capability must be ${stage} before this action.`, 409)
    if (!capability.evidence || await evidenceStale(capability)) throw new EvaluationError('Capability evidence is stale or unavailable.', 409)
  }

  return {
    registry,
    skeletonLock,
    async list() { return Promise.all((await registry.list()).map(publicCapability)) },
    async get(id) {
      const capability = await registry.get(id)
      if (!capability) throw new EvaluationError('Capability was not found.', 404)
      return publicCapability(capability)
    },
    async nominate(input) {
      const result = await registry.nominate({
        artifact: normalizeArtifactDefinition(input?.artifact),
        baseline: input?.baseline ? normalizeArtifactDefinition(input.baseline) : null,
        owner: identity(input?.owner, 'Capability owner'),
        targetSkeleton: identity(input?.targetSkeleton, 'Target skeleton'),
        policyId: input?.policyId || 'default-v1',
      })
      return { ...result, capability: await publicCapability(result.capability) }
    },
    bindEvidence(capabilityId, input) {
      return serialize(async () => {
        const capability = await registry.get(capabilityId)
        if (!capability) throw new EvaluationError('Capability was not found.', 404)
        const quality = await evaluations.getRun(identity(input?.runId, 'Managed Suite run ID'))
        if (!validRunEvidence(quality) || quality.mode !== 'suite' || !quality.suiteHash) {
          throw new EvaluationError('Only completed Managed Suite evidence can be bound.', 409)
        }
        assertCandidate(quality, capability, 'Quality evidence')
        if (capability.baseline && capability.baseline.contentHash !== quality.baseline.contentHash) throw new EvaluationError('Quality evidence baseline hash does not match the capability.', 409)
        if (quality.policyHash !== currentPolicyHash()) throw new EvaluationError('Quality evidence policy is stale.', 409)
        let redteam = null
        if (input?.redteamRunId) {
          redteam = await evaluations.getRun(identity(input.redteamRunId, 'Red Team run ID'))
          if (!validRunEvidence(redteam) || redteam.mode !== 'redteam') throw new EvaluationError('Red Team evidence is invalid.', 409)
          assertCandidate(redteam, capability, 'Red Team evidence')
          if (redteam.policyHash !== currentPolicyHash()) throw new EvaluationError('Red Team evidence policy is stale.', 409)
        }
        const evaluated = evaluateGatePolicy({ ...quality, redteamEvidenceHash: redteam?.evidenceHash || null }, policy)
        const binding = {
          qualityRunId: quality.id,
          redteamRunId: redteam?.id || null,
          baselineHash: quality.baseline.contentHash,
          candidateHash: quality.candidate.contentHash,
          suiteHash: quality.suiteHash,
          datasetHash: quality.datasetHash,
          policyHash: evaluated.policyHash,
          qualityEvidenceHash: quality.evidenceHash,
          redteamEvidenceHash: redteam?.evidenceHash || null,
        }
        const nextEvidence = {
          ...binding,
          evidenceHash: combinedEvidenceHash(binding),
          boundAt: new Date().toISOString(),
        }
        const updated = await registry.update(capabilityId, (current) => ({
          ...current,
          baseline: quality.baseline,
          stage: evaluated.gateResult === 'passed' ? 'ready' : 'blocked',
          latestEvidenceRunId: quality.id,
          evidence: nextEvidence,
          approvals: [],
        }))
        return publicCapability(updated)
      })
    },
    approve(capabilityId, input) {
      return serialize(async () => {
        const capability = await registry.get(capabilityId)
        if (!capability) throw new EvaluationError('Capability was not found.', 404)
        await requireFresh(capability, 'ready')
        const reviewer = identity(input?.reviewer, 'Reviewer')
        if (sameIdentity(reviewer, capability.owner)) throw new EvaluationError('Capability owners cannot approve their own candidate.', 409)
        const decision = input?.decision === undefined ? 'approved' : input.decision
        if (!['approved', 'rejected'].includes(decision)) throw new EvaluationError('Approval decision must be approved or rejected.', 422)
        const note = input?.note === undefined || input.note === null || input.note === '' ? undefined : identity(input.note, 'Approval note')
        const updated = await registry.update(capabilityId, (current) => ({
          ...current,
          stage: decision === 'approved' ? 'approved' : 'blocked',
          approvals: [...current.approvals, { reviewer, decision, note, evidenceHash: current.evidence.evidenceHash, decidedAt: new Date().toISOString() }],
        }))
        return publicCapability(updated)
      })
    },
    canary(capabilityId) {
      return serialize(async () => {
        const capability = await registry.get(capabilityId)
        if (!capability) throw new EvaluationError('Capability was not found.', 404)
        await requireFresh(capability, 'approved')
        if (!capability.approvals.some((item) => item.decision === 'approved' && item.evidenceHash === capability.evidence.evidenceHash)) {
          throw new EvaluationError('A fresh independent approval is required before Canary.', 409)
        }
        await skeletonLock.setCanary(capability.targetSkeleton, capability)
        const updated = await registry.update(capabilityId, (current) => ({ ...current, stage: 'canary' }))
        return publicCapability(updated)
      })
    },
    async previewPromotion(capabilityId, context = {}) {
      const capability = await registry.get(capabilityId)
      if (!capability) throw new EvaluationError('Capability was not found.', 404)
      await requireFresh(capability, 'canary')
      return installer.preview(capability, context)
    },
    promote(capabilityId, input) {
      return serialize(async () => {
        const capability = await registry.get(capabilityId)
        if (!capability) throw new EvaluationError('Capability was not found.', 404)
        await requireFresh(capability, 'canary')
        const applied = await installer.apply(input?.previewToken, { confirm: input?.confirm === true })
        if (!applied.applied) return { capability: await publicCapability(capability), applied, lock: await skeletonLock.read() }
        const lock = await skeletonLock.promoteStable(capability.targetSkeleton, capability)
        await registry.mutateAll((items) => items.map((item) => {
          if (item.id === capability.id) return sanitizeCapability({ ...item, stage: 'stable', updatedAt: new Date().toISOString() })
          if (item.stage === 'stable' && item.targetSkeleton === capability.targetSkeleton && item.artifact.artifactId === capability.artifact.artifactId) {
            return sanitizeCapability({ ...item, stage: 'superseded', updatedAt: new Date().toISOString() })
          }
          return item
        }))
        return { capability: await publicCapability(await registry.get(capabilityId)), applied, lock }
      })
    },
    async previewRollback(capabilityId) {
      const capability = await registry.get(capabilityId)
      if (!capability) throw new EvaluationError('Capability was not found.', 404)
      if (capability.stage !== 'stable') throw new EvaluationError('Only a Stable capability can be rolled back.', 409)
      const lock = await skeletonLock.read()
      const previous = lock.targets[capability.targetSkeleton]?.previous?.[0]
      if (!previous) throw new EvaluationError('No previous immutable Stable version is available for rollback.', 409)
      const restored = await registry.get(previous.capabilityId)
      if (!restored || restored.artifact.contentHash !== previous.artifact.contentHash) throw new EvaluationError('Previous Stable capability metadata is unavailable.', 409)
      return { ...(await installer.preview(restored, { skipReferenceVerification: restored.artifact.source === 'prompt-registry' })), restoredCapabilityId: restored.id }
    },
    rollback(capabilityId, input) {
      return serialize(async () => {
        const capability = await registry.get(capabilityId)
        if (!capability) throw new EvaluationError('Capability was not found.', 404)
        if (capability.stage !== 'stable') throw new EvaluationError('Only a Stable capability can be rolled back.', 409)
        const applied = await installer.apply(input?.previewToken, { confirm: input?.confirm === true })
        if (!applied.applied) return { capability: await publicCapability(capability), applied, lock: await skeletonLock.read() }
        const result = await skeletonLock.rollback(capability.targetSkeleton)
        await registry.mutateAll((items) => items.map((item) => {
          if (item.id === result.rolledBack.capabilityId) return sanitizeCapability({ ...item, stage: 'rolled-back', updatedAt: new Date().toISOString() })
          if (item.id === result.restored.capabilityId) return sanitizeCapability({ ...item, stage: 'stable', updatedAt: new Date().toISOString() })
          return item
        }))
        return { capability: await publicCapability(await registry.get(capabilityId)), applied, lock: result.target, restoredCapabilityId: result.restored.capabilityId }
      })
    },
    async lockState() { return skeletonLock.read() },
  }
}
