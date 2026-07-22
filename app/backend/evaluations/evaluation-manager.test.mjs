import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEvaluationManager } from './evaluation-manager.mjs'
import { computeEvaluationEvidenceHash, createEvaluationStore } from './evaluation-store.mjs'

const temporaryDirectories = []
const managers = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map(async (manager) => {
    await manager.shutdown()
    await waitForIdle(manager)
  }))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const provider = { provider: 'openai', model: 'gpt-test', apiKey: 'sentinel-provider-key' }
const artifact = (artifactId, hash) => ({
  artifact: { kind: 'skill', artifactId, version: '1.0.0', source: 'github', sourceRef: `github:https://github.com/acme/${artifactId}/blob/${hash.repeat(40)}/SKILL.md#SKILL.md`, contentHash: hash.repeat(64), gitCommit: hash.repeat(40) },
  contents: `sentinel-${artifactId}-contents`,
})
const suite = {
  schemaVersion: 1, id: 'manager-suite', name: 'Manager suite', version: '1.0.0', owner: 'qa', sensitivity: 'synthetic',
  artifactKind: 'skill', repeats: 1, suiteHash: 'c'.repeat(64), datasetHash: null,
  cases: [{ id: 'case-1', input: 'synthetic', weight: 1, assertions: [{ label: 'required', type: 'contains', value: 'ok', blocking: true }] }],
}

function request(index, overrides = {}) {
  return {
    suite,
    baseline: artifact(`baseline-${index}`, 'a'),
    candidate: artifact(`candidate-${index}`, String(index + 1)),
    provider,
    requestedBy: 'qa',
    clientRequestId: `request-${index}`,
    ...overrides,
  }
}

function completed(input) {
  const now = new Date().toISOString()
  return {
    summary: {
      id: input.runId, mode: 'suite', status: 'completed', suiteId: input.suite.id, suiteVersion: input.suite.version,
      suiteHash: input.suite.suiteHash, datasetHash: input.suite.datasetHash,
      baseline: input.baseline.artifact, candidate: input.candidate.artifact,
      engine: { name: 'promptfoo', version: '0.121.19' }, provider: { id: input.provider.provider, model: input.provider.model },
      metrics: {
        baselineScore: 80, candidateScore: 90, scoreDeltaPp: 10, casesPassed: 1, casesTotal: 1,
        passRatePct: 100, regressionRatePct: 0, baselineTokens: null, candidateTokens: null,
        baselineCostUsd: null, candidateCostUsd: null, costDeltaPct: null,
        baselineP95LatencyMs: 10, candidateP95LatencyMs: 11, latencyDeltaPct: 10,
        criticalFindings: 0, highFindings: 0,
      },
      evidenceHash: null, gateResult: 'not-evaluated', requestedBy: input.requestedBy,
      requestedAt: input.requestedAt, startedAt: now, completedAt: now, errorCode: null,
    },
    cases: [{
      id: 'case-1:1', caseId: 'case-1', repeat: 1, weight: 1,
      baseline: { pass: true, score: 100, tokens: null, costUsd: null, latencyMs: 10, assertions: [{ label: 'required', type: 'contains', blocking: true, pass: true, score: 100 }] },
      candidate: { pass: true, score: 100, tokens: null, costUsd: null, latencyMs: 11, assertions: [{ label: 'required', type: 'contains', blocking: true, pass: true, score: 100 }] },
    }],
  }
}

async function setup(runner, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-evaluation-manager-'))
  temporaryDirectories.push(dataDir)
  const store = createEvaluationStore({ dataDir })
  const manager = createEvaluationManager({ store, runner, ...options })
  await manager.initialize()
  managers.push(manager)
  return { dataDir, store, manager }
}

