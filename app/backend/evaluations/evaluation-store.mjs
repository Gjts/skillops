import { createHash } from 'node:crypto'
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeArtifactDefinition } from '../../shared/evaluation-schema.mjs'
import { EvaluationError } from './errors.mjs'
import { canonicalJson } from './suite-registry.mjs'
import { withGovernanceFileLock } from '../governance/skeleton-lock.mjs'

const RUN_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'])
const RUN_MODES = new Set(['quick', 'suite', 'redteam'])
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const DEFAULT_WARNING_BYTES = 50 * 1024 * 1024

function text(value, label, maxLength = 4_000, { optional = false } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null
  if (typeof value !== 'string' || !value.trim()) throw new EvaluationError(`${label} is invalid.`, 500)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new EvaluationError(`${label} is too long.`, 500)
  return normalized
}

function nullableNumber(value, label) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new EvaluationError(`${label} is invalid.`, 500)
  return value
}

function iso(value, label, optional = false) {
  if ((value === undefined || value === null) && optional) return null
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new EvaluationError(`${label} is invalid.`, 500)
  return new Date(value).toISOString()
}

function sanitizeMetrics(value) {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError('Evaluation metrics are invalid.', 500)
  return {
    baselineScore: nullableNumber(value.baselineScore, 'Baseline score'),
    candidateScore: nullableNumber(value.candidateScore, 'Candidate score'),
    scoreDeltaPp: value.scoreDeltaPp === null || value.scoreDeltaPp === undefined ? null : value.scoreDeltaPp,
    casesPassed: nullableNumber(value.casesPassed, 'Cases passed'),
    casesTotal: nullableNumber(value.casesTotal, 'Cases total'),
    passRatePct: nullableNumber(value.passRatePct, 'Pass rate'),
    regressionRatePct: nullableNumber(value.regressionRatePct, 'Regression rate'),
    baselineTokens: nullableNumber(value.baselineTokens, 'Baseline tokens'),
    candidateTokens: nullableNumber(value.candidateTokens, 'Candidate tokens'),
    baselineCostUsd: nullableNumber(value.baselineCostUsd, 'Baseline cost'),
    candidateCostUsd: nullableNumber(value.candidateCostUsd, 'Candidate cost'),
    costDeltaPct: value.costDeltaPct === null || value.costDeltaPct === undefined ? null : value.costDeltaPct,
    baselineP95LatencyMs: nullableNumber(value.baselineP95LatencyMs, 'Baseline latency'),
    candidateP95LatencyMs: nullableNumber(value.candidateP95LatencyMs, 'Candidate latency'),
    latencyDeltaPct: value.latencyDeltaPct === null || value.latencyDeltaPct === undefined ? null : value.latencyDeltaPct,
    attackSuccessRatePct: nullableNumber(value.attackSuccessRatePct, 'Attack success rate'),
    criticalFindings: nullableNumber(value.criticalFindings, 'Critical findings'),
    highFindings: nullableNumber(value.highFindings, 'High findings'),
  }
}

function ensureFiniteSigned(value, label) {
  if (value !== null && (!Number.isFinite(value))) throw new EvaluationError(`${label} is invalid.`, 500)
}

function migrateLegacyArtifact(value) {
  if (value?.source !== 'github' || typeof value.sourceRef !== 'string') return value
  try {
    normalizeArtifactDefinition(value)
    return value
  } catch {
    const reference = value.sourceRef
    if (!reference.startsWith('github:https://') || reference.length > 4_000 || /[\u0000\r\n]/.test(reference)) return value
    return {
      ...value,
      source: 'local-scan',
      sourceRef: `local-scan:legacy-github:${createHash('sha256').update(reference, 'utf8').digest('hex')}`,
      gitCommit: undefined,
      repository: undefined,
    }
  }
}

function persistedSummary(record) {
  if (record.schemaVersion === 2) return record.summary
  if (record.schemaVersion !== undefined && record.schemaVersion !== 1) {
    throw new EvaluationError('Evaluation store record schema is unsupported.', 500)
  }
  return {
    ...record.summary,
    baseline: migrateLegacyArtifact(record.summary?.baseline),
    candidate: migrateLegacyArtifact(record.summary?.candidate),
  }
}

export function sanitizePersistedArtifact(value) {
  const artifact = normalizeArtifactDefinition(value)
  if (artifact.source !== 'local-scan') return artifact
  const match = /^local-scan:([^:]+):(.+)$/.exec(artifact.sourceRef)
  if (!match || match[2].startsWith('sha256:')) return artifact
  return {
    ...artifact,
    sourceRef: `local-scan:${match[1]}:sha256:${createHash('sha256').update(artifact.sourceRef, 'utf8').digest('hex')}`,
  }
}

export function sanitizeEvaluationRunSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError('Evaluation run summary is invalid.', 500)
  if (!RUN_STATUSES.has(value.status)) throw new EvaluationError('Evaluation run status is invalid.', 500)
  if (!RUN_MODES.has(value.mode)) throw new EvaluationError('Evaluation run mode is invalid.', 500)
  const metrics = sanitizeMetrics(value.metrics)
  if (metrics) {
    ensureFiniteSigned(metrics.scoreDeltaPp, 'Score delta')
    ensureFiniteSigned(metrics.costDeltaPct, 'Cost delta')
    ensureFiniteSigned(metrics.latencyDeltaPct, 'Latency delta')
  }
  const engine = value.engine && typeof value.engine === 'object' && !Array.isArray(value.engine) ? value.engine : {}
  const provider = value.provider && typeof value.provider === 'object' && !Array.isArray(value.provider) ? value.provider : {}
  let providerModels
  if (provider.models !== undefined) {
    if (!Array.isArray(provider.models) || !provider.models.length || provider.models.length > 8) throw new EvaluationError('Provider models are invalid.', 500)
    providerModels = provider.models.map((model) => text(model, 'Provider model', 200))
  }
  const configurationHash = provider.configurationHash === undefined ? undefined : text(provider.configurationHash, 'Provider configuration hash', 64)
  if (configurationHash && !/^[a-f0-9]{64}$/.test(configurationHash)) throw new EvaluationError('Provider configuration hash is invalid.', 500)
  return {
    id: text(value.id, 'Run ID', 200),
    mode: value.mode,
    status: value.status,
    capabilityId: value.capabilityId === undefined ? undefined : text(value.capabilityId, 'Capability ID', 200),
    subjectHash: value.subjectHash === undefined || value.subjectHash === null ? null : text(value.subjectHash, 'Evaluation subject hash', 64),
    suiteId: value.suiteId === undefined ? undefined : text(value.suiteId, 'Suite ID', 120),
    suiteVersion: value.suiteVersion === undefined ? undefined : text(value.suiteVersion, 'Suite version', 100),
    suiteHash: value.suiteHash === undefined || value.suiteHash === null ? null : text(value.suiteHash, 'Suite hash', 64),
    datasetHash: value.datasetHash === undefined || value.datasetHash === null ? null : text(value.datasetHash, 'Dataset hash', 64),
    casesHash: value.casesHash === undefined || value.casesHash === null ? null : text(value.casesHash, 'Cases hash', 64),
    baseline: sanitizePersistedArtifact(value.baseline),
    candidate: sanitizePersistedArtifact(value.candidate),
    engine: { name: text(engine.name, 'Engine name', 50), version: text(engine.version, 'Engine version', 100) },
    provider: { id: text(provider.id, 'Provider ID', 100), model: text(provider.model, 'Provider model', 200), ...(providerModels ? { models: providerModels } : {}), ...(configurationHash ? { configurationHash } : {}) },
    metrics,
    policyHash: value.policyHash === undefined || value.policyHash === null ? null : text(value.policyHash, 'Policy hash', 64),
    gates: Array.isArray(value.gates) ? value.gates.map((gate) => ({
      id: text(gate.id, 'Gate ID', 100),
      status: ['passed', 'failed', 'not-available'].includes(gate.status) ? gate.status : 'failed',
      blocking: Boolean(gate.blocking),
    })) : [],
    evidenceHash: value.evidenceHash === undefined || value.evidenceHash === null ? null : text(value.evidenceHash, 'Evidence hash', 64),
    gateResult: ['passed', 'failed', 'not-evaluated'].includes(value.gateResult) ? value.gateResult : 'not-evaluated',
    requestedBy: text(value.requestedBy, 'Requested by', 200),
    requestedAt: iso(value.requestedAt, 'Requested at'),
    startedAt: iso(value.startedAt, 'Started at', true),
    completedAt: iso(value.completedAt, 'Completed at', true),
    errorCode: value.errorCode === undefined || value.errorCode === null ? null : text(value.errorCode, 'Error code', 100),
  }
}

