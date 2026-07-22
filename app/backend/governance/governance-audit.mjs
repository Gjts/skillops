import { randomUUID } from 'node:crypto'
import { appendFile, open, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { ARTIFACT_KINDS, ARTIFACT_SOURCES, normalizeArtifactDefinition } from '../../shared/evaluation-schema.mjs'
import { EvaluationError } from '../evaluations/errors.mjs'
import { CAPABILITY_STAGES } from './capability-registry.mjs'
import { withGovernanceFileLock } from './skeleton-lock.mjs'

const ACTIONS = new Set([
  'candidate.nominated', 'candidate.retracted', 'evidence.bound', 'approval.decided', 'canary.started',
  'stable.installed', 'stable.promoted', 'stable.deprecated', 'stable.superseded', 'stable.rolled-back', 'stable.restored',
])
const STAGES = new Set(CAPABILITY_STAGES)
const INPUT_FIELDS = new Set(['action', 'actor', 'capability', 'fromStage', 'toStage'])
const RECORD_FIELDS = new Set(['id', 'transactionId', 'outcome', 'action', 'actor', 'capabilityId', 'artifact', 'evidenceHash', 'fromStage', 'toStage', 'at'])
const ARTIFACT_FIELDS = new Set(['kind', 'artifactId', 'version', 'source', 'contentHash', 'gitCommit'])
const ALLOWED_ARTIFACT_KINDS = new Set(ARTIFACT_KINDS)
const ALLOWED_ARTIFACT_SOURCES = new Set(ARTIFACT_SOURCES)

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError(`${label} must be an object.`, 422)
  return value
}

function onlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) throw new EvaluationError(`${label} contains unsupported field: ${unknown[0]}.`, 422)
}

function text(value, label, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim()) throw new EvaluationError(`${label} is invalid.`, 422)
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (normalized.length > maxLength) throw new EvaluationError(`${label} is too long.`, 422)
  return normalized
}

function stage(value, label, optional = false) {
  if (optional && (value === null || value === undefined)) return null
  if (!STAGES.has(value)) throw new EvaluationError(`${label} is invalid.`, 422)
  return value
}

function artifactIdentity(value) {
  if (value?.sourceRef) {
    const artifact = normalizeArtifactDefinition(value)
    return {
      kind: artifact.kind,
      artifactId: artifact.artifactId,
      version: artifact.version,
      source: artifact.source,
      contentHash: artifact.contentHash,
      gitCommit: artifact.gitCommit || null,
    }
  }
  const artifact = object(value, 'Governance audit artifact')
  onlyKeys(artifact, ARTIFACT_FIELDS, 'Governance audit artifact')
  const kind = text(artifact.kind, 'Governance audit Artifact kind', 20)
  const source = text(artifact.source, 'Governance audit Artifact source', 20)
  const contentHash = text(artifact.contentHash, 'Governance audit Artifact content hash', 64)
  if (!ALLOWED_ARTIFACT_KINDS.has(kind) || !ALLOWED_ARTIFACT_SOURCES.has(source) || !/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new EvaluationError('Governance audit Artifact identity is invalid.', 500)
  }
  const gitCommit = artifact.gitCommit === null ? null : text(artifact.gitCommit, 'Governance audit Git commit', 64)
  if (gitCommit && !/^[a-f0-9]{40,64}$/i.test(gitCommit)) throw new EvaluationError('Governance audit Git commit is invalid.', 500)
  return {
    kind,
    artifactId: text(artifact.artifactId, 'Governance audit Artifact ID', 300),
    version: text(artifact.version, 'Governance audit Artifact version', 100),
    source,
    contentHash,
    gitCommit: gitCommit?.toLowerCase() || null,
  }
}

function persistedRecord(value) {
  const record = object(value, 'Governance audit record')
  onlyKeys(record, RECORD_FIELDS, 'Governance audit record')
  const at = text(record.at, 'Governance audit time', 100)
  if (Number.isNaN(Date.parse(at))) throw new EvaluationError('Governance audit time is invalid.', 500)
  const evidenceHash = record.evidenceHash === null ? null : text(record.evidenceHash, 'Governance audit evidence hash', 64)
  if (evidenceHash && !/^[a-f0-9]{64}$/.test(evidenceHash)) throw new EvaluationError('Governance audit evidence hash is invalid.', 500)
  if (!ACTIONS.has(record.action)) throw new EvaluationError('Governance audit action is invalid.', 500)
  const outcome = record.outcome || 'committed'
  if (!['pending', 'committed', 'failed'].includes(outcome)) throw new EvaluationError('Governance audit outcome is invalid.', 500)
  return {
    id: text(record.id, 'Governance audit ID'),
    transactionId: text(record.transactionId || record.id, 'Governance audit transaction ID'),
    outcome,
    action: record.action,
    actor: text(record.actor, 'Governance audit actor'),
    capabilityId: text(record.capabilityId, 'Governance audit capability ID'),
    artifact: artifactIdentity(record.artifact),
    evidenceHash,
    fromStage: stage(record.fromStage, 'Governance audit source stage', true),
    toStage: stage(record.toStage, 'Governance audit target stage'),
    at: new Date(at).toISOString(),
  }
}

