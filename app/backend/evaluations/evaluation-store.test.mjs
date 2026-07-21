import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeEvaluationEvidenceHash, createEvaluationStore } from './evaluation-store.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const artifact = (artifactId, contentHash) => ({
  kind: 'skill', artifactId, version: '1.0.0', source: 'github', sourceRef: `github:${artifactId}`, contentHash,
})

function summary(overrides = {}) {
  return {
    id: 'run-1', mode: 'suite', status: 'completed', suiteId: 'suite-1', suiteVersion: '1.0.0',
    suiteHash: 'c'.repeat(64), datasetHash: 'd'.repeat(64),
    baseline: artifact('baseline', 'a'.repeat(64)), candidate: artifact('candidate', 'b'.repeat(64)),
    engine: { name: 'promptfoo', version: '0.121.19' }, provider: { id: 'openai', model: 'gpt-test' },
    metrics: {
      baselineScore: 75, candidateScore: 90, scoreDeltaPp: 15, casesPassed: 2, casesTotal: 2,
      passRatePct: 100, regressionRatePct: 0, baselineTokens: null, candidateTokens: null,
      baselineCostUsd: null, candidateCostUsd: null, costDeltaPct: null,
      baselineP95LatencyMs: 10, candidateP95LatencyMs: 11, latencyDeltaPct: 10,
      criticalFindings: 0, highFindings: 0,
    },
    policyHash: 'e'.repeat(64), gates: [{ id: 'pass-rate', status: 'passed', blocking: true }],
    evidenceHash: null, gateResult: 'passed', requestedBy: 'qa', requestedAt: '2026-07-21T00:00:00.000Z',
    startedAt: '2026-07-21T00:00:01.000Z', completedAt: '2026-07-21T00:00:02.000Z', errorCode: null,
    ...overrides,
  }
}

async function temporaryStore() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-evaluation-store-'))
  temporaryDirectories.push(dataDir)
  return createEvaluationStore({ dataDir, warningBytes: 1 })
}

describe('evaluation store', () => {
  it('persists only allowlisted summary and case metadata', async () => {
    const store = await temporaryStore()
    const secret = 'sentinel-super-secret'
    const saved = await store.appendRun({ ...summary(), apiKey: secret, rawOutput: secret })
    await store.writeCases(saved.id, [{
      id: 'case-1#0', caseId: 'case-1', repeat: 0, weight: 1,
      baseline: { pass: true, score: 1, tokens: 99, costUsd: 1, latencyMs: 10, output: secret, assertions: [{ label: 'required', type: 'contains', blocking: true, pass: true, score: 1 }] },
      candidate: { pass: true, score: 1, tokens: 99, costUsd: 1, latencyMs: 10, output: secret, assertions: [{ label: 'required', type: 'contains', blocking: true, pass: true, score: 1 }] },
    }])
    const contents = await readFile(store.storeFile, 'utf8')
    expect(contents).not.toContain(secret)
    expect(contents).not.toContain('rawOutput')
    expect(contents).not.toContain('tokens')
    expect((await store.getCases(saved.id))[0].candidate.assertions[0]).toEqual({
      label: 'required', type: 'contains', blocking: true, pass: true, score: 1,
    })
    expect(await store.health()).toEqual(expect.objectContaining({ warning: true, automaticDeletion: false }))
  })

  it('tolerates and repairs one trailing partial JSONL record', async () => {
    const store = await temporaryStore()
    await store.appendRun(summary({ status: 'running', metrics: null, completedAt: null, gates: [], gateResult: 'not-evaluated' }))
    await appendFile(store.storeFile, '{"type":"run","summary":', 'utf8')
    expect((await store.getRun('run-1')).status).toBe('running')
    await store.appendRun(summary({ status: 'failed', metrics: null, completedAt: '2026-07-21T00:00:03.000Z', gates: [], gateResult: 'not-evaluated', errorCode: 'PROVIDER_ERROR' }))
    expect((await store.getRun('run-1')).status).toBe('failed')
    expect(await readFile(store.storeFile, 'utf8')).not.toContain('{"type":"run","summary":\n')
  })

  it('marks persisted running work interrupted at startup and rebuilds the latest index', async () => {
    const store = await temporaryStore()
    await store.appendRun(summary({ status: 'running', metrics: null, completedAt: null, gates: [], gateResult: 'not-evaluated' }))
    expect(await store.interruptRunning()).toBe(1)
    expect(await store.interruptRunning()).toBe(0)
    expect(await store.getRun('run-1')).toEqual(expect.objectContaining({ status: 'interrupted', errorCode: 'PROCESS_RESTARTED' }))
    const index = JSON.parse(await readFile(path.join(store.dataDir, 'evaluation-index.json'), 'utf8'))
    expect(index.runs).toEqual([{ id: 'run-1', status: 'interrupted', requestedAt: '2026-07-21T00:00:00.000Z' }])
  })

  it('hashes the full completed evidence and returns no evidence for incomplete work', () => {
    const completed = summary()
    const first = computeEvaluationEvidenceHash(completed)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(computeEvaluationEvidenceHash({ ...completed, provider: { id: 'openai', model: 'another-model' } })).not.toBe(first)
    expect(computeEvaluationEvidenceHash({ ...completed, status: 'cancelled', completedAt: null })).toBeNull()
  })

  it('rejects non-finite signed metrics instead of coercing strings', async () => {
    const store = await temporaryStore()
    await expect(store.appendRun(summary({ metrics: { ...summary().metrics, scoreDeltaPp: '15' } }))).rejects.toThrow('Score delta')
  })
})