export function sanitizeEvaluationCases(value) {
  if (!Array.isArray(value) || value.length > 1_000) throw new EvaluationError('Evaluation case summaries are invalid.', 500)
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new EvaluationError('Evaluation case summary is invalid.', 500)
    const variant = (entry, label) => ({
      pass: Boolean(entry?.pass),
      score: nullableNumber(entry?.score, `${label} score`),
      assertions: Array.isArray(entry?.assertions) ? entry.assertions.map((assertion) => ({
        label: text(assertion.label, 'Assertion label', 200),
        type: text(assertion.type, 'Assertion type', 50),
        blocking: Boolean(assertion.blocking),
        pass: Boolean(assertion.pass),
        score: nullableNumber(assertion.score, 'Assertion score'),
      })) : [],
    })
    const hasMatrixId = item.matrixId !== undefined
    if (hasMatrixId !== (item.model !== undefined)) throw new EvaluationError('Evaluation matrix case identity is incomplete.', 500)
    return {
      id: text(item.id, 'Case summary ID', 200),
      caseId: text(item.caseId, 'Case ID', 120),
      repeat: nullableNumber(item.repeat, 'Case repeat'),
      weight: nullableNumber(item.weight, 'Case weight'),
      ...(hasMatrixId ? { matrixId: text(item.matrixId, 'Evaluation matrix ID', 120), model: text(item.model, 'Evaluation matrix model', 200) } : {}),
      baseline: variant(item.baseline, 'Baseline'),
      candidate: variant(item.candidate, 'Candidate'),
    }
  })
}

export function computeEvaluationCasesHash(cases) {
  return createHash('sha256').update(canonicalJson(sanitizeEvaluationCases(cases)), 'utf8').digest('hex')
}

export function computeEvaluationEvidenceHash(summary) {
  const normalized = sanitizeEvaluationRunSummary({ ...summary, evidenceHash: null })
  if (normalized.status !== 'completed') return null
  return createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex')
}

function parseRecords(contents) {
  const lines = contents.split('\n')
  const records = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue
    try { records.push(JSON.parse(line)) } catch {
      throw new EvaluationError('Evaluation store contains a malformed record.', 500)
    }
  }
  return records
}

