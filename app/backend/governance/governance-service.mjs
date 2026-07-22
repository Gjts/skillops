import { createHash } from 'node:crypto'
import path from 'node:path'
import { normalizeArtifactDefinition } from '../../shared/evaluation-schema.mjs'
import { canonicalJson } from '../evaluations/suite-registry.mjs'
import { computeEvaluationEvidenceHash, sanitizePersistedArtifact } from '../evaluations/evaluation-store.mjs'
import { EvaluationError } from '../evaluations/errors.mjs'
import { DEFAULT_GATE_POLICY, evaluateGatePolicy, evaluateRedteamGatePolicy, gatePolicyHash, normalizeGatePolicy } from './capability-policy.mjs'
import { createGovernanceAuditLog } from './governance-audit.mjs'
import { createCapabilityRegistry, sanitizeCapability } from './capability-registry.mjs'
import { createSkeletonLock } from './skeleton-lock.mjs'
import { createSkeletonInstaller } from './skeleton-installer.mjs'

function identity(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new EvaluationError(`${label} is required.`, 422)
  const normalized = value.trim().normalize('NFKC').replace(/\s+/g, ' ')
  if (normalized.length > 200) throw new EvaluationError(`${label} is too long.`, 422)
  return normalized
}
function targetIdentity(value) {
  const target = identity(value, 'Target skeleton')
  if (!/[\\/]/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target)) return target
  const portable = target.replace(/\\/g, '/')
  const canonical = path.posix.normalize(portable)
  if (portable.startsWith('/') || canonical === '..' || canonical.startsWith('../') || canonical !== portable) {
    throw new EvaluationError('Target skeleton path must be canonical.', 422)
  }
  return canonical
}


function sameIdentity(left, right) {
  return identity(left, 'Identity').toLocaleLowerCase('en-US') === identity(right, 'Identity').toLocaleLowerCase('en-US')
}
function identityAssurance(value) {
  const normalized = identity(value ?? 'server-resolved', 'Identity assurance')
  if (normalized.length > 100) throw new EvaluationError('Identity assurance is too long.', 422)
  return normalized
}

function trustedApproval(item, evidenceHash) {
  return item?.decision === 'approved'
    && item.evidenceHash === evidenceHash
    && typeof item.identityAssurance === 'string'
    && item.identityAssurance !== 'unverified-legacy'
}


function validRunEvidence(run) {
  return run?.status === 'completed'
    && typeof run.evidenceHash === 'string'
    && run.evidenceHash === computeEvaluationEvidenceHash({ ...run, evidenceHash: null })
}

