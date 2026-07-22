import { randomUUID } from 'node:crypto'
import { normalizeArtifactDefinition } from '../../shared/evaluation-schema.mjs'
import { DEFAULT_GATE_POLICY, evaluateGatePolicy, evaluateRedteamGatePolicy } from '../governance/capability-policy.mjs'
import { EvaluationError } from './errors.mjs'
import { computeEvaluationCasesHash, computeEvaluationEvidenceHash } from './evaluation-store.mjs'
import { normalizeProvider } from './provider-client.mjs'
import { PROMPTFOO_VERSION } from './promptfoo-runtime.mjs'
import { runPromptfooRedteam, runPromptfooSuite } from './promptfoo-runner.mjs'
import { sha256Json } from './suite-registry.mjs'

const MAX_CONCURRENCY = 4
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const MAX_TIMEOUT_MS = 60 * 60_000

function normalizeTimeout(value) {
  const timeoutMs = value === undefined ? DEFAULT_TIMEOUT_MS : Number(value)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new EvaluationError(`Evaluation timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds.`, 422)
  }
  return timeoutMs
}


function normalizeConcurrency(value) {
  const concurrency = value === undefined ? 1 : Number(value)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new EvaluationError(`Evaluation concurrency must be between 1 and ${MAX_CONCURRENCY}.`, 422)
  }
  return concurrency
}

function optionalId(value, label) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw new EvaluationError(`${label} is invalid.`, 422)
  return value.trim()
}

function optionalHash(value, label) {
  const normalized = optionalId(value, label)
  if (normalized && !/^[a-f0-9]{64}$/.test(normalized)) throw new EvaluationError(`${label} must be a SHA-256 hash.`, 422)
  return normalized
}

function providerConfigurationHash(input, provider) {
  return sha256Json({
    provider: provider.provider,
    transport: provider.transport,
    baseUrl: provider.baseUrl,
    apiVersion: provider.apiVersion,
    reasoningEffort: provider.reasoningEffort || null,
    models: input.suite.matrix?.models.map((entry) => entry.model) || [provider.model],
  })
}

function activeFingerprint(input, baseline, candidate, configurationHash) {
  return [
    candidate.contentHash,
    input.suite.suiteHash,
    input.suite.datasetHash || '',
    baseline.contentHash,
    input.subjectHash || '',
    configurationHash,
  ].join(':')
}

function errorCode(error) {
  if (error?.name === 'AbortError') return 'CANCELLED'
  if (error instanceof EvaluationError && error.status === 422) return 'INVALID_EVALUATION'
  if (error instanceof EvaluationError && error.status === 429) return 'PROVIDER_RATE_LIMITED'
  return 'EVALUATION_FAILED'
}

function queuedSummary(input, id, baseline, candidate, provider, configurationHash, requestedAt) {
  return {
    id,
    mode: input.mode || 'suite',
    status: 'queued',
    capabilityId: optionalId(input.capabilityId, 'Capability ID') || undefined,
    subjectHash: optionalHash(input.subjectHash, 'Evaluation subject hash'),
    suiteId: input.suite.id,
    suiteVersion: input.suite.version,
    suiteHash: input.suite.suiteHash,
    datasetHash: input.suite.datasetHash || null,
    casesHash: null,
    baseline,
    candidate,
    engine: { name: 'promptfoo', version: PROMPTFOO_VERSION },
    provider: input.suite.matrix
      ? { id: provider.id || provider.provider, model: input.suite.matrix.models.length === 1 ? input.suite.matrix.models[0].model : 'matrix', models: input.suite.matrix.models.map((entry) => entry.model), configurationHash }
      : { id: provider.id || provider.provider, model: provider.model, configurationHash },
    metrics: null,
    policyHash: null,
    gates: [],
    evidenceHash: null,
    gateResult: 'not-evaluated',
    requestedBy: optionalId(input.requestedBy, 'Requested by') || 'local-user',
    requestedAt,
    startedAt: null,
    completedAt: null,
    errorCode: null,
  }
}