export function createEvaluationStore(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.SKILLOPS_DATA_DIR || path.join(process.cwd(), 'data'))
  const storeFile = path.join(dataDir, 'evaluations.jsonl')
  const indexFile = path.join(dataDir, 'evaluation-index.json')
  const lockFile = path.join(dataDir, 'evaluations.lock')
  const warningBytes = options.warningBytes || DEFAULT_WARNING_BYTES
  let queue = Promise.resolve()

  async function records() {
    try { return parseRecords(await readFile(storeFile, 'utf8')) } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  async function latestState() {
    const runs = new Map()
    const cases = new Map()
    for (const record of await records()) {
      if (record?.schemaVersion !== undefined && ![1, 2].includes(record.schemaVersion)) {
        throw new EvaluationError('Evaluation store record schema is unsupported.', 500)
      }
      if (record?.type === 'run') runs.set(record.summary?.id, sanitizeEvaluationRunSummary(persistedSummary(record)))
      else if (record?.type === 'cases') cases.set(record.runId, sanitizeEvaluationCases(record.cases))
    }
    for (const run of runs.values()) {
      if (run.status !== 'completed' || !run.casesHash) continue
      const persistedCases = cases.get(run.id)
      if (!persistedCases || computeEvaluationCasesHash(persistedCases) !== run.casesHash) {
        throw new EvaluationError('Evaluation store case evidence does not match its immutable summary.', 500)
      }
    }
    return { runs, cases }
  }

  async function repairTrailingNewline() {
    try {
      const contents = await readFile(storeFile, 'utf8')
      if (contents && !contents.endsWith('\n')) await appendFile(storeFile, '\n', 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  function withLock(operation) {
    return withGovernanceFileLock(lockFile, operation, options.lockAttempts || 100, 'evaluation store')
  }

  function serialized(operation) {
    const pending = queue.then(() => withLock(operation))
    queue = pending.catch(() => undefined)
    return pending
  }

  async function writeIndex() {
    const { runs } = await latestState()
    const index = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      runs: [...runs.values()].map((run) => ({ id: run.id, status: run.status, requestedAt: run.requestedAt })),
    }
    const temporary = `${indexFile}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(index)}\n`, 'utf8')
    await rename(temporary, indexFile)
  }

  async function appendRecord(record) {
    await latestState()
    await repairTrailingNewline()
    await appendFile(storeFile, `${JSON.stringify({ schemaVersion: 2, ...record })}\n`, 'utf8')
    await writeIndex()
  }

  return {
    dataDir,
    storeFile,
    async appendRun(summary) {
      const sanitized = sanitizeEvaluationRunSummary(summary)
      await serialized(() => appendRecord({ type: 'run', summary: sanitized }))
      return sanitized
    },
    async writeCases(runId, caseSummaries) {
      const id = text(runId, 'Run ID', 200)
      const sanitized = sanitizeEvaluationCases(caseSummaries)
      await serialized(async () => {
        const run = (await latestState()).runs.get(id)
        if (run?.status === 'completed') throw new EvaluationError('Completed evaluation case evidence is immutable.', 409)
        await appendRecord({ type: 'cases', runId: id, cases: sanitized })
      })
      return sanitized
    },
    async getRun(runId) {
      return (await latestState()).runs.get(runId) || null
    },
    async getCases(runId) {
      return (await latestState()).cases.get(runId) || []
    },
    async listRuns(filters = {}) {
      const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20))
      let items = [...(await latestState()).runs.values()]
        .filter((run) => !filters.status || run.status === filters.status)
        .filter((run) => !filters.suiteId || run.suiteId === filters.suiteId)
        .filter((run) => !filters.capabilityId || run.capabilityId === filters.capabilityId)
        .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt) || right.id.localeCompare(left.id))
      if (filters.cursor) {
        const index = items.findIndex((run) => run.id === filters.cursor)
        items = index < 0 ? [] : items.slice(index + 1)
      }
      const page = items.slice(0, limit)
      return { items: page, nextCursor: items.length > limit ? page.at(-1).id : null }
    },
    async interruptRunning() {
      const unfinished = [...(await latestState()).runs.values()].filter((run) => run.status === 'queued' || run.status === 'running')
      for (const run of unfinished) {
        await serialized(() => appendRecord({ type: 'run', summary: sanitizeEvaluationRunSummary({
          ...run,
          status: 'interrupted',
          completedAt: new Date().toISOString(),
          errorCode: 'PROCESS_RESTARTED',
          evidenceHash: null,
          gateResult: 'not-evaluated',
        }) }))
      }
      return unfinished.length
    },
    async pruneBefore(cutoff, { preserveRunIds = [], backup = true } = {}) {
      const cutoffMs = cutoff instanceof Date ? cutoff.getTime() : Date.parse(cutoff)
      if (!Number.isFinite(cutoffMs)) throw new EvaluationError('Evaluation retention cutoff is invalid.', 422)
      if (!Array.isArray(preserveRunIds) || preserveRunIds.some((id) => typeof id !== 'string' || !id)) {
        throw new EvaluationError('Preserved evaluation run IDs are invalid.', 422)
      }
      const preserved = new Set(preserveRunIds)
      return serialized(async () => {
        const { runs } = await latestState()
        const removedRunIds = new Set([...runs.values()]
          .filter((run) => TERMINAL_STATUSES.has(run.status) && Date.parse(run.requestedAt) < cutoffMs && !preserved.has(run.id))
          .map((run) => run.id))
        let removedRecords = 0
        let backupFile
        if (removedRunIds.size) {
          const all = await records()
          const kept = all.filter((record) => {
            const runId = record?.type === 'run' ? record.summary?.id : record?.type === 'cases' ? record.runId : null
            if (!removedRunIds.has(runId)) return true
            removedRecords += 1
            return false
          })
          const suffix = new Date().toISOString().replace(/[:.]/g, '-')
          backupFile = backup ? `${storeFile}.backup-${suffix}` : undefined
          if (backupFile) await copyFile(storeFile, backupFile)
          const temporary = `${storeFile}.${process.pid}.retention.tmp`
          try {
            await writeFile(temporary, kept.length ? `${kept.map(JSON.stringify).join('\n')}\n` : '', 'utf8')
            await rename(temporary, storeFile)
          } finally {
            await rm(temporary, { force: true })
          }
          await writeIndex()
        }
        let removedBackups = 0
        for (const entry of await readdir(dataDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.startsWith('evaluations.jsonl.backup-')) continue
          const candidate = path.join(dataDir, entry.name)
          if (candidate === backupFile) continue
          if ((await stat(candidate)).mtimeMs >= cutoffMs) continue
          await rm(candidate)
          removedBackups += 1
        }
        return {
          removedRuns: removedRunIds.size,
          removedRecords,
          retainedRuns: runs.size - removedRunIds.size,
          removedBackups,
          backupFile,
        }
      })
    },
    async health() {
      const info = await stat(storeFile).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
      const sizeBytes = info?.size || 0
      return { sizeBytes, warningBytes, warning: sizeBytes >= warningBytes, automaticDeletion: false }
    },
    isTerminal(status) { return TERMINAL_STATUSES.has(status) },
  }
}
