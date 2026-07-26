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
const MANAGED_DECISIONS = new Set(['create-candidate', 'keep-baseline', 'reject-candidate', 'collect-more-evidence'])
const DEFAULT_WARNING_BYTES = 50 * 1024 * 1024
const RECORD_FIELDS = Object.freeze({
  run: new Set(['schemaVersion', 'type', 'summary']),
  cases: new Set(['schemaVersion', 'type', 'runId', 'cases']),
  decision: new Set(['schemaVersion', 'type', 'decision']),
})

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
  const casesTotal = nullableNumber(value.casesTotal, 'Cases total')
  const eligibleCases = nullableNumber(value.eligibleCases, 'Eligible cases')
  if (eligibleCases !== null && (!Number.isInteger(eligibleCases) || eligibleCases < 1)) throw new EvaluationError('Eligible cases is invalid.', 500)
  return {
    baselineScore: nullableNumber(value.baselineScore, 'Baseline score'),
    candidateScore: nullableNumber(value.candidateScore, 'Candidate score'),
    scoreDeltaPp: value.scoreDeltaPp === null || value.scoreDeltaPp === undefined ? null : value.scoreDeltaPp,
    casesPassed: nullableNumber(value.casesPassed, 'Cases passed'),
    casesTotal,
    eligibleCases,
    suiteCaseCoveragePct: casesTotal !== null && eligibleCases !== null ? casesTotal / eligibleCases * 100 : null,
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
  if ([2, 3].includes(record.schemaVersion)) return record.summary
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

function sanitizeEvaluationDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError('Evaluation decision record is invalid.', 500)
  const evaluationRunId = text(value.evaluationRunId ?? value.runId, 'Decision run ID', 200)
  const artifactId = text(value.artifactId, 'Decision Artifact ID', 300)
  const candidateRefHash = text(value.candidateRefHash ?? value.candidateHash, 'Decision candidate hash', 64)
  if (!/^[a-f0-9]{64}$/.test(candidateRefHash) || !MANAGED_DECISIONS.has(value.decision)) {
    throw new EvaluationError('Evaluation decision record is invalid.', 500)
  }
  const decisionId = `decision_${createHash('sha256').update(canonicalJson({
    evaluationRunId,
    artifactId,
    candidateRefHash,
    decision: value.decision,
  }), 'utf8').digest('hex')}`
  if (value.decisionId !== undefined && text(value.decisionId, 'Decision ID', 100) !== decisionId) {
    throw new EvaluationError('Evaluation decision record is invalid.', 500)
  }
  return {
    decisionId,
    evaluationRunId,
    artifactId,
    candidateRefHash,
    decision: value.decision,
    recordedAt: iso(value.recordedAt ?? value.decidedAt, 'Decision time'),
  }
}

function parseRecords(contents) {
  const lines = contents.split('\n')
  const records = []
  let sourceStatus = 'ok'
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue
    let record
    try { record = JSON.parse(line) } catch (error) {
      const position = Number(error?.message?.match(/position (\d+)/)?.[1])
      const incomplete = line.trimStart().startsWith('{')
        && (error?.message === 'Unexpected end of JSON input'
          || error?.message?.startsWith('Unterminated string')
          || Number.isInteger(position) && position >= line.length)
      if (!contents.endsWith('\n') && incomplete && lines.slice(index + 1).every((candidate) => !candidate.trim())) {
        sourceStatus = 'partial'
        break
      }
      throw new EvaluationError('Evaluation store contains a malformed record.', 500)
    }
    const allowed = record && typeof record === 'object' && !Array.isArray(record) ? RECORD_FIELDS[record.type] : null
    const payloadIsValid = record?.type === 'run'
      ? record.summary && typeof record.summary === 'object' && !Array.isArray(record.summary)
      : record?.type === 'cases'
        ? typeof record.runId === 'string' && Boolean(record.runId) && Array.isArray(record.cases)
        : record?.type === 'decision'
          ? record.decision && typeof record.decision === 'object' && !Array.isArray(record.decision)
          : false
    if (!allowed || record.schemaVersion !== undefined && ![1, 2, 3].includes(record.schemaVersion)
      || Object.keys(record).some((key) => !allowed.has(key)) || !payloadIsValid) {
      throw new EvaluationError('Evaluation store contains a malformed record.', 500)
    }
    records.push(record)
  }
  return { records, sourceStatus }
}