export function createEvaluationManager(options = {}) {
  if (!options.store) throw new EvaluationError('Evaluation store is required.', 500)
  const store = options.store
  const runner = options.runner || ((input, runnerOptions) => input.mode === 'redteam'
    ? runPromptfooRedteam(input, runnerOptions)
    : runPromptfooSuite(input, runnerOptions))
  const policy = options.policy || DEFAULT_GATE_POLICY
  const concurrency = normalizeConcurrency(options.concurrency)
  const timeoutMs = normalizeTimeout(options.timeoutMs)
  const waiting = []
  const jobs = new Map()
  const idempotency = new Map()
  const activeFingerprints = new Map()
  let activeCount = 0
  let stopped = false
  let scheduling = false

  function schedule() {
    if (scheduling || stopped) return
    scheduling = true
    queueMicrotask(async () => {
      try {
        while (!stopped && activeCount < concurrency && waiting.length) {
          const job = waiting.shift()
          if (!job || job.cancelRequested) continue
          activeCount += 1
          job.started = true
          job.execution = execute(job).finally(() => {
            activeCount -= 1
            schedule()
          })
        }
      } finally {
        scheduling = false
        if (!stopped && activeCount < concurrency && waiting.length) schedule()
      }
    })
  }

  async function terminal(job, changes) {
    const current = await store.getRun(job.id)
    const next = await store.appendRun({
      ...current,
      ...changes,
      completedAt: changes.completedAt || new Date().toISOString(),
    })
    activeFingerprints.delete(job.fingerprint)
    jobs.delete(job.id)
    return next
  }

  async function execute(job) {
    if (job.cancelRequested || stopped) return
    const startedAt = new Date().toISOString()
    await store.appendRun({ ...job.summary, status: 'running', startedAt })
    const timeout = setTimeout(() => {
      job.timeoutRequested = true
      job.controller.abort()
    }, job.timeoutMs)
    timeout.unref()
    try {
      const result = await runner({
        ...job.input,
        runId: job.id,
        requestedAt: job.summary.requestedAt,
        requestedBy: job.summary.requestedBy,
      }, { ...job.runnerOptions, signal: job.controller.signal })
      if (job.controller.signal.aborted) throw Object.assign(new Error('Evaluation execution aborted.'), { name: 'AbortError' })
      const evaluated = result.summary.mode === 'redteam'
        ? evaluateRedteamGatePolicy(result.summary, policy)
        : evaluateGatePolicy(result.summary, policy)
      const completed = {
        ...result.summary,
        provider: { ...result.summary.provider, configurationHash: job.summary.provider.configurationHash },
        subjectHash: job.summary.subjectHash,
        policyHash: evaluated.policyHash,
        casesHash: computeEvaluationCasesHash(result.cases),
        gates: evaluated.gates,
        gateResult: evaluated.gateResult,
        evidenceHash: null,
      }
      completed.evidenceHash = computeEvaluationEvidenceHash(completed)
      await store.writeCases(job.id, result.cases)
      await terminal(job, completed)
    } catch (error) {
      const interrupted = job.interruptRequested
      const timedOut = !interrupted && job.timeoutRequested
      const cancelled = !interrupted && !timedOut && (job.cancelRequested || job.controller.signal.aborted || error?.name === 'AbortError')
      await terminal(job, {
        status: interrupted ? 'interrupted' : timedOut ? 'failed' : cancelled ? 'cancelled' : 'failed',
        metrics: null,
        policyHash: null,
        gates: [],
        evidenceHash: null,
        gateResult: 'not-evaluated',
        errorCode: interrupted ? 'PROCESS_SHUTDOWN' : timedOut ? 'RUN_TIMEOUT' : cancelled ? 'CANCELLED' : errorCode(error),
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    concurrency,
    timeoutMs,
    async initialize() {
      stopped = false
      return store.interruptRunning()
    },
    async enqueue(input, runnerOptions = {}) {
      if (stopped) throw new EvaluationError('Evaluation manager is shutting down.', 503)
      if (!input?.suite || !input?.baseline || !input?.candidate) throw new EvaluationError('Suite, baseline, and candidate are required.', 422)
      const provider = normalizeProvider(input.provider)
      const baseline = normalizeArtifactDefinition(input.baseline.artifact)
      const candidate = normalizeArtifactDefinition(input.candidate.artifact)
      const clientRequestId = optionalId(input.clientRequestId, 'Client request ID')
      const configurationHash = providerConfigurationHash(input, provider)
      const fingerprint = activeFingerprint(input, baseline, candidate, configurationHash)
      if (clientRequestId && idempotency.has(clientRequestId)) {
        const replay = idempotency.get(clientRequestId)
        if (replay.fingerprint !== fingerprint) throw new EvaluationError('Client request ID was already used for different evaluation settings.', 409)
        return { summary: await store.getRun(replay.id), reused: true }
      }
      if (activeFingerprints.has(fingerprint)) {
        const existingId = activeFingerprints.get(fingerprint)
        if (input.reuseActive === true) return { summary: await store.getRun(existingId), reused: true }
        throw new EvaluationError('An active evaluation already exists for this candidate and suite.', 409)
      }
      const id = optionalId(input.runId, 'Run ID') || randomUUID()
      if (await store.getRun(id)) throw new EvaluationError('Evaluation run ID already exists.', 409)
      const requestedAt = new Date().toISOString()
      const summary = await store.appendRun(queuedSummary(input, id, baseline, candidate, provider, configurationHash, requestedAt))
      const job = {
        id,
        input: { ...input, baseline: { ...input.baseline, artifact: baseline }, candidate: { ...input.candidate, artifact: candidate }, provider },
        runnerOptions,
        summary,
        fingerprint,
        controller: new AbortController(),
        cancelRequested: false,
        timeoutMs: normalizeTimeout(input.timeoutMs ?? timeoutMs),
        timeoutRequested: false,
        interruptRequested: false,
        started: false,
        execution: null,
      }
      jobs.set(id, job)
      activeFingerprints.set(fingerprint, id)
      if (clientRequestId) idempotency.set(clientRequestId, { id, fingerprint })
      waiting.push(job)
      schedule()
      return { summary, reused: false }
    },
    async cancel(runId) {
      const job = jobs.get(runId)
      const summary = await store.getRun(runId)
      if (!summary) throw new EvaluationError('Evaluation run was not found.', 404)
      if (store.isTerminal(summary.status)) return { summary, cancelled: false }
      if (!job) throw new EvaluationError('Evaluation run is not active in this process.', 409)
      job.cancelRequested = true
      job.controller.abort()
      if (summary.status === 'queued') {
        const next = await terminal(job, { status: 'cancelled', metrics: null, policyHash: null, gates: [], evidenceHash: null, gateResult: 'not-evaluated', errorCode: 'CANCELLED' })
        return { summary: next, cancelled: true }
      }
      return { summary, cancelled: true }
    },
    async shutdown() {
      stopped = true
      const active = [...jobs.values()]
      for (const job of active) {
        job.interruptRequested = true
        job.cancelRequested = true
        job.controller.abort()
      }
      await Promise.all(active.map(async (job) => {
        if (job.started && job.execution) return job.execution
        const current = await store.getRun(job.id)
        if (current && !store.isTerminal(current.status)) {
          await terminal(job, { status: 'interrupted', metrics: null, policyHash: null, gates: [], evidenceHash: null, gateResult: 'not-evaluated', errorCode: 'PROCESS_SHUTDOWN' })
        }
      }))
    },
    get activeCount() { return activeCount },
    get queuedCount() { return waiting.filter((job) => !job.cancelRequested).length },
  }
}