async function waitFor(store, runId, status) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const run = await store.getRun(runId)
    if (run?.status === status) return run
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${runId} to become ${status}.`)
}

async function waitForIdle(manager) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (manager.activeCount === 0 && manager.queuedCount === 0) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for the evaluation manager to become idle.')
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(message)
}

describe('evaluation manager', () => {
  it('runs jobs FIFO at the configured concurrency and returns before completion', async () => {
    const starts = []
    const releases = []
    let active = 0
    let maximum = 0
    const runner = async (input, { signal }) => {
      starts.push(input.runId)
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve, reject) => {
        releases.push(resolve)
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      })
      active -= 1
      return completed(input)
    }
    const { store, manager } = await setup(runner)
    const created = []
    for (let index = 0; index < 3; index += 1) created.push(await manager.enqueue(request(index)))
    expect(created.map((item) => item.summary.status)).toEqual(['queued', 'queued', 'queued'])
    await waitFor(store, created[0].summary.id, 'running')
    await waitUntil(() => releases.length === 1, 'First runner did not start.')
    expect(starts).toEqual([created[0].summary.id])
    releases.shift()()
    await waitFor(store, created[0].summary.id, 'completed')
    await waitFor(store, created[1].summary.id, 'running')
    await waitUntil(() => releases.length === 1, 'Second runner did not start.')
    releases.shift()()
    await waitFor(store, created[1].summary.id, 'completed')
    await waitFor(store, created[2].summary.id, 'running')
    await waitUntil(() => releases.length === 1, 'Third runner did not start.')
    releases.shift()()
    await waitFor(store, created[2].summary.id, 'completed')
    expect(starts).toEqual(created.map((item) => item.summary.id))
    expect(maximum).toBe(1)
  })

  it('binds completed evidence to an immutable subject hash', async () => {
    const subjectHash = 'f'.repeat(64)
    const { store, manager } = await setup(async (input) => completed(input))
    const created = await manager.enqueue(request(1, { subjectHash }))
    const run = await waitFor(store, created.summary.id, 'completed')

    expect(run.subjectHash).toBe(subjectHash)
    expect(run.evidenceHash).toBe(computeEvaluationEvidenceHash({ ...run, evidenceHash: null }))
    expect(computeEvaluationEvidenceHash({ ...run, subjectHash: 'e'.repeat(64), evidenceHash: null })).not.toBe(run.evidenceHash)
  })

  it('supports request idempotency and rejects duplicate active candidate evidence', async () => {
    const runner = async (input, { signal }) => new Promise((_resolve, reject) => {
      if (signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    })
    const { manager } = await setup(runner)
    const first = await manager.enqueue(request(1))
    const replay = await manager.enqueue(request(1))
    expect(replay).toEqual({ summary: expect.objectContaining({ id: first.summary.id }), reused: true })
    await expect(manager.enqueue(request(1, { clientRequestId: 'another-request' }))).rejects.toMatchObject({ status: 409 })
    await manager.shutdown()
  })

  it('keys active work and idempotency to credential-free provider settings', async () => {
    const runner = async (_input, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    })
    const { manager } = await setup(runner)
    const first = await manager.enqueue(request(1, {
      provider: { ...provider, baseUrl: 'https://one.example/v1', reasoningEffort: 'low' },
    }))
    const second = await manager.enqueue(request(1, {
      clientRequestId: 'different-settings',
      provider: { ...provider, baseUrl: 'https://two.example/v1', reasoningEffort: 'high' },
    }))
    expect(first.summary.provider.configurationHash).toMatch(/^[a-f0-9]{64}$/)
    expect(second.summary.provider.configurationHash).not.toBe(first.summary.provider.configurationHash)
    expect(JSON.stringify([first.summary, second.summary])).not.toContain('example')
    await expect(manager.enqueue(request(1, {
      provider: { ...provider, baseUrl: 'https://two.example/v1', reasoningEffort: 'high' },
    }))).rejects.toThrow('Client request ID')
    await manager.shutdown()
  })

  it('cancels queued and running work without creating ready evidence', async () => {
    const runner = async (input, { signal }) => new Promise((_resolve, reject) => {
      if (signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    })
    const { store, manager } = await setup(runner)
    const first = await manager.enqueue(request(1))
    const second = await manager.enqueue(request(2))
    await waitFor(store, first.summary.id, 'running')
    expect((await manager.cancel(second.summary.id)).cancelled).toBe(true)
    expect((await manager.cancel(first.summary.id)).cancelled).toBe(true)
    for (const id of [first.summary.id, second.summary.id]) {
      const run = await waitFor(store, id, 'cancelled')
      expect(run).toEqual(expect.objectContaining({ evidenceHash: null, gateResult: 'not-evaluated' }))
    }
  })

  it('interrupts persisted running work on startup and active work on shutdown', async () => {
    const runner = async (_input, { signal }) => new Promise((_resolve, reject) => {
      if (signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    })
    const { store, manager } = await setup(runner)
    const created = await manager.enqueue(request(1))
    await waitFor(store, created.summary.id, 'running')
    await manager.shutdown()
    expect(await store.getRun(created.summary.id)).toEqual(expect.objectContaining({ status: 'interrupted', evidenceHash: null }))
  })

  it('never writes in-memory provider secrets or artifact contents anywhere in the data directory', async () => {
    const { dataDir, store, manager } = await setup(async (input) => completed(input))
    const created = await manager.enqueue(request(1))
    await waitFor(store, created.summary.id, 'completed')
    await waitForIdle(manager)
    const files = await readdir(dataDir)
    const allContents = (await Promise.all(files.map((file) => readFile(path.join(dataDir, file), 'utf8')))).join('\n')
    expect(allContents).not.toContain(provider.apiKey)
    expect(allContents).not.toContain('sentinel-baseline-1-contents')
    expect(allContents).not.toContain('sentinel-candidate-1-contents')
  })

  it('times out running work and releases the concurrency slot', async () => {
    const runner = async (_input, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    })
    const { store, manager } = await setup(runner, { timeoutMs: 20 })
    const created = await manager.enqueue(request(1))
    const run = await waitFor(store, created.summary.id, 'failed')
    expect(run).toEqual(expect.objectContaining({ errorCode: 'RUN_TIMEOUT', evidenceHash: null, gateResult: 'not-evaluated' }))
    await waitForIdle(manager)
  })

  it('enforces the concurrency hard limit', async () => {
    const { store } = await setup(async (input) => completed(input), { concurrency: 4 })
    expect(() => createEvaluationManager({ store, concurrency: 5 })).toThrow('between 1 and 4')
  })
})