export function createEvaluationStore(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.SKILLOPS_DATA_DIR || path.join(process.cwd(), 'data'))
  const storeFile = path.join(dataDir, 'evaluations.jsonl')
  const lockFile = path.join(dataDir, 'evaluations.lock')
  const warningBytes = options.warningBytes || DEFAULT_WARNING_BYTES
  let queue = Promise.resolve()

  async function records() {
    try { return parseRecords(await readFile(storeFile, 'utf8')) } catch (error) {
      if (error?.code === 'ENOENT') return { records: [], sourceStatus: 'ok' }
      throw error
    }
  }

  async function latestState() {
    const runs = new Map()
    const cases = new Map()
    const decisions = new Map()
    const snapshot = await records()
    for (const record of snapshot.records) {
      if (record?.schemaVersion !== undefined && ![1, 2, 3].includes(record.schemaVersion)) {
        throw new EvaluationError('Evaluation store record schema is unsupported.', 500)
      }
      if (record?.type === 'run') runs.set(record.summary?.id, sanitizeEvaluationRunSummary(persistedSummary(record)))
      else if (record?.type === 'cases') cases.set(record.runId, sanitizeEvaluationCases(record.cases))
      else if (record?.type === 'decision') {
        const decision = sanitizeEvaluationDecision(record.decision)
        const history = decisions.get(decision.evaluationRunId) || []
        history.push(decision)
        decisions.set(decision.evaluationRunId, history)
      }
    }
    for (const run of runs.values()) {
      if (run.status !== 'completed' || !run.casesHash) continue
      const persistedCases = cases.get(run.id)
      if (!persistedCases || computeEvaluationCasesHash(persistedCases) !== run.casesHash) {
        throw new EvaluationError('Evaluation store case evidence does not match its immutable summary.', 500)
      }
    }
    for (const [runId, history] of decisions) {
      const run = runs.get(runId)
      if (!run || history.some((decision) => decision.artifactId !== run.candidate.artifactId || decision.candidateRefHash !== run.candidate.contentHash)) {
        throw new EvaluationError('Evaluation decision does not match its authoritative run.', 500)
      }
    }
    return { runs, cases, decisions, sourceStatus: snapshot.sourceStatus }
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

  async function appendRecord(record) {
    const state = await latestState()
    if (state.sourceStatus === 'partial') {
      throw new EvaluationError('Evaluation store has a partial trailing record; no data was changed.', 409)
    }
    await repairTrailingNewline()
    await appendFile(storeFile, `${JSON.stringify({ schemaVersion: 3, ...record })}\n`, 'utf8')
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
    async appendDecision(runId, decision) {
      const id = text(runId, 'Run ID', 200)
      if (!MANAGED_DECISIONS.has(decision)) throw new EvaluationError('Managed evaluation decision is invalid.', 422)
      return serialized(async () => {
        const state = await latestState()
        const run = state.runs.get(id)
        if (!run) throw new EvaluationError('Evaluation run was not found.', 404)
        if (run.mode !== 'suite' || run.status !== 'completed' || !run.evidenceHash) {
          throw new EvaluationError('Only completed Managed Suite evidence can receive a decision.', 409)
        }
        const previous = state.decisions.get(id)?.at(-1)
        if (previous?.decision === decision) return { decision: previous, reused: true }
        if (previous) throw new EvaluationError('This Managed Suite run already has a final decision. Start a new run to change it.', 409)
        const record = sanitizeEvaluationDecision({
          evaluationRunId: id,
          artifactId: run.candidate.artifactId,
          candidateRefHash: run.candidate.contentHash,
          decision,
          recordedAt: new Date().toISOString(),
        })
        await appendRecord({ type: 'decision', decision: record })
        return { decision: record, reused: false }
      })
    },
    async getDecision(runId) {
      return (await latestState()).decisions.get(runId)?.at(-1) || null
    },
    async listRuns(filters = {}) {
      const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20))
      const state = await latestState()
      let items = [...state.runs.values()]
        .filter((run) => !filters.status || run.status === filters.status)
        .filter((run) => !filters.suiteId || run.suiteId === filters.suiteId)
        .filter((run) => !filters.capabilityId || run.capabilityId === filters.capabilityId)
        .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt) || right.id.localeCompare(left.id))
      if (filters.cursor) {
        const index = items.findIndex((run) => run.id === filters.cursor)
        items = index < 0 ? [] : items.slice(index + 1)
      }
      const page = items.slice(0, limit)
      return { items: page, nextCursor: items.length > limit ? page.at(-1).id : null, sourceStatus: state.sourceStatus }
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
    async pruneBefore(cutoff, { preserveRunIds = [], backup = true, deferBackupCleanup = false } = {}) {
      const cutoffMs = cutoff instanceof Date ? cutoff.getTime() : Date.parse(cutoff)
      if (!Number.isFinite(cutoffMs)) throw new EvaluationError('Evaluation retention cutoff is invalid.', 422)
      if (!Array.isArray(preserveRunIds) || preserveRunIds.some((id) => typeof id !== 'string' || !id)) {
        throw new EvaluationError('Preserved evaluation run IDs are invalid.', 422)
      }
      const preserved = new Set(preserveRunIds)
      return serialized(async () => {
        const state = await latestState()
        if (state.sourceStatus === 'partial') {
          throw new EvaluationError('Evaluation store has a partial trailing record; no data was changed.', 409)
        }
        const { runs } = state
        const removedRunIds = new Set([...runs.values()]
          .filter((run) => TERMINAL_STATUSES.has(run.status) && Date.parse(run.requestedAt) < cutoffMs && !preserved.has(run.id))
          .map((run) => run.id))
        let removedRecords = 0
        let backupFile
        const expiredBackupFiles = []
        for (const entry of await readdir(dataDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.startsWith('evaluations.jsonl.backup-')) continue
          const candidate = path.join(dataDir, entry.name)
          if ((await stat(candidate)).mtimeMs < cutoffMs) expiredBackupFiles.push(candidate)
        }
        let removedBackups = 0
        if (!deferBackupCleanup) {
          for (const candidate of expiredBackupFiles) {
            await rm(candidate)
            removedBackups += 1
          }
        }
        let postimage = ''
        if (removedRunIds.size) {
          const all = await records()
          const kept = all.records.filter((record) => {
            const runId = record?.type === 'run'
              ? record.summary?.id
              : ['cases', 'decision'].includes(record?.type)
                ? record.runId || record.decision?.evaluationRunId || record.decision?.runId
                : null
            if (!removedRunIds.has(runId)) return true
            removedRecords += 1
            return false
          })
          const preimage = await readFile(storeFile, 'utf8')
          postimage = kept.length ? `${kept.map(JSON.stringify).join('\n')}\n` : ''
          const suffix = new Date().toISOString().replace(/[:.]/g, '-')
          backupFile = backup ? `${storeFile}.backup-${suffix}` : undefined
          if (backupFile) await copyFile(storeFile, backupFile)
          const temporary = `${storeFile}.${process.pid}.retention.tmp`
          try {
            await writeFile(temporary, postimage, 'utf8')
            await rename(temporary, storeFile)
          } catch (error) {
            const recovery = `${storeFile}.${process.pid}.recovery.tmp`
            try {
              await writeFile(recovery, preimage, 'utf8')
              await rename(recovery, storeFile)
            } catch (recoveryError) {
              const failure = new AggregateError([error, recoveryError], 'Evaluation retention failed and automatic recovery was incomplete.')
              failure.retentionRecovery = { store: 'evaluations', backupFile, recoveryPostimage: postimage }
              throw failure
            } finally {
              await rm(recovery, { force: true }).catch(() => undefined)
            }
            throw error
          } finally {
            await rm(temporary, { force: true }).catch(() => undefined)
          }
        }
        return {
          removedRuns: removedRunIds.size,
          removedRecords,
          retainedRuns: runs.size - removedRunIds.size,
          removedBackups,
          backupFile,
          ...(deferBackupCleanup ? { expiredBackupFiles, recoveryPostimage: postimage } : {}),
        }
      })
    },
    async health() {
      const info = await stat(storeFile).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
      const sizeBytes = info?.size || 0
      const sourceStatus = (await records()).sourceStatus
      return { sizeBytes, warningBytes, warning: sizeBytes >= warningBytes, automaticDeletion: false, sourceStatus }
    },
    isTerminal(status) { return TERMINAL_STATUSES.has(status) },
  }
}