function parseRecords(contents) {
  const records = []
  const lines = contents.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue
    try { records.push(persistedRecord(JSON.parse(lines[index]))) } catch (error) {
      if (index === lines.length - 1 || lines.slice(index + 1).every((line) => !line.trim())) break
      throw error
    }
  }
  return records
}

function collapseRecords(records) {
  const latest = new Map()
  for (const record of records) latest.set(record.transactionId, record)
  return [...latest.values()]
}

export function createGovernanceAuditLog(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.SKILLOPS_DATA_DIR || path.join(process.cwd(), 'data'))
  const file = path.join(dataDir, 'governance-audit.jsonl')
  const lockFile = path.join(dataDir, 'governance-audit.lock')
  let queue = Promise.resolve()

  async function read() {
    try { return parseRecords(await readFile(file, 'utf8')) } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  async function repairTrailingRecord() {
    let handle
    try {
      handle = await open(file, 'r+')
      const [info, resolved] = await Promise.all([handle.stat(), stat(file)])
      if (info.dev !== resolved.dev || info.ino !== resolved.ino) throw new EvaluationError('Governance audit file changed during repair.', 409)
      if (!info.size) return
      const last = Buffer.alloc(1)
      await handle.read(last, 0, 1, info.size - 1)
      if (last[0] === 10) return
      const contents = await readFile(file, 'utf8')
      const lastNewline = contents.lastIndexOf('\n')
      const trailing = contents.slice(lastNewline + 1)
      try {
        persistedRecord(JSON.parse(trailing))
        await appendFile(file, '\n', 'utf8')
      } catch {
        await handle.truncate(Buffer.byteLength(contents.slice(0, lastNewline + 1), 'utf8'))
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    } finally { await handle?.close() }
  }

  function withLock(operation) {
    return withGovernanceFileLock(lockFile, operation)
  }

  function serialized(operation) {
    const pending = queue.then(() => withLock(operation))
    queue = pending.catch(() => undefined)
    return pending
  }

  async function appendRecord(record) {
    await serialized(async () => {
      await repairTrailingRecord()
      const handle = await open(file, 'a')
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
        await handle.sync()
      } finally { await handle.close() }
    })
    return record
  }

  async function prepare(value) {
    const input = object(value, 'Governance audit input')
    onlyKeys(input, INPUT_FIELDS, 'Governance audit input')
    if (!ACTIONS.has(input.action)) throw new EvaluationError('Governance audit action is invalid.', 422)
    const capability = object(input.capability, 'Governance audit capability')
    const transactionId = `governance_${randomUUID()}`
    return appendRecord(persistedRecord({
      id: `audit_${randomUUID()}`,
      transactionId,
      outcome: 'pending',
      action: input.action,
      actor: text(input.actor, 'Governance audit actor'),
      capabilityId: text(capability.id, 'Governance audit capability ID'),
      artifact: artifactIdentity(capability.artifact),
      evidenceHash: capability.evidence?.evidenceHash || null,
      fromStage: stage(input.fromStage, 'Governance audit source stage', true),
      toStage: stage(input.toStage, 'Governance audit target stage'),
      at: new Date().toISOString(),
    }))
  }

  async function finish(prepared, outcome) {
    const previous = persistedRecord(prepared)
    if (previous.outcome !== 'pending') throw new EvaluationError('Governance audit transaction is not pending.', 409)
    return appendRecord(persistedRecord({
      ...previous,
      id: `audit_${randomUUID()}`,
      outcome,
      at: new Date().toISOString(),
    }))
  }

  return {
    file,
    prepare,
    commit: (prepared) => finish(prepared, 'committed'),
    fail: (prepared) => finish(prepared, 'failed'),
    async append(value) {
      const prepared = await prepare(value)
      return finish(prepared, 'committed')
    },
    async pending() {
      return collapseRecords(await read()).filter((entry) => entry.outcome === 'pending')
    },
    async list(filters = {}) {
      const capabilityId = filters.capabilityId ? text(filters.capabilityId, 'Capability ID') : null
      const limit = Math.min(1_000, Math.max(1, Number(filters.limit) || 100))
      return collapseRecords(await read()).filter((entry) => !capabilityId || entry.capabilityId === capabilityId).reverse().slice(0, limit)
    },
  }
}
