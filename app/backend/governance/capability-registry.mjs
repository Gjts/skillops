import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeArtifactDefinition } from '../../shared/evaluation-schema.mjs'
import { EvaluationError } from '../evaluations/errors.mjs'
import { withGovernanceFileLock } from './skeleton-lock.mjs'

export const CAPABILITY_STAGES = Object.freeze(['candidate', 'evaluating', 'blocked', 'ready', 'approved', 'canary', 'stable', 'deprecated', 'superseded', 'rolled-back'])
const stages = new Set(CAPABILITY_STAGES)

function text(value, label, maxLength = 4_000, optional = false) {
  if ((value === undefined || value === null || value === '') && optional) return null
  if (typeof value !== 'string' || !value.trim()) throw new EvaluationError(`${label} is invalid.`, 422)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new EvaluationError(`${label} is too long.`, 422)
  return normalized
}

function timestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new EvaluationError(`${label} is invalid.`, 500)
  return new Date(value).toISOString()
}
function assurance(value) {
  return value === undefined ? 'unverified-legacy' : text(value, 'Identity assurance', 100)
}

function validateCapabilities(capabilities) {
  const ids = new Set()
  const reservations = new Map()
  for (const capability of capabilities) {
    if (ids.has(capability.id)) throw new EvaluationError('Capability registry contains a duplicate Capability ID.', 500)
    ids.add(capability.id)
    if (capability.evidence && capability.latestEvidenceRunId !== capability.evidence.qualityRunId) {
      throw new EvaluationError('Capability latest evidence run does not match its quality evidence binding.', 500)
    }
    for (const runId of new Set([capability.originEvaluationRunId, capability.latestEvidenceRunId].filter(Boolean))) {
      const owner = reservations.get(runId)
      if (owner && owner !== capability.id) throw new EvaluationError('Capability registry contains a duplicate evaluation run reservation.', 500)
      reservations.set(runId, capability.id)
    }
  }
  return capabilities
}


function approval(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError('Capability approval is invalid.', 500)
  if (!['approved', 'rejected'].includes(value.decision)) throw new EvaluationError('Capability approval decision is invalid.', 500)
  return {
    reviewer: text(value.reviewer, 'Reviewer', 200),
    decision: value.decision,
    evidenceHash: text(value.evidenceHash, 'Approval evidence hash', 64),
    decidedAt: timestamp(value.decidedAt, 'Approval time'),
    identityAssurance: assurance(value.identityAssurance),
  }
}

function evidence(value) {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError('Capability evidence is invalid.', 500)
  return {
    qualityRunId: text(value.qualityRunId, 'Quality run ID', 200),
    redteamRunId: text(value.redteamRunId, 'Red Team run ID', 200, true),
    baselineHash: text(value.baselineHash, 'Evidence baseline hash', 64),
    candidateHash: text(value.candidateHash, 'Evidence candidate hash', 64),
    suiteHash: text(value.suiteHash, 'Evidence suite hash', 64),
    datasetHash: text(value.datasetHash, 'Evidence dataset hash', 64, true),
    policyHash: text(value.policyHash, 'Evidence policy hash', 64),
    qualityEvidenceHash: text(value.qualityEvidenceHash, 'Quality evidence hash', 64),
    redteamEvidenceHash: text(value.redteamEvidenceHash, 'Red Team evidence hash', 64, true),
    evidenceHash: text(value.evidenceHash, 'Combined evidence hash', 64),
    boundAt: timestamp(value.boundAt, 'Evidence binding time'),
  }
}

