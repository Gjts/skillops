import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeArtifactDefinition } from '../../shared/evaluation-schema.mjs'
import { EvaluationError } from '../evaluations/errors.mjs'

export const CAPABILITY_STAGES = Object.freeze(['candidate', 'evaluating', 'blocked', 'ready', 'approved', 'canary', 'stable', 'superseded', 'rolled-back'])
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

function approval(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError('Capability approval is invalid.', 500)
  if (!['approved', 'rejected'].includes(value.decision)) throw new EvaluationError('Capability approval decision is invalid.', 500)
  return {
    reviewer: text(value.reviewer, 'Reviewer', 200),
    decision: value.decision,
    note: text(value.note, 'Approval note', 1_000, true) || undefined,
    evidenceHash: text(value.evidenceHash, 'Approval evidence hash', 64),
    decidedAt: timestamp(value.decidedAt, 'Approval time'),
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
  return {
    id: text(value.id, 'Capability ID', 200),
    artifact: normalizeArtifactDefinition(value.artifact),
    baseline: value.baseline ? normalizeArtifactDefinition(value.baseline) : null,
    owner: text(value.owner, 'Capability owner', 200),
    targetSkeleton: text(value.targetSkeleton, 'Target skeleton', 4_000),
    stage: value.stage,
    policyId: text(value.policyId, 'Policy ID', 100),
    latestEvidenceRunId: text(value.latestEvidenceRunId, 'Latest evidence run ID', 200, true),
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
      if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.capabilities)) throw new Error('schema')
      return parsed.capabilities.map(sanitizeCapability)
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      if (error instanceof EvaluationError) throw error
      throw new EvaluationError('Capability registry is invalid.', 500)
    }
  }

  async function withLock(operation) {
    await mkdir(dataDir, { recursive: true })
    let handle
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { handle = await open(lockFile, 'wx'); break } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const info = await stat(lockFile).catch(() => null)
        if (info && Date.now() - info.mtimeMs > 30_000) await rm(lockFile, { force: true })
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    if (!handle) throw new EvaluationError('Timed out waiting for the capability registry lock.', 503)
    try { return await operation() } finally { await handle.close(); await rm(lockFile, { force: true }) }
  }

  function serialized(operation) {
    const pending = queue.then(() => withLock(operation))
    queue = pending.catch(() => undefined)
    return pending
  }

  async function write(capabilities) {
    const sanitized = capabilities.map(sanitizeCapability)
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), capabilities: sanitized }, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
    return sanitized
  }

  return {
    dataDir,
    file,
    async list() { return read() },
    async get(id) { return (await read()).find((item) => item.id === id) || null },
    async nominate(input) {
      const artifact = normalizeArtifactDefinition(input?.artifact)
      const owner = text(input?.owner, 'Capability owner', 200)
      const targetSkeleton = text(input?.targetSkeleton, 'Target skeleton', 4_000)
      return serialized(async () => {
        const capabilities = await read()
        const existing = capabilities.find((item) => item.artifact.artifactId === artifact.artifactId && item.artifact.version === artifact.version && item.artifact.contentHash === artifact.contentHash)
        if (existing) return { capability: existing, reused: true }
        const now = new Date().toISOString()
        const capability = sanitizeCapability({
          id: `cap_${artifact.contentHash.slice(0, 12)}_${randomUUID().slice(0, 8)}`,
          artifact,
          baseline: input.baseline || null,
          owner,
          targetSkeleton,
          stage: 'candidate',
          policyId: input.policyId || 'default-v1',
          latestEvidenceRunId: null,
          evidence: null,
          approvals: [],
          createdAt: now,
          updatedAt: now,
        })
        capabilities.push(capability)
        await write(capabilities)
        return { capability, reused: false }
      })
    },
    async update(id, updater) {
      return serialized(async () => {
        const capabilities = await read()
        const index = capabilities.findIndex((item) => item.id === id)
        if (index < 0) throw new EvaluationError('Capability was not found.', 404)
        const next = sanitizeCapability({ ...await updater(capabilities[index], capabilities), id, updatedAt: new Date().toISOString() })
        capabilities[index] = next
        await write(capabilities)
        return next
      })
    },
    async mutateAll(updater) {
      return serialized(async () => {
        const current = await read()
        const next = (await updater(current.map((item) => ({ ...item })))).map((item) => ({ ...item, updatedAt: item.updatedAt || new Date().toISOString() }))
        return write(next)
      })
    },
  }
}