function combinedEvidenceHash(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function assertArtifact(actual, expected, label) {
  if (canonicalJson(sanitizePersistedArtifact(actual)) !== canonicalJson(sanitizePersistedArtifact(expected))) {
    throw new EvaluationError(`${label} artifact does not match the exact capability version.`, 409)
  }
}

function assertCandidate(run, capability, label) {
  assertArtifact(run.candidate, capability.artifact, `${label} candidate`)
}

export function createGovernanceService(options = {}) {
  if (!options.evaluations) throw new EvaluationError('Evaluation store is required for governance.', 500)
  const evaluations = options.evaluations
  const registry = options.registry || createCapabilityRegistry(options)
  const skeletonLock = options.skeletonLock || createSkeletonLock(options)
  const installer = options.installer || createSkeletonInstaller(options)
  const policy = normalizeGatePolicy(options.policy || DEFAULT_GATE_POLICY)
  const resolveGatePolicy = options.resolveGatePolicy
  const audit = options.audit || createGovernanceAuditLog({ ...options, dataDir: options.dataDir || registry.dataDir })
  const resolveProjectRoot = options.resolveProjectRoot
  const capabilityTargetKey = (capability) => capability.targetKey || capability.targetSkeleton
  async function policyFor(value = {}) {
    const policyId = value.policyId || policy.id
    if (policyId === policy.id) return policy
    if (typeof resolveGatePolicy !== 'function') throw new EvaluationError(`Gate policy ${policyId} is not available.`, 422)
    const resolved = await resolveGatePolicy({ policyId, projectId: value.projectId || null })
    if (resolved?.waived) {
      if (!resolved.exceptionId || !value.projectId || resolved.projectId !== value.projectId) {
        throw new EvaluationError('Gate policy exception binding is invalid.', 500)
      }
      return policy
    }
    const selected = normalizeGatePolicy(resolved?.policy)
    if (selected.id !== policyId) throw new EvaluationError('Resolved Gate Policy ID does not match the capability.', 500)
    return selected
  }
  async function projectRootFor(projectId) {
    return typeof resolveProjectRoot === 'function' ? resolveProjectRoot(projectId) : null
  }
  let actions = Promise.resolve()

  function serialize(operation) {
    const pending = actions.then(operation)
    actions = pending.catch(() => undefined)
    return pending
  }

  function serializeRelease(operation) {
    return serialize(() => skeletonLock.transaction(operation))
  }

  async function auditedMutation(action, actor, fromStage, operation) {
    let prepared
    let previousCapability
    let expectedCapability
    let stateWritten = false
    try {
      const result = await operation(async (capability, previousOrList, capabilities) => {
        const previous = Array.isArray(capabilities) ? capabilities : Array.isArray(previousOrList) ? previousOrList : null
        if (previous) {
          const index = previous.findIndex((item) => item.id === capability.id)
          previousCapability = index < 0 ? null : structuredClone(previous[index])
          expectedCapability = structuredClone(capability)
        }
        prepared = await audit.prepare({ action, actor, capability, fromStage, toStage: capability.stage })
      })
      stateWritten = true
      if (prepared) await audit.commit(prepared)
      return result
    } catch (error) {
      let recoveryError
      if (stateWritten && expectedCapability) {
        try {
          await registry.mutateAll((current) => {
            const index = current.findIndex((item) => item.id === expectedCapability.id)
            if (index < 0 || !sameCapability(current[index], expectedCapability)) {
              throw new EvaluationError('Capability metadata changed during audit recovery.', 409)
            }
            if (!previousCapability) current.splice(index, 1)
            else current[index] = previousCapability
            return current
          })
        } catch (caught) { recoveryError = caught }
      }
      if (prepared) await audit.fail(prepared).catch(() => undefined)
      if (recoveryError) throw new EvaluationError('Governance audit failed and automatic recovery was incomplete.', 500)
      throw error
    }
  }

  async function prepareAuditRecords(entries) {
    const prepared = []
    try {
      for (const entry of entries) prepared.push(await audit.prepare(entry))
      return prepared
    } catch (error) {
      for (const record of prepared) await audit.fail(record).catch(() => undefined)
      throw error
    }
  }

  async function completeAuditRecords(records) {
    for (const record of records) await audit.commit(record)
  }

  async function failAuditRecords(records) {
    for (const record of records) await audit.fail(record).catch(() => undefined)
  }

  function sameCapability(left, right) {
    return canonicalJson(left) === canonicalJson(right)
  }

  function capabilityChanges(before, after) {
    const next = new Map(after.map((item) => [item.id, item]))
    return before.flatMap((item) => {
      const replacement = next.get(item.id)
      return replacement && !sameCapability(item, replacement) ? [{ before: item, after: replacement }] : []
    })
  }

  async function commitCapabilityChanges(changes) {
    if (!changes.length) return
    await registry.mutateAll((capabilities) => {
      for (const change of changes) {
        const index = capabilities.findIndex((item) => item.id === change.before.id)
        if (index < 0 || !sameCapability(capabilities[index], change.before)) {
          throw new EvaluationError('Capability metadata changed during the release transaction.', 409)
        }
        capabilities[index] = change.after
      }
      return capabilities
    })
  }

  async function restoreCapabilityChanges(changes) {
    if (!changes.length) return
    await registry.mutateAll((capabilities) => {
      for (const change of changes) {
        const index = capabilities.findIndex((item) => item.id === change.before.id)
        if (index < 0) throw new EvaluationError('Capability metadata changed during release recovery.', 409)
        if (sameCapability(capabilities[index], change.before)) continue
        if (!sameCapability(capabilities[index], change.after)) throw new EvaluationError('Capability metadata changed during release recovery.', 409)
        capabilities[index] = change.before
      }
      return capabilities
    })
  }

  async function cleanupEvictedRecoveries(beforeTarget, afterTarget) {
    if (!installer.commitRecovery) return
    const retained = new Set((afterTarget?.previous || []).map((item) => item.restoreToken).filter(Boolean))
    const evicted = (beforeTarget?.previous || [])
      .map((item) => item.restoreToken)
      .filter((token) => token && !retained.has(token))
    await Promise.all(evicted.map((token) => installer.commitRecovery(token).catch(() => undefined)))
  }

  async function compensateRelease({ changes, targetSkeleton, beforeTarget, afterTarget, recoveryToken }) {
    const failures = []
    if (afterTarget) {
      try { await skeletonLock.restoreTarget(targetSkeleton, afterTarget, beforeTarget) } catch (error) { failures.push(error) }
    }
    if (!failures.length) {
      try { await restoreCapabilityChanges(changes) } catch (error) { failures.push(error) }
    }
    if (!failures.length && recoveryToken) {
      try { await installer.revert(recoveryToken) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new EvaluationError('Release failed and automatic recovery was incomplete.', 500)
  }

  function publicApplyResult(value) {
    const { recoveryToken: _recoveryToken, ...result } = value
    return result
  }
  function publicLock(value) {
    if (!value) return value
    const copy = structuredClone(value)
    const targets = copy.targets ? Object.values(copy.targets) : [copy]
    for (const target of targets) {
      for (const deployment of [target?.stable, target?.canary, ...(target?.previous || [])].filter(Boolean)) delete deployment.restoreToken
    }
    return copy
  }


  async function evidenceStale(capability) {
    if (!capability.evidence) return false
    const currentPolicy = await policyFor(capability)
    if (capability.evidence.policyHash !== gatePolicyHash(currentPolicy)
      || capability.evidence.candidateHash !== capability.artifact.contentHash
      || capability.evidence.baselineHash !== capability.baseline?.contentHash) return true
    const quality = await evaluations.getRun(capability.evidence.qualityRunId)
    if (!validRunEvidence(quality) || quality.evidenceHash !== capability.evidence.qualityEvidenceHash) return true
    if (capability.evidence.redteamRunId) {
      const redteam = await evaluations.getRun(capability.evidence.redteamRunId)
      if (!validRunEvidence(redteam)
        || evaluateRedteamGatePolicy(redteam, currentPolicy).gateResult !== 'passed'
        || redteam.evidenceHash !== capability.evidence.redteamEvidenceHash) return true
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
    const approvals = stale
      ? []
      : capability.approvals.filter((item) => item.evidenceHash === capability.evidence?.evidenceHash
        && item.identityAssurance !== 'unverified-legacy')
    const needsReapproval = capability.stage === 'approved'
      && !approvals.some((item) => trustedApproval(item, capability.evidence?.evidenceHash))
    return {
      ...capability,
      stage: needsReapproval ? 'ready' : capability.stage,
      evidenceStale: stale,
      approvals,
      reviewerIdentityAssurance: approvals.at(-1)?.identityAssurance || null,
    }
  }

  async function requireProjectBinding(capability) {
    if (typeof resolveProjectRoot !== 'function') return
    const projectRoot = await projectRootFor(capability.projectId)
    const targetKey = projectRoot ? await installer.targetKey(capability.targetSkeleton, projectRoot) : null
    if (projectRoot !== (capability.projectRoot || null) || targetKey !== (capability.targetKey || null)) {
      throw new EvaluationError('Capability release target no longer matches its registered Team Project.', 409)
    }
  }

  async function requireFresh(capability, stage) {
    if (capability.stage !== stage) throw new EvaluationError(`Capability must be ${stage} before this action.`, 409)
    if (!capability.evidence || await evidenceStale(capability)) throw new EvaluationError('Capability evidence is stale or unavailable.', 409)
    await requireProjectBinding(capability)
  }
  async function requireRequalified(capability) {
    if (!capability.evidence || await evidenceStale(capability)) throw new EvaluationError('Capability evidence is stale or unavailable.', 409)
    await requireProjectBinding(capability)
    if (!capability.approvals.some((item) => trustedApproval(item, capability.evidence.evidenceHash))) {
      throw new EvaluationError('A fresh independent approval is required before rollback.', 409)
    }
  }
  function assertLockedCapability(capability, deployment, label, requireTrustedApproval = false) {
    const evidence = capability?.evidence
    const bindingMatches = evidence
      && evidence.candidateHash === capability.artifact.contentHash
      && evidence.baselineHash === capability.baseline?.contentHash
      && combinedEvidenceHash({
        qualityRunId: evidence.qualityRunId,
        redteamRunId: evidence.redteamRunId,
        qualityEvidenceHash: evidence.qualityEvidenceHash,
        redteamEvidenceHash: evidence.redteamEvidenceHash,
        baselineHash: evidence.baselineHash,
        candidateHash: evidence.candidateHash,
        suiteHash: evidence.suiteHash,
        datasetHash: evidence.datasetHash,
        policyHash: evidence.policyHash,
      }) === evidence.evidenceHash
    const approved = capability?.approvals?.some((item) => item.decision === 'approved'
      && item.evidenceHash === evidence?.evidenceHash
      && deployment?.approvedBy?.includes(item.reviewer)
      && (!requireTrustedApproval || trustedApproval(item, evidence?.evidenceHash)))
    if (!bindingMatches
      || !approved
      || deployment?.capabilityId !== capability.id
      || deployment.evaluationRunId !== evidence.qualityRunId
      || deployment.evidenceHash !== evidence.evidenceHash) {
      throw new EvaluationError(`${label} metadata is inconsistent with the immutable project lock.`, 409)
    }
    assertArtifact(capability.artifact, deployment.artifact, label)
  }

  async function assertRestorableCapability(capability, deployment, label) {
    if (capability?.stage === 'superseded' && !capability.requalifiesStage) {
      return assertLockedCapability(capability, deployment, label, true)
    }
    if (!['deprecated', 'superseded'].includes(capability?.requalifiesStage)) {
      throw new EvaluationError(`${label} requires fresh evaluation and independent approval before rollback.`, 409)
    }
    await requireRequalified(capability)
    if (deployment?.capabilityId !== capability.id) {
      throw new EvaluationError(`${label} metadata is inconsistent with the immutable project lock.`, 409)
    }
    assertArtifact(capability.artifact, deployment.artifact, label)
  }


  async function currentStable(targetSkeleton, projectRoot = null) {
    const targetKey = installer.targetKey ? await installer.targetKey(targetSkeleton, projectRoot || undefined) : targetSkeleton
    const matches = []
    for (const capability of (await registry.list()).filter((item) => item.stage === 'stable')) {
      let capabilityKey
      try {
        capabilityKey = installer.targetKey
          ? await installer.targetKey(capability.targetSkeleton, capability.projectRoot || undefined)
          : capability.targetSkeleton
      } catch (error) {
        if (capability.targetSkeleton === targetSkeleton && capability.projectRoot === projectRoot) throw error
        continue
      }
      if (capabilityKey === targetKey) matches.push(capability)
    }
    if (matches.length > 1) throw new EvaluationError('Multiple Stable capabilities own the same physical target.', 409)
    const capability = matches[0]
    if (!capability) return null
    const deployment = (await skeletonLock.read()).targets[capabilityTargetKey(capability)]?.stable
    if (!deployment) throw new EvaluationError('Current Stable capability metadata is inconsistent with the project lock.', 409)
    assertLockedCapability(capability, deployment, 'Current Stable')
    return capability
  }

  async function requireCanaryEligible(capability) {
    await requireFresh(capability, 'approved')
    if (capability.requalifiesStage) throw new EvaluationError('Capability is requalified; use its stage-specific restore action.', 409)
    if (capability.ownerIdentityAssurance === 'unverified-legacy') {
      throw new EvaluationError('A trusted server-resolved owner is required before Canary.', 409)
    }
    if (!capability.artifact.gitCommit) throw new EvaluationError('Canary releases require an immutable Git commit.', 409)
    if (!capability.approvals.some((item) => trustedApproval(item, capability.evidence.evidenceHash))) {
      throw new EvaluationError('A fresh independent approval is required before Canary.', 409)
    }
    const stable = await currentStable(capability.targetSkeleton, capability.projectRoot)
    if (stable && stable.targetSkeleton !== capability.targetSkeleton) {
      throw new EvaluationError('Capability target aliases the current Stable target; nominate the canonical target instead.', 409)
    }
    if (stable) {
      if (!capability.baseline) throw new EvaluationError('Canary evidence is not bound to the current Stable version.', 409)
      assertArtifact(capability.baseline, stable.artifact, 'Canary baseline')
    }
  }

  async function resolvedCanaryTarget(capability, value, projectRoot) {
    const targetSkeleton = targetIdentity(value)
    if (typeof projectRoot !== 'string' || !projectRoot.trim()) {
      throw new EvaluationError('Canary deployment requires an absolute target project root.', 422)
    }
    if (!installer.projectIdentity) throw new EvaluationError('Canary project identity is unavailable.', 500)
    const canaryProject = await installer.projectIdentity(targetSkeleton, projectRoot)
    const stableCapabilities = [
      capability,
      ...(await registry.list()).filter((item) => item.stage === 'stable' && item.id !== capability.id),
    ]
    for (const stableCapability of stableCapabilities) {
      const stableProject = await installer.projectIdentity(stableCapability.targetSkeleton, stableCapability.projectRoot || undefined)
      if (stableProject.key === canaryProject.key) {
        throw new EvaluationError('Canary deployment requires a separate target project root.', 409)
      }
    }
    return { targetSkeleton, projectRoot: canaryProject.projectRoot }
  }

  async function verifyCanaryDeployment(capability, canary) {
    if (!deploymentMatches(canary, capability)
      || typeof canary.targetSkeleton !== 'string'
      || typeof canary.projectRoot !== 'string'
      || canary.observedContentHash !== capability.artifact.contentHash) {
      throw new EvaluationError('The current Canary deployment observation is missing or stale.', 409)
    }
    const target = await resolvedCanaryTarget(capability, canary.targetSkeleton, canary.projectRoot)
    const observed = await installer.verify(capability, target.targetSkeleton, target.projectRoot)
    if (observed.target !== canary.targetSkeleton
      || observed.projectRoot !== target.projectRoot
      || observed.contentHash !== canary.observedContentHash) {
      throw new EvaluationError('The Canary deployment changed after verification.', 409)
    }
    return observed
  }
  async function previewCanaryDeployment(capability, targetSkeleton, projectRoot, purpose = 'canary') {
    const deployment = { ...capability, targetSkeleton }
    const context = { purpose, subjectCapabilityId: capability.id, projectRoot }
    try {
      return await installer.preview(deployment, context)
    } catch (error) {
      if (!(error instanceof EvaluationError) || error.status !== 404) throw error
      return installer.previewInstall(deployment, context)
    }
  }

  async function redeployCanary(capability, canary) {
    const purpose = 'canary-recovery'
    const preview = await previewCanaryDeployment(capability, canary.targetSkeleton, canary.projectRoot, purpose)
    const applied = await installer.apply(preview.previewToken, {
      confirm: true,
      capabilityId: capability.id,
      releaseCapabilityId: capability.id,
      purpose,
      targetSkeleton: canary.targetSkeleton,
      projectRoot: canary.projectRoot,
      candidateHash: capability.artifact.contentHash,
    })
    if (!applied.applied || applied.contentHash !== capability.artifact.contentHash || !applied.recoveryToken) {
      throw new EvaluationError('Canary deployment recovery failed.', 500)
    }
    const observed = await installer.verify(capability, canary.targetSkeleton, canary.projectRoot)
    if (observed.target !== canary.targetSkeleton
      || observed.projectRoot !== canary.projectRoot
      || observed.contentHash !== capability.artifact.contentHash) {
      throw new EvaluationError('Canary deployment recovery verification failed.', 500)
    }
    return { applied, observed }
  }


  function releaseStable(capabilityId, input, purpose, action) {
    return serializeRelease(async () => {
      const capability = await registry.get(capabilityId)
      if (!capability) throw new EvaluationError('Capability was not found.', 404)
      await requireFresh(capability, 'canary')
      const physicalStable = await currentStable(capability.targetSkeleton, capability.projectRoot)
      if (physicalStable && physicalStable.targetSkeleton !== capability.targetSkeleton) {
        throw new EvaluationError('Capability target aliases the current Stable target; nominate the canonical target instead.', 409)
      }
      if (purpose === 'install' && physicalStable) throw new EvaluationError('Install requires an empty Stable target.', 409)
      if (physicalStable) {
        if (!capability.baseline) throw new EvaluationError('Stable promotion is not bound to the current Stable version.', 409)
        assertArtifact(capability.baseline, physicalStable.artifact, 'Stable promotion baseline')
      }
      const actor = identity(input?.actor, 'Operator')
      const beforeCapabilities = await registry.list()
      const beforeLock = await skeletonLock.read()
      const targetLock = beforeLock.targets[capabilityTargetKey(capability)]
      const beforeTarget = targetLock || null
      const canary = targetLock?.canary
      if (!canary || canary.capabilityId !== capability.id || canary.evidenceHash !== capability.evidence.evidenceHash) {
        throw new EvaluationError('The current Canary lock does not match this capability evidence.', 409)
      }
      assertLockedCapability(capability, canary, 'Current Canary', true)
      await verifyCanaryDeployment(capability, canary)
      if (targetLock?.stable) {
        if (!capability.baseline) throw new EvaluationError('Stable promotion is not bound to the current Stable version.', 409)
        assertArtifact(capability.baseline, targetLock.stable.artifact, 'Stable promotion baseline')
      }
      const stableMetadata = beforeCapabilities.filter((item) => item.stage === 'stable' && capabilityTargetKey(item) === capabilityTargetKey(capability))
      let previous = []
      if (targetLock?.stable) {
        const prior = stableMetadata.find((item) => item.id === targetLock.stable.capabilityId)
        if (!prior || stableMetadata.length !== 1) throw new EvaluationError('Stable capability metadata is inconsistent with the project lock.', 409)
        assertLockedCapability(prior, targetLock.stable, 'Current Stable')
        previous = [prior]
      } else if (stableMetadata.length) {
        throw new EvaluationError('Stable capability metadata is inconsistent with the project lock.', 409)
      }
      if (purpose === 'install' && targetLock?.stable) throw new EvaluationError('Install requires an empty Stable target.', 409)
      const projected = beforeCapabilities.map((item) => {
        if (item.id === capability.id) return sanitizeCapability({ ...item, stage: 'stable', requalifiesStage: null, updatedAt: new Date().toISOString() })
        if (previous.some((stable) => stable.id === item.id)) return sanitizeCapability({ ...item, stage: 'superseded', updatedAt: new Date().toISOString() })
        return item
      })
      const promoted = projected.find((item) => item.id === capability.id)
      const changes = capabilityChanges(beforeCapabilities, projected)
      const prepared = await prepareAuditRecords([
        { action, actor, capability: promoted, fromStage: capability.stage, toStage: promoted.stage },
        ...previous.map((item) => {
          const superseded = projected.find((candidate) => candidate.id === item.id)
          return { action: 'stable.superseded', actor, capability: superseded, fromStage: item.stage, toStage: superseded.stage }
        }),
      ])
      let applied
      let afterTarget
      try {
        applied = await installer.apply(input?.previewToken, {
          confirm: input?.confirm === true,
          capabilityId: capability.id,
          releaseCapabilityId: capability.id,
          purpose,
          targetSkeleton: capability.targetSkeleton,
          projectRoot: capability.projectRoot || undefined,
          candidateHash: capability.artifact.contentHash,
        })
        if (!applied.applied) {
          await failAuditRecords(prepared)
          return { capability: await publicCapability(capability), applied: publicApplyResult(applied), lock: publicLock(beforeLock) }
        }
        const lock = await skeletonLock.promoteStable(capabilityTargetKey(capability), capability, targetLock?.stable ? applied.recoveryToken : null)
        afterTarget = lock
        await commitCapabilityChanges(changes)
        const publicPromoted = await publicCapability(promoted)
        await completeAuditRecords(prepared)
        if (!targetLock?.stable) await installer.commitRecovery?.(applied.recoveryToken).catch(() => undefined)
        await cleanupEvictedRecoveries(beforeTarget, afterTarget)
        await installer.commitRecovery?.(canary.restoreToken).catch(() => undefined)
        return { capability: publicPromoted, applied: publicApplyResult(applied), lock: publicLock(lock) }
      } catch (error) {
        let recoveryError
        if (applied?.applied || afterTarget) {
          try {
            await compensateRelease({
              changes,
              targetSkeleton: capabilityTargetKey(capability),
              beforeTarget,
              afterTarget,
              recoveryToken: applied?.recoveryToken,
            })
          } catch (caught) { recoveryError = caught }
        }
        await failAuditRecords(prepared)
        throw recoveryError || error
      }
    })
  }

  async function restoreDeprecated(capability, input) {
    const actor = identity(input?.actor, 'Operator')
    const beforeCapabilities = await registry.list()
    const beforeLock = await skeletonLock.read()
    const beforeTarget = beforeLock.targets[capabilityTargetKey(capability)] || null
    const target = beforeLock.targets[capabilityTargetKey(capability)]
    const previous = target?.previous?.[0]
    if (target?.stable || !previous || previous.capabilityId !== capability.id) {
      throw new EvaluationError('The Deprecated lock does not match this capability.', 409)
    }
    await assertRestorableCapability(capability, previous, 'Deprecated Stable')
    const projected = beforeCapabilities.map((item) => item.id === capability.id
      ? sanitizeCapability({ ...item, stage: 'stable', requalifiesStage: null, updatedAt: new Date().toISOString() })
      : item)
    const restored = projected.find((item) => item.id === capability.id)
    const changes = capabilityChanges(beforeCapabilities, projected)
    const prepared = await prepareAuditRecords([
      { action: 'stable.restored', actor, capability: restored, fromStage: capability.stage, toStage: restored.stage },
    ])
    let applied
    let afterTarget
    try {
      applied = await installer.apply(input?.previewToken, {
        confirm: input?.confirm === true,
        capabilityId: capability.id,
        releaseCapabilityId: capability.id,
        purpose: 'restore',
        targetSkeleton: capability.targetSkeleton,
        projectRoot: capability.projectRoot || undefined,
        candidateHash: capability.artifact.contentHash,
      })
      if (!applied.applied) {
        await failAuditRecords(prepared)
        return { capability: await publicCapability(capability), applied: publicApplyResult(applied), lock: publicLock(beforeLock) }
      }
      const lock = await skeletonLock.restoreDeprecated(capabilityTargetKey(capability), capability)
      afterTarget = lock
      await commitCapabilityChanges(changes)
      const publicRestored = await publicCapability(restored)
      await completeAuditRecords(prepared)
      await installer.commitRecovery?.(applied.recoveryToken).catch(() => undefined)
      return { capability: publicRestored, applied: publicApplyResult(applied), lock: publicLock(lock), restoredCapabilityId: restored.id }
    } catch (error) {
      let recoveryError
      try {
        await compensateRelease({
          changes,
          targetSkeleton: capabilityTargetKey(capability),
          beforeTarget,
          afterTarget,
          recoveryToken: applied?.recoveryToken,
        })
      } catch (caught) { recoveryError = caught }
      await failAuditRecords(prepared)
      throw recoveryError || error
    }
  }
  function auditArtifactMatches(record, capability) {
    return record.capabilityId === capability.id
      && record.artifact.kind === capability.artifact.kind
      && record.artifact.artifactId === capability.artifact.artifactId
      && record.artifact.version === capability.artifact.version
      && record.artifact.source === capability.artifact.source
      && record.artifact.contentHash === capability.artifact.contentHash
      && (record.artifact.gitCommit || null) === (capability.artifact.gitCommit || null)
  }

  function deploymentMatches(deployment, capability) {
    return deployment?.capabilityId === capability.id
      && deployment.evidenceHash === capability.evidence?.evidenceHash
  }

  function lockConfirmsAudit(record, capability, target, pending) {
    if (!target) return false
    if (record.action === 'canary.started') return deploymentMatches(target.canary, capability)
    if (['stable.installed', 'stable.promoted', 'stable.restored'].includes(record.action)) {
      return deploymentMatches(target.stable, capability)
    }
    if (record.action === 'stable.superseded') {
      return Boolean(target.stable && target.previous.some((item) => deploymentMatches(item, capability)))
    }
    if (record.action === 'stable.deprecated') {
      return Boolean(!target.stable && target.previous.some((item) => deploymentMatches(item, capability)))
    }
    if (record.action === 'stable.rolled-back') {
      return Boolean(target.stable
        && target.stable.capabilityId !== capability.id
        && pending.some((item) => item.record.action === 'stable.restored'
          && item.capability
          && capabilityTargetKey(item.capability) === capabilityTargetKey(capability)
          && deploymentMatches(target.stable, item.capability)))
    }
    return false
  }

  async function reconcilePendingGovernance() {
    await skeletonLock.transaction(async () => {
      let capabilities = await registry.list()
      let lock = await skeletonLock.read()
      for (const capability of capabilities.filter((item) => item.stage === 'canary')) {
        if (!capability.evidence) continue
        const target = lock.targets[capabilityTargetKey(capability)]
        if (target?.stable?.capabilityId === capability.id) continue
        const observed = deploymentMatches(target?.canary, capability)
          && typeof target.canary.targetSkeleton === 'string'
          && typeof target.canary.projectRoot === 'string'
          && target.canary.observedContentHash === capability.artifact.contentHash
          && typeof target.canary.observedAt === 'string'
        if (observed) continue
        if (deploymentMatches(target?.canary, capability)) {
          await skeletonLock.clearCanary(capabilityTargetKey(capability), capability)
          lock = await skeletonLock.read()
        }
        await registry.update(capability.id, (current) => current.stage === 'canary'
          ? { ...current, stage: 'approved', updatedAt: new Date().toISOString() }
          : current)
        capabilities = await registry.list()
      }

      const pendingRecords = audit.pending
        ? await audit.pending()
        : (await audit.list({ limit: 1_000 })).filter((record) => record.outcome === 'pending')
      const pending = pendingRecords
        .map((record) => ({ record, capability: capabilities.find((item) => item.id === record.capabilityId) }))
      if (!pending.length) return

      const committed = new Set()
      const stages = new Map()
      for (const item of pending) {
        const { record, capability } = item
        if (!capability || !auditArtifactMatches(record, capability)) continue
        const evidenceMatches = record.evidenceHash === (capability.evidence?.evidenceHash || null)
        const target = lock.targets[capabilityTargetKey(capability)]
        const lockAction = record.action === 'canary.started' || record.action.startsWith('stable.')
        const lockMatches = lockConfirmsAudit(record, capability, target, pending)
        if (lockAction && lockMatches && evidenceMatches) {
          stages.set(capability.id, record.toStage)
          committed.add(record.transactionId)
        } else if (!lockAction && capability.stage === record.toStage && evidenceMatches) {
          committed.add(record.transactionId)
        } else if (lockAction && capability.stage === record.toStage) {
          throw new EvaluationError('Governance state is inconsistent with the project lock.', 500)
        }
      }

      if (stages.size) {
        await registry.mutateAll((current) => current.map((capability) => stages.has(capability.id)
          ? { ...capability, stage: stages.get(capability.id), updatedAt: new Date().toISOString() }
          : capability))
        capabilities = await registry.list()
      }
      for (const { record } of pending) {
        if (committed.has(record.transactionId)) await audit.commit(record)
        else await audit.fail(record)
      }
    })
  }

  return {
    registry,
    skeletonLock,
    audit,
    async initialize() {
      await installer.initialize?.()
      await reconcilePendingGovernance()
    },
    async list() { return Promise.all((await registry.list()).map(publicCapability)) },
    async listAudit(filters) { return audit.list(filters) },
    async get(id) {
      const capability = await registry.get(id)
      if (!capability) throw new EvaluationError('Capability was not found.', 404)
      return publicCapability(capability)
    },
    nominate(input) {
      return serializeRelease(async () => {
        const artifact = normalizeArtifactDefinition(input?.artifact)
        const requestedBaseline = input?.baseline ? normalizeArtifactDefinition(input.baseline) : null
        const requestedTarget = targetIdentity(input?.targetSkeleton)
        const projectId = input?.projectId == null ? null : identity(input.projectId, 'Project ID').toLocaleLowerCase('en-US')
        const projectRoot = await projectRootFor(projectId)
        const stable = await currentStable(requestedTarget, projectRoot)
        const targetSkeleton = stable?.targetSkeleton || requestedTarget
        const targetKey = stable
          ? capabilityTargetKey(stable)
          : projectRoot && installer.targetKey
            ? await installer.targetKey(targetSkeleton, projectRoot)
            : null
        if (requestedBaseline && stable) assertArtifact(requestedBaseline, stable.artifact, 'Candidate baseline')
        const baseline = stable?.artifact || requestedBaseline
        if ([artifact, baseline].some((item) => item?.source === 'prompthub')) {
          throw new EvaluationError('PromptHub capability versions must be imported into Git before nomination.', 422)
        }
        if ([artifact, baseline].some((item) => ['github', 'prompt-registry'].includes(item?.source) && !item.gitCommit)) {
          throw new EvaluationError('Git-backed capability versions require an immutable Git commit.', 422)
        }
        const policyId = identity(input?.policyId || policy.id, 'Policy ID').toLocaleLowerCase('en-US')
        await policyFor({ policyId, projectId })
        const owner = identity(input?.owner, 'Capability owner')
        const ownerIdentityAssurance = identityAssurance(input?.ownerIdentityAssurance)
        const existing = (await registry.list()).find((item) => capabilityTargetKey(item) === (targetKey || targetSkeleton)
          && item.policyId === policyId
          && item.projectId === projectId
          && canonicalJson(item.artifact) === canonicalJson(artifact))
        const reclaimingCanary = existing?.stage === 'canary' && existing.ownerIdentityAssurance === 'unverified-legacy'
        let beforeTarget
        let afterTarget
        try {
          if (reclaimingCanary) {
            beforeTarget = (await skeletonLock.read()).targets[capabilityTargetKey(existing)]
            assertLockedCapability(existing, beforeTarget?.canary, 'Legacy Canary')
            afterTarget = await skeletonLock.clearCanary(capabilityTargetKey(existing), existing)
          }
          const result = await auditedMutation('candidate.nominated', owner, existing?.stage || null, (beforeCommit) => registry.nominate({
            artifact,
            baseline,
            owner,
            ownerIdentityAssurance,
            targetSkeleton,
            projectRoot,
            targetKey,
            projectId,
            policyId,
          }, beforeCommit))
          return { ...result, capability: await publicCapability(result.capability) }
        } catch (error) {
          if (afterTarget) {
            try { await skeletonLock.restoreTarget(capabilityTargetKey(existing), afterTarget, beforeTarget) } catch {
              throw new EvaluationError('Candidate reclamation failed and automatic recovery was incomplete.', 500)
            }
          }
          throw error
        }
      })
    },
    retractCandidate(capabilityId, input) {
      return serializeRelease(async () => {
        const capability = await registry.get(capabilityId)
        if (!capability) throw new EvaluationError('Capability was not found.', 404)
        if (capability.stage !== 'candidate' || capability.evidence || capability.approvals.length) {
          throw new EvaluationError('Only an unevaluated Candidate can be retracted.', 409)
        }
        const actor = identity(input?.actor, 'Operator')
        const updated = await auditedMutation('candidate.retracted', actor, 'candidate', (beforeCommit) => registry.update(
          capabilityId,
          (current) => {
            if (current.stage !== 'candidate' || current.evidence || current.approvals.length) {
              throw new EvaluationError('Only an unevaluated Candidate can be retracted.', 409)
            }
            return { ...current, stage: 'deprecated', updatedAt: new Date().toISOString() }
          },
          beforeCommit,
        ))
        return publicCapability(updated)
      })
    },
    bindEvidence(capabilityId, input) {
      return serializeRelease(async () => {
        const capability = await registry.get(capabilityId)
        if (!capability) throw new EvaluationError('Capability was not found.', 404)
        if (!['candidate', 'evaluating', 'blocked', 'ready', 'approved', 'canary', 'deprecated', 'superseded'].includes(capability.stage)) {
          throw new EvaluationError('Evidence cannot be rebound from this capability stage.', 409)
        }
        const gatePolicy = await policyFor(capability)
        const quality = await evaluations.getRun(identity(input?.runId, 'Managed Suite run ID'))
        if (!validRunEvidence(quality) || quality.mode !== 'suite' || !quality.suiteHash) {
          throw new EvaluationError('Only completed Managed Suite evidence can be bound.', 409)
        }
        assertCandidate(quality, capability, 'Quality evidence')
        const stable = await currentStable(capability.targetSkeleton, capability.projectRoot)
        const baseline = normalizeArtifactDefinition(quality.baseline)
        if (stable) assertArtifact(baseline, stable.artifact, 'Quality evidence baseline')
        else if (capability.baseline) assertArtifact(baseline, capability.baseline, 'Quality evidence baseline')
        let redteam = null
        if (input?.redteamRunId) {
          redteam = await evaluations.getRun(identity(input.redteamRunId, 'Red Team run ID'))
          if (!validRunEvidence(redteam) || redteam.mode !== 'redteam') throw new EvaluationError('Red Team evidence is invalid.', 409)
          assertCandidate(redteam, capability, 'Red Team evidence')
          assertArtifact(redteam.baseline, baseline, 'Red Team evidence baseline')
          if (evaluateRedteamGatePolicy(redteam, gatePolicy).gateResult !== 'passed') {
            throw new EvaluationError('Red Team evidence did not pass the privacy gate.', 409)
          }
        }
        const evaluated = evaluateGatePolicy({ ...quality, redteamEvidenceHash: redteam?.evidenceHash || null }, gatePolicy)
        const binding = {
          qualityRunId: quality.id,
          redteamRunId: redteam?.id || null,
          baselineHash: baseline.contentHash,
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
        const actor = identity(input?.actor, 'Operator')
        const requalifiesStage = capability.requalifiesStage
          || (['deprecated', 'superseded'].includes(capability.stage) ? capability.stage : null)
        const update = (current) => ({
          ...current,
          baseline,
          stage: evaluated.gateResult === 'passed' ? 'ready' : 'blocked',
          requalifiesStage,
          latestEvidenceRunId: quality.id,
          evidence: nextEvidence,
          approvals: [],
        })
        if (capability.stage !== 'canary') {
          const updated = await auditedMutation('evidence.bound', actor, capability.stage, (beforeCommit) => registry.update(capabilityId, update, beforeCommit))
          return publicCapability(updated)
        }
        const beforeLock = await skeletonLock.read()
        const beforeTarget = beforeLock.targets[capabilityTargetKey(capability)]
        const canary = beforeTarget?.canary
        assertLockedCapability(capability, canary, 'Current Canary')
        await verifyCanaryDeployment(capability, canary)
        let afterTarget
        let updated
        let prepared
        let reverted = false
        try {
          if (canary.restoreToken) {
            const rollback = await installer.revert(canary.restoreToken)
            if (!rollback?.restored) throw new EvaluationError('Canary deployment could not be removed before evidence replacement.', 500)
            reverted = true
          }
          afterTarget = await skeletonLock.clearCanary(capabilityTargetKey(capability), capability)
          updated = await registry.update(capabilityId, update, async (next) => {
            prepared = await audit.prepare({
              action: 'evidence.bound',
              actor,
              capability: next,
              fromStage: capability.stage,
              toStage: next.stage,
            })
          })
          await audit.commit(prepared)
          return publicCapability(updated)
        } catch (error) {
          let recoveryError
          try {
            if (reverted) {
              const recovered = await redeployCanary(capability, canary)
              const restoredTarget = structuredClone(beforeTarget)
              restoredTarget.canary = {
                ...restoredTarget.canary,
                targetSkeleton: recovered.observed.target,
                observedContentHash: recovered.observed.contentHash,
                observedAt: recovered.observed.observedAt,
                restoreToken: recovered.applied.recoveryToken,
              }
              await skeletonLock.restoreTarget(capabilityTargetKey(capability), afterTarget || beforeTarget, restoredTarget)
              if (updated) await restoreCapabilityChanges([{ before: capability, after: updated }])
            } else {
              await compensateRelease({
                changes: updated ? [{ before: capability, after: updated }] : [],
                targetSkeleton: capabilityTargetKey(capability),
                beforeTarget,
                afterTarget,
              })
            }
          } catch (caught) { recoveryError = caught }
          if (prepared) await audit.fail(prepared).catch(() => undefined)
          throw recoveryError || error
        }
      })
    },
    approve(capabilityId, input) {
      return serializeRelease(async () => {
        const capability = await registry.get(capabilityId)
        if (!capability) throw new EvaluationError('Capability was not found.', 404)
        const hasTrustedApproval = capability.approvals.some((item) => trustedApproval(item, capability.evidence?.evidenceHash))
        if (capability.stage === 'approved' && !hasTrustedApproval) {
          if (!capability.evidence || await evidenceStale(capability)) throw new EvaluationError('Capability evidence is stale or unavailable.', 409)
        } else {
          await requireFresh(capability, 'ready')
        }
        const reviewer = identity(input?.reviewer, 'Reviewer')
        if (sameIdentity(reviewer, capability.owner)) throw new EvaluationError('Capability owners cannot approve their own candidate.', 409)
        const decision = input?.decision === undefined ? 'approved' : input.decision
        if (!['approved', 'rejected'].includes(decision)) throw new EvaluationError('Approval decision must be approved or rejected.', 422)
        const reviewerIdentityAssurance = identityAssurance(input?.reviewerIdentityAssurance)
        const updated = await auditedMutation('approval.decided', reviewer, capability.stage, (beforeCommit) => registry.update(capabilityId, (current) => {
          if (current.stage !== capability.stage
            || current.evidence?.evidenceHash !== capability.evidence?.evidenceHash
            || current.owner !== capability.owner) {
            throw new EvaluationError('Capability evidence changed before approval was recorded.', 409)
          }
          return {
            ...current,
            stage: decision === 'approved' ? 'approved' : 'blocked',
            approvals: [...current.approvals, {
              reviewer,
              decision,
              evidenceHash: current.evidence.evidenceHash,
              decidedAt: new Date().toISOString(),
              identityAssurance: reviewerIdentityAssurance,
            }],
          }
        }, beforeCommit))
        return publicCapability(updated)
      })
    },
    async previewCanary(capabilityId, context = {}) {
      const capability = await registry.get(capabilityId)
      if (!capability) throw new EvaluationError('Capability was not found.', 404)
      await requireCanaryEligible(capability)
      const target = await resolvedCanaryTarget(capability, context.targetSkeleton, context.projectRoot)
      return previewCanaryDeployment(capability, target.targetSkeleton, target.projectRoot)
    },
    canary(capabilityId, input) {
      return serializeRelease(async () => {
        const capability = await registry.get(capabilityId)
        if (!capability) throw new EvaluationError('Capability was not found.', 404)
        await requireCanaryEligible(capability)
        const target = await resolvedCanaryTarget(capability, input?.targetSkeleton, input?.projectRoot)
        const actor = identity(input?.actor, 'Operator')
        const beforeCapabilities = await registry.list()
        const beforeLock = await skeletonLock.read()
        const beforeTarget = beforeLock.targets[capabilityTargetKey(capability)] || null
        const projectedCapabilities = beforeCapabilities.map((item) => item.id === capability.id
          ? sanitizeCapability({ ...item, stage: 'canary', updatedAt: new Date().toISOString() })
          : item)
        const projected = projectedCapabilities.find((item) => item.id === capability.id)
        const changes = capabilityChanges(beforeCapabilities, projectedCapabilities)
        const prepared = await audit.prepare({ action: 'canary.started', actor, capability: projected, fromStage: capability.stage, toStage: projected.stage })
        let applied
        let afterTarget
        try {
          applied = await installer.apply(input?.previewToken, {
            confirm: input?.confirm === true,
            capabilityId: capability.id,
            releaseCapabilityId: capability.id,
            purpose: 'canary',
            targetSkeleton: target.targetSkeleton,
            projectRoot: target.projectRoot,
            candidateHash: capability.artifact.contentHash,
          })
          if (!applied.applied) {
            await audit.fail(prepared)
            return { capability: await publicCapability(capability), applied: publicApplyResult(applied), lock: publicLock(beforeLock) }
          }
          if (applied.contentHash !== capability.artifact.contentHash) {
            throw new EvaluationError('Canary deployment content hash does not match the approved Candidate.', 409)
          }
          const observed = await installer.verify(capability, target.targetSkeleton, target.projectRoot)
          if (observed.target !== target.targetSkeleton || observed.projectRoot !== target.projectRoot || observed.contentHash !== capability.artifact.contentHash) {
            throw new EvaluationError('Canary deployment verification did not observe the approved target and content.', 409)
          }
          afterTarget = await skeletonLock.setCanary(capabilityTargetKey(capability), capability, {
            targetSkeleton: target.targetSkeleton,
            projectRoot: target.projectRoot,
            observedContentHash: observed.contentHash,
            observedAt: observed.observedAt,
            recoveryToken: applied.recoveryToken,
          })
          await commitCapabilityChanges(changes)
          const result = await publicCapability(projected)
          await audit.commit(prepared)
          return { capability: result, applied: publicApplyResult(applied), lock: publicLock(afterTarget) }
        } catch (error) {
          let recoveryError
          if (applied?.applied || afterTarget) {
            try {
              await compensateRelease({
                changes,
                targetSkeleton: capabilityTargetKey(capability),
                beforeTarget,
                afterTarget,
                recoveryToken: applied?.recoveryToken,
              })
            } catch (caught) { recoveryError = caught }
          }
          await audit.fail(prepared).catch(() => undefined)
          throw recoveryError || error
        }
      })
    },
    async previewPromotion(capabilityId, context = {}) {
      const capability = await registry.get(capabilityId)
      if (!capability) throw new EvaluationError('Capability was not found.', 404)
      await requireFresh(capability, 'canary')
      const canary = (await skeletonLock.read()).targets[capabilityTargetKey(capability)]?.canary
      await verifyCanaryDeployment(capability, canary)
      const stable = await currentStable(capability.targetSkeleton, capability.projectRoot)
      if (stable && stable.targetSkeleton !== capability.targetSkeleton) {
        throw new EvaluationError('Capability target aliases the current Stable target; nominate the canonical target instead.', 409)
      }
      if (stable) {
        if (!capability.baseline) throw new EvaluationError('Stable promotion is not bound to the current Stable version.', 409)
        assertArtifact(capability.baseline, stable.artifact, 'Stable promotion baseline')
      }
      return installer.preview(capability, { ...context, purpose: 'promote', subjectCapabilityId: capability.id, projectRoot: capability.projectRoot || undefined })
    },
    promote(capabilityId, input) {
      return releaseStable(capabilityId, input, 'promote', 'stable.promoted')
    },
    async previewInstallation(capabilityId, context = {}) {
      const capability = await registry.get(capabilityId)
      if (!capability) throw new EvaluationError('Capability was not found.', 404)
      await requireFresh(capability, 'canary')
      const canary = (await skeletonLock.read()).targets[capabilityTargetKey(capability)]?.canary
      await verifyCanaryDeployment(capability, canary)
      if (await currentStable(capability.targetSkeleton, capability.projectRoot)) {
        throw new EvaluationError('Install requires an empty Stable target.', 409)
      }
      return installer.previewInstall(capability, { ...context, purpose: 'install', subjectCapabilityId: capability.id, projectRoot: capability.projectRoot || undefined })
    },
    install(capabilityId, input) {
      return releaseStable(capabilityId, input, 'install', 'stable.installed')
    },
    async previewDeprecation(capabilityId, context = {}) {
      const capability = await registry.get(capabilityId)
      if (!capability) throw new EvaluationError('Capability was not found.', 404)
      if (capability.stage !== 'stable') throw new EvaluationError('Only a Stable capability can be deprecated.', 409)
      await requireProjectBinding(capability)
      const stable = await currentStable(capability.targetSkeleton, capability.projectRoot)
      if (stable?.id !== capability.id) throw new EvaluationError('The Stable lock does not match this capability.', 409)
      return installer.previewRemoval(capability, { ...context, purpose: 'deprecate', subjectCapabilityId: capability.id, projectRoot: capability.projectRoot || undefined })
    },
    deprecate(capabilityId, input) {
      return serializeRelease(async () => {
        const capability = await registry.get(capabilityId)
        if (!capability) throw new EvaluationError('Capability was not found.', 404)
        if (capability.stage !== 'stable') throw new EvaluationError('Only a Stable capability can be deprecated.', 409)
        await requireProjectBinding(capability)
        const actor = identity(input?.actor, 'Operator')
        const beforeCapabilities = await registry.list()
        const beforeLock = await skeletonLock.read()
        const beforeTarget = beforeLock.targets[capabilityTargetKey(capability)] || null
        const stable = beforeLock.targets[capabilityTargetKey(capability)]?.stable
        if (!stable) throw new EvaluationError('The Stable lock does not match this capability evidence.', 409)
        assertLockedCapability(capability, stable, 'Stable')
        const projected = beforeCapabilities.map((item) => item.id === capability.id
          ? sanitizeCapability({ ...item, stage: 'deprecated', updatedAt: new Date().toISOString() })
          : item)
        const deprecated = projected.find((item) => item.id === capability.id)
        const changes = capabilityChanges(beforeCapabilities, projected)
        const prepared = await prepareAuditRecords([
          { action: 'stable.deprecated', actor, capability: deprecated, fromStage: capability.stage, toStage: deprecated.stage },
        ])
        let applied
        let afterTarget
        try {
          applied = await installer.apply(input?.previewToken, {
            confirm: input?.confirm === true,
            capabilityId: capability.id,
            releaseCapabilityId: capability.id,
            purpose: 'deprecate',
            targetSkeleton: capability.targetSkeleton,
            projectRoot: capability.projectRoot || undefined,
            candidateHash: capability.artifact.contentHash,
          })
          if (!applied.applied) {
            await failAuditRecords(prepared)
            return { capability: await publicCapability(capability), applied: publicApplyResult(applied), lock: publicLock(beforeLock) }
          }
          const result = await skeletonLock.deprecateStable(capabilityTargetKey(capability), capability, applied.recoveryToken)
          afterTarget = result.target
          await commitCapabilityChanges(changes)
          const publicDeprecated = await publicCapability(deprecated)
          await completeAuditRecords(prepared)
          await cleanupEvictedRecoveries(beforeTarget, afterTarget)
          return { capability: publicDeprecated, applied: publicApplyResult(applied), lock: publicLock(result.target) }
        } catch (error) {
          let recoveryError
          try {
            await compensateRelease({
              changes,
              targetSkeleton: capabilityTargetKey(capability),
              beforeTarget,
              afterTarget,
              recoveryToken: applied?.recoveryToken,
            })
          } catch (caught) { recoveryError = caught }
          await failAuditRecords(prepared)
          throw recoveryError || error
        }
      })
    },
    async previewRollback(capabilityId) {
      let capability = await registry.get(capabilityId)
      if (!capability) throw new EvaluationError('Capability was not found.', 404)
      await requireProjectBinding(capability)
      const lock = await skeletonLock.read()
      const restoringDeprecated = capability.stage === 'deprecated'
        || (capability.stage === 'approved' && capability.requalifiesStage === 'deprecated')
      const target = lock.targets[capabilityTargetKey(capability)]
      if (restoringDeprecated && target?.stable) {
        if (target.previous?.[0]?.capabilityId !== capability.id) {
          throw new EvaluationError('The Deprecated capability is not the previous immutable Stable version.', 409)
        }
        capability = await registry.get(target.stable.capabilityId)
        if (!capability || capability.stage !== 'stable') {
          throw new EvaluationError('Current Stable capability metadata is unavailable.', 409)
        }
        await requireProjectBinding(capability)
        assertLockedCapability(capability, target.stable, 'Current Stable')
      }
      if (restoringDeprecated && !target?.stable) {
        const previous = target?.previous?.[0]
        if (target?.stable || !previous || previous.capabilityId !== capability.id) {
          throw new EvaluationError('The Deprecated lock does not match this capability.', 409)
        }
        await assertRestorableCapability(capability, previous, 'Deprecated Stable')
        const preview = previous.restoreToken || capability.artifact.source === 'prompt-registry'
          ? await installer.previewRestore(capability, previous.restoreToken, { purpose: 'restore', subjectCapabilityId: capability.id, projectRoot: capability.projectRoot || undefined })
          : await installer.previewInstall(capability, { purpose: 'restore', subjectCapabilityId: capability.id, projectRoot: capability.projectRoot || undefined })
        return { ...preview, restoredCapabilityId: capability.id }
      }
      if (capability.stage !== 'stable') throw new EvaluationError('Only a Stable or Deprecated capability can be rolled back.', 409)
      const previous = lock.targets[capabilityTargetKey(capability)]?.previous?.[0]
      if (!previous) throw new EvaluationError('No previous immutable Stable version is available for rollback.', 409)
      const restored = await registry.get(previous.capabilityId)
      if (!restored) throw new EvaluationError('Previous Stable capability metadata is unavailable.', 409)
      await requireProjectBinding(restored)
      await assertRestorableCapability(restored, previous, 'Previous Stable')
      const preview = previous.restoreToken || restored.artifact.source === 'prompt-registry'
        ? await installer.previewRestore(restored, previous.restoreToken, {
          purpose: 'rollback',
          subjectCapabilityId: capability.id,
          currentHash: capability.artifact.contentHash,
          projectRoot: restored.projectRoot || undefined,
        })
        : await installer.preview(restored, {
          skipReferenceVerification: restored.artifact.source === 'prompt-registry',
          purpose: 'rollback',
          subjectCapabilityId: capability.id,
          projectRoot: restored.projectRoot || undefined,
        })
      return { ...preview, restoredCapabilityId: restored.id }
    },
    rollback(capabilityId, input) {
      return serializeRelease(async () => {
        let capability = await registry.get(capabilityId)
        if (!capability) throw new EvaluationError('Capability was not found.', 404)
        await requireProjectBinding(capability)
        const restoringDeprecated = capability.stage === 'deprecated'
          || (capability.stage === 'approved' && capability.requalifiesStage === 'deprecated')
        if (restoringDeprecated) {
          const target = (await skeletonLock.read()).targets[capabilityTargetKey(capability)]
          if (!target?.stable) return restoreDeprecated(capability, input)
          if (target.previous?.[0]?.capabilityId !== capability.id) {
            throw new EvaluationError('The Deprecated capability is not the previous immutable Stable version.', 409)
          }
          capability = await registry.get(target.stable.capabilityId)
          if (!capability || capability.stage !== 'stable') {
            throw new EvaluationError('Current Stable capability metadata is unavailable.', 409)
          }
          await requireProjectBinding(capability)
          assertLockedCapability(capability, target.stable, 'Current Stable')
        }
        if (capability.stage !== 'stable') throw new EvaluationError('Only a Stable capability can be rolled back.', 409)
        const actor = identity(input?.actor, 'Operator')
        const beforeCapabilities = await registry.list()
        const beforeLock = await skeletonLock.read()
        const beforeTarget = beforeLock.targets[capabilityTargetKey(capability)] || null
        const target = beforeLock.targets[capabilityTargetKey(capability)]
        if (!target?.stable || target.stable.capabilityId !== capability.id || target.stable.evidenceHash !== capability.evidence.evidenceHash) {
          throw new EvaluationError('The Stable lock does not match this capability evidence.', 409)
        }
        assertLockedCapability(capability, target.stable, 'Current Stable')
        const previous = target.previous?.[0]
        const restoredBefore = beforeCapabilities.find((item) => item.id === previous?.capabilityId)
        if (!previous || !restoredBefore) throw new EvaluationError('Previous Stable capability metadata is unavailable.', 409)
        await requireProjectBinding(restoredBefore)
        await assertRestorableCapability(restoredBefore, previous, 'Previous Stable')
        const projected = beforeCapabilities.map((item) => {
          if (item.id === capability.id) return sanitizeCapability({ ...item, stage: 'rolled-back', updatedAt: new Date().toISOString() })
          if (item.id === restoredBefore.id) return sanitizeCapability({ ...item, stage: 'stable', requalifiesStage: null, updatedAt: new Date().toISOString() })
          return item
        })
        const rolledBack = projected.find((item) => item.id === capability.id)
        const restored = projected.find((item) => item.id === restoredBefore.id)
        const changes = capabilityChanges(beforeCapabilities, projected)
        const prepared = await prepareAuditRecords([
          { action: 'stable.rolled-back', actor, capability: rolledBack, fromStage: capability.stage, toStage: rolledBack.stage },
          { action: 'stable.restored', actor, capability: restored, fromStage: restoredBefore.stage, toStage: restored.stage },
        ])
        let applied
        let afterTarget
        try {
          applied = await installer.apply(input?.previewToken, {
            confirm: input?.confirm === true,
            capabilityId: capability.id,
            releaseCapabilityId: restoredBefore.id,
            purpose: 'rollback',
            targetSkeleton: restoredBefore.targetSkeleton,
            projectRoot: restoredBefore.projectRoot || undefined,
            candidateHash: restoredBefore.artifact.contentHash,
          })
          if (!applied.applied) {
            await failAuditRecords(prepared)
            return { capability: await publicCapability(capability), applied: publicApplyResult(applied), lock: publicLock(beforeLock) }
          }
          const result = await skeletonLock.rollback(capabilityTargetKey(capability), restoredBefore)
          afterTarget = result.target
          await commitCapabilityChanges(changes)
          const publicRolledBack = await publicCapability(rolledBack)
          await completeAuditRecords(prepared)
          await installer.commitRecovery?.(applied.recoveryToken).catch(() => undefined)
          return { capability: publicRolledBack, applied: publicApplyResult(applied), lock: publicLock(result.target), restoredCapabilityId: restored.id }
        } catch (error) {
          let recoveryError
          try {
            await compensateRelease({
              changes,
              targetSkeleton: capabilityTargetKey(capability),
              beforeTarget,
              afterTarget,
              recoveryToken: applied?.recoveryToken,
            })
          } catch (caught) { recoveryError = caught }
          await failAuditRecords(prepared)
          throw recoveryError || error
        }
      })
    },
    async lockState() { return publicLock(await skeletonLock.read()) },
  }
}