export function sanitizeCapability(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError('Capability is invalid.', 500)
  if (!stages.has(value.stage)) throw new EvaluationError('Capability stage is invalid.', 500)
  if (value.requalifiesStage != null && !['deprecated', 'superseded'].includes(value.requalifiesStage)) {
    throw new EvaluationError('Capability requalification stage is invalid.', 500)
  }
  const latestEvidenceRunId = text(value.latestEvidenceRunId, 'Latest evidence run ID', 200, true)
  return {
    id: text(value.id, 'Capability ID', 200),
    artifact: normalizeArtifactDefinition(value.artifact),
    baseline: value.baseline ? normalizeArtifactDefinition(value.baseline) : null,
    owner: text(value.owner, 'Capability owner', 200),
    ownerIdentityAssurance: assurance(value.ownerIdentityAssurance),
    targetSkeleton: text(value.targetSkeleton, 'Target skeleton', 4_000),
    projectId: text(value.projectId, 'Project ID', 200, true),
    projectRoot: text(value.projectRoot, 'Project root', 4_000, true),
    targetKey: text(value.targetKey, 'Target key', 8_000, true),
    stage: value.stage,
    requalifiesStage: value.requalifiesStage || null,
    policyId: text(value.policyId, 'Policy ID', 100),
    originEvaluationRunId: text(value.originEvaluationRunId, 'Origin evaluation run ID', 200, true),
    latestEvidenceRunId,
    evidence: evidence(value.evidence),
    approvals: Array.isArray(value.approvals) ? value.approvals.map(approval) : [],
    createdAt: timestamp(value.createdAt, 'Capability created time'),
    updatedAt: timestamp(value.updatedAt, 'Capability updated time'),
  }
}

export function createCapabilityRegistry(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.SKILLOPS_DATA_DIR || path.join(process.cwd(), 'data'))
  const file = path.join(dataDir, 'capabilities.json')
  const lockFile = path.join(dataDir, 'capabilities.lock')
  let queue = Promise.resolve()

  async function read() {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      if (![1, 2].includes(parsed?.schemaVersion) || !Array.isArray(parsed.capabilities)) throw new Error('schema')
      const capabilities = parsed.capabilities.map(sanitizeCapability)
      return validateCapabilities(capabilities)
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      if (error instanceof EvaluationError) throw error
      throw new EvaluationError('Capability registry is invalid.', 500)
    }
  }

  function withLock(operation) {
    return withGovernanceFileLock(lockFile, operation)
  }

  function serialized(operation) {
    const pending = queue.then(() => withLock(operation))
    queue = pending.catch(() => undefined)
    return pending
  }

  async function write(capabilities) {
    const sanitized = validateCapabilities(capabilities.map(sanitizeCapability))
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 2, updatedAt: new Date().toISOString(), capabilities: sanitized }, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
    return sanitized
  }

  return {
    dataDir,
    file,
    async list() { return read() },
    async get(id) { return (await read()).find((item) => item.id === id) || null },
    async nominate(input, beforeCommit) {
      const artifact = normalizeArtifactDefinition(input?.artifact)
      const owner = text(input?.owner, 'Capability owner', 200)
      const ownerIdentityAssurance = assurance(input?.ownerIdentityAssurance)
      const targetSkeleton = text(input?.targetSkeleton, 'Target skeleton', 4_000)
      const projectId = text(input?.projectId, 'Project ID', 200, true)
      const projectRoot = text(input?.projectRoot, 'Project root', 4_000, true)
      const targetKey = text(input?.targetKey, 'Target key', 8_000, true)
      const policyId = text(input?.policyId || 'default-v1', 'Policy ID', 100)
      const originEvaluationRunId = text(input?.originEvaluationRunId, 'Origin evaluation run ID', 200, true)
      return serialized(async () => {
        const capabilities = await read()
        const existingIndex = capabilities.findIndex((item) => item.artifact.kind === artifact.kind
          && item.artifact.artifactId === artifact.artifactId
          && item.artifact.version === artifact.version
          && item.artifact.source === artifact.source
          && item.artifact.sourceRef === artifact.sourceRef
          && item.artifact.contentHash === artifact.contentHash
          && item.artifact.gitCommit === artifact.gitCommit
          && item.targetSkeleton === targetSkeleton
          && item.projectId === projectId
          && item.projectRoot === projectRoot
          && item.targetKey === targetKey
          && item.policyId === policyId)
        const existing = capabilities[existingIndex]
        if (originEvaluationRunId && existing?.originEvaluationRunId
          && existing.originEvaluationRunId !== originEvaluationRunId) {
          throw new EvaluationError('This Release Candidate already belongs to another Managed Suite run.', 409)
        }
        const reservationIndexes = originEvaluationRunId
          ? capabilities.flatMap((item, index) => item.originEvaluationRunId === originEvaluationRunId
            || item.latestEvidenceRunId === originEvaluationRunId ? [index] : [])
          : []
        if (reservationIndexes.length > 1) {
          throw new EvaluationError('This Managed Suite run has conflicting legacy Release Candidate reservations.', 409)
        }
        const originIndex = reservationIndexes[0] ?? -1
        if (originIndex >= 0 && originIndex !== existingIndex) {
          throw new EvaluationError('This Managed Suite run already created another Release Candidate.', 409)
        }
        if (originIndex >= 0 && capabilities[originIndex].originEvaluationRunId) {
          return { capability: capabilities[originIndex], reused: true }
        }
        if (existing && (existing.ownerIdentityAssurance !== 'unverified-legacy'
          || ['stable', 'deprecated', 'superseded', 'rolled-back'].includes(existing.stage))) {
          if (!originEvaluationRunId) return { capability: existing, reused: true }
          const claimed = sanitizeCapability({ ...existing, originEvaluationRunId, updatedAt: new Date().toISOString() })
          if (beforeCommit) await beforeCommit(claimed, existing, capabilities)
          capabilities[existingIndex] = claimed
          await write(capabilities)
          return { capability: claimed, reused: true }
        }
        if (existing) {
          const reclaimed = sanitizeCapability({
            ...existing,
            originEvaluationRunId: existing.originEvaluationRunId || originEvaluationRunId,
            baseline: input.baseline || null,
            owner,
            ownerIdentityAssurance,
            targetSkeleton,
            projectId,
            projectRoot,
            targetKey,
            stage: 'candidate',
            policyId,
            latestEvidenceRunId: null,
            evidence: null,
            approvals: [],
            updatedAt: new Date().toISOString(),
          })
          if (beforeCommit) await beforeCommit(reclaimed, existing, capabilities)
          capabilities[existingIndex] = reclaimed
          await write(capabilities)
          return { capability: reclaimed, reused: false, reclaimed: true }
        }
        const now = new Date().toISOString()
        const capability = sanitizeCapability({
          id: `cap_${artifact.contentHash.slice(0, 12)}_${randomUUID().slice(0, 8)}`,
          artifact,
          baseline: input.baseline || null,
          owner,
          ownerIdentityAssurance,
          targetSkeleton,
          projectId,
          projectRoot,
          targetKey,
          stage: 'candidate',
          policyId,
          originEvaluationRunId,
          latestEvidenceRunId: null,
          evidence: null,
          approvals: [],
          createdAt: now,
          updatedAt: now,
        })
        if (beforeCommit) await beforeCommit(capability, capabilities)
        capabilities.push(capability)
        await write(capabilities)
        return { capability, reused: false }
      })
    },
    async update(id, updater, beforeCommit, options = {}) {
      return serialized(async () => {
        const capabilities = await read()
        const index = capabilities.findIndex((item) => item.id === id)
        if (index < 0) throw new EvaluationError('Capability was not found.', 404)
        const next = sanitizeCapability({ ...await updater(capabilities[index], capabilities), id, updatedAt: new Date().toISOString() })
        const originChanged = next.originEvaluationRunId !== capabilities[index].originEvaluationRunId
        const allowedOriginClaim = options.allowOriginClaim
          && capabilities[index].originEvaluationRunId === null
          && Boolean(next.originEvaluationRunId)
        if (originChanged && !allowedOriginClaim) {
          throw new EvaluationError('Capability origin evaluation run is immutable.', 409)
        }
        if (beforeCommit) await beforeCommit(next, capabilities[index], capabilities)
        capabilities[index] = next
        await write(capabilities)
        return next
      })
    },
    async mutateAll(updater, beforeCommit, options = {}) {
      return serialized(async () => {
        const current = await read()
        const next = (await updater(current.map((item) => ({ ...item })))).map((item) => sanitizeCapability({ ...item, updatedAt: item.updatedAt || new Date().toISOString() }))
        if (!options.allowOriginChange) {
          const previousById = new Map(current.map((item) => [item.id, item.originEvaluationRunId]))
          if (next.some((item) => previousById.has(item.id) && previousById.get(item.id) !== item.originEvaluationRunId)) {
            throw new EvaluationError('Capability origin evaluation run is immutable.', 409)
          }
        }
        if (beforeCommit) await beforeCommit(next, current)
        return write(next)
      })
    },
    async replaceAll(capabilities) {
      return serialized(async () => {
        const current = await read()
        const previousById = new Map(current.map((item) => [item.id, item.originEvaluationRunId]))
        if (capabilities.some((item) => previousById.has(item.id) && previousById.get(item.id) !== item.originEvaluationRunId)) {
          throw new EvaluationError('Capability origin evaluation run is immutable.', 409)
        }
        return write(capabilities)
      })
    },
  }
}
