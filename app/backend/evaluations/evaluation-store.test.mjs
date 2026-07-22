import { appendFile, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeEvaluationCasesHash, computeEvaluationEvidenceHash, createEvaluationStore } from './evaluation-store.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const artifact = (artifactId, contentHash) => ({
  kind: 'skill', artifactId, version: '1.0.0', source: 'github', sourceRef: `github:https://github.com/acme/${artifactId}/blob/${contentHash.slice(0, 40)}/SKILL.md#SKILL.md`, contentHash, gitCommit: contentHash.slice(0, 40),
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

async function temporaryStore(options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-evaluation-store-'))
  temporaryDirectories.push(dataDir)
  return createEvaluationStore({ dataDir, warningBytes: 1, ...options })
}

describe('evaluation store', () => {
  it('persists only allowlisted summary and case metadata', async () => {
    const store = await temporaryStore()
    const secret = 'sentinel-super-secret'
    const saved = await store.appendRun({ ...summary(), status: 'running', completedAt: null, evidenceHash: null, apiKey: secret, rawOutput: secret })
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

  it('hashes local source paths before persisting evaluation evidence', async () => {
    const store = await temporaryStore()
    const sourcePath = 'C:\\Users\\owner\\private-project\\.codex\\skills\\review\\SKILL.md'
    const relativePath = '.claude/skills/review/SKILL.md'
    const saved = await store.appendRun(summary({
      baseline: {
        kind: 'skill',
        artifactId: 'baseline',
        version: '1.0.0',
        source: 'local-scan',
        sourceRef: `local-scan:codex:${sourcePath}`,
        contentHash: 'a'.repeat(64),
      },
      candidate: {
        kind: 'skill',
        artifactId: 'candidate',
        version: '2.0.0',
        source: 'local-scan',
        sourceRef: `local-scan:claude-code:${relativePath}`,
        contentHash: 'b'.repeat(64),
      },
    }))

    expect(saved.baseline.sourceRef).toMatch(/^local-scan:codex:sha256:[a-f0-9]{64}$/)
    expect(saved.candidate.sourceRef).toMatch(/^local-scan:claude-code:sha256:[a-f0-9]{64}$/)
    expect(await readFile(store.storeFile, 'utf8')).not.toContain(sourcePath)
    expect(await readFile(store.storeFile, 'utf8')).not.toContain(relativePath)
  })

  it('reads legacy mutable GitHub records as unpinned history without weakening new writes', async () => {
    const store = await temporaryStore()
    const legacy = summary({
      baseline: {
        ...artifact('baseline', 'a'.repeat(64)),
        sourceRef: 'github:https://github.com/acme/baseline/tree/main#skills%2Fbaseline%2FSKILL.md',
        gitCommit: undefined,
      },
    })
    await appendFile(store.storeFile, `${JSON.stringify({ type: 'run', summary: legacy })}\n`, 'utf8')

    const loaded = await store.getRun(legacy.id)
    expect(loaded.baseline).toEqual(expect.objectContaining({
      source: 'local-scan',
      sourceRef: expect.stringMatching(/^local-scan:legacy-github:sha256:[a-f0-9]{64}$/),
    }))
    expect(loaded.baseline.gitCommit).toBeUndefined()
    await expect(store.appendRun(legacy)).rejects.toThrow('immutable Git commit')
  })

  it('fails closed without deleting a malformed trailing JSONL record', async () => {
    const store = await temporaryStore()
    await store.appendRun(summary({ status: 'running', metrics: null, completedAt: null, gates: [], gateResult: 'not-evaluated' }))
    await appendFile(store.storeFile, '{"type":"run","summary":', 'utf8')
    const corrupted = await readFile(store.storeFile, 'utf8')

    await expect(store.getRun('run-1')).rejects.toThrow('malformed record')
    await expect(store.appendRun(summary({ id: 'run-2' }))).rejects.toThrow('malformed record')
    expect(await readFile(store.storeFile, 'utf8')).toBe(corrupted)
  })

  it('repairs only a missing newline after a valid final record', async () => {
    const store = await temporaryStore()
    await store.appendRun(summary({ id: 'run-1' }))
    await writeFile(store.storeFile, (await readFile(store.storeFile, 'utf8')).trimEnd(), 'utf8')
    await store.appendRun(summary({ id: 'run-2' }))

    expect((await store.listRuns({ limit: 100 })).items.map((item) => item.id)).toEqual(['run-2', 'run-1'])
    expect(await readFile(store.storeFile, 'utf8')).toMatch(/}\n{.+}\n$/)
  })

  it('serializes independent store instances and does not steal an old live-owner lock', async () => {
    const store = await temporaryStore()
    const peer = createEvaluationStore({ dataDir: store.dataDir })
    await Promise.all(Array.from({ length: 10 }, (_, index) => (
      (index % 2 ? store : peer).appendRun(summary({ id: `run-${index}` }))
    )))
    expect((await store.listRuns({ limit: 100 })).items).toHaveLength(10)

    await writeFile(path.join(store.dataDir, 'evaluations.lock'), JSON.stringify({ pid: process.pid, token: 'live-owner' }), 'utf8')
    const old = new Date(Date.now() - 60_000)
    await utimes(path.join(store.dataDir, 'evaluations.lock'), old, old)
    const blocked = createEvaluationStore({ dataDir: store.dataDir, lockAttempts: 2 })
    await expect(blocked.appendRun(summary({ id: 'blocked' }))).rejects.toThrow('Timed out')
    expect(JSON.parse(await readFile(path.join(store.dataDir, 'evaluations.lock'), 'utf8')).token).toBe('live-owner')
  })
  it('marks persisted queued and running work interrupted at startup and rebuilds the latest index', async () => {
    const store = await temporaryStore()
    await store.appendRun(summary({ id: 'run-queued', status: 'queued', metrics: null, startedAt: null, completedAt: null, gates: [], gateResult: 'not-evaluated' }))
    await store.appendRun(summary({ id: 'run-running', status: 'running', metrics: null, completedAt: null, gates: [], gateResult: 'not-evaluated' }))
    expect(await store.interruptRunning()).toBe(2)
    expect(await store.interruptRunning()).toBe(0)
    expect(await store.getRun('run-queued')).toEqual(expect.objectContaining({ status: 'interrupted', errorCode: 'PROCESS_RESTARTED' }))
    expect(await store.getRun('run-running')).toEqual(expect.objectContaining({ status: 'interrupted', errorCode: 'PROCESS_RESTARTED' }))
    const index = JSON.parse(await readFile(path.join(store.dataDir, 'evaluation-index.json'), 'utf8'))
    expect(index.runs).toEqual([
      { id: 'run-queued', status: 'interrupted', requestedAt: '2026-07-21T00:00:00.000Z' },
      { id: 'run-running', status: 'interrupted', requestedAt: '2026-07-21T00:00:00.000Z' },
    ])
  })

  it('prunes expired terminal runs while preserving governed evidence and active work', async () => {
    const store = await temporaryStore()
    await store.appendRun(summary({ id: 'expired', requestedAt: '2026-07-20T00:00:00.000Z' }))
    await store.appendRun(summary({ id: 'governed', requestedAt: '2026-07-20T00:00:00.000Z' }))
    await store.appendRun(summary({
      id: 'active',
      status: 'running',
      requestedAt: '2026-07-20T00:00:00.000Z',
      completedAt: null,
      metrics: null,
      gates: [],
      evidenceHash: null,
      gateResult: 'not-evaluated',
    }))
    await store.appendRun(summary({ id: 'current', requestedAt: '2026-07-22T00:00:00.000Z' }))
    const expiredBackup = `${store.storeFile}.backup-expired`
    await writeFile(expiredBackup, 'expired', 'utf8')
    await utimes(expiredBackup, new Date('2026-07-19T00:00:00.000Z'), new Date('2026-07-19T00:00:00.000Z'))

    const result = await store.pruneBefore('2026-07-21T00:00:00.000Z', { preserveRunIds: ['governed'] })

    expect(result).toEqual({
      removedRuns: 1,
      removedRecords: 1,
      retainedRuns: 3,
      removedBackups: 1,
      backupFile: expect.stringContaining('.backup-'),
    })
    expect(await store.getRun('expired')).toBeNull()
    expect(await store.getRun('governed')).toEqual(expect.objectContaining({ id: 'governed' }))
    expect(await store.getRun('active')).toEqual(expect.objectContaining({ status: 'running' }))
    expect((await store.listRuns({ limit: 100 })).items.map((run) => run.id).sort()).toEqual(['active', 'current', 'governed'])
    expect(await readFile(result.backupFile, 'utf8')).toContain('"id":"expired"')
    await expect(readFile(expiredBackup, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('hashes the full completed evidence and returns no evidence for incomplete work', () => {
    const completed = summary()
    const first = computeEvaluationEvidenceHash(completed)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(computeEvaluationEvidenceHash({ ...completed, provider: { id: 'openai', model: 'another-model' } })).not.toBe(first)
    expect(computeEvaluationEvidenceHash({ ...completed, status: 'cancelled', completedAt: null })).toBeNull()
  })

  it('persists model-matrix identity in summary and case evidence', async () => {
    const store = await temporaryStore()
    const run = await store.appendRun(summary({
      status: 'running',
      completedAt: null,
      evidenceHash: null,
      provider: { id: 'openai', model: 'matrix', models: ['gpt-fast', 'gpt-strong'] },
    }))
    await store.writeCases(run.id, [{
      id: 'fast:case-1:1', caseId: 'case-1', repeat: 1, weight: 1, matrixId: 'fast', model: 'gpt-fast',
      baseline: { pass: true, score: 100, assertions: [] },
      candidate: { pass: true, score: 100, assertions: [] },
    }])

    expect((await store.getRun(run.id)).provider.models).toEqual(['gpt-fast', 'gpt-strong'])
    expect((await store.getCases(run.id))[0]).toEqual(expect.objectContaining({ matrixId: 'fast', model: 'gpt-fast' }))
    expect(computeEvaluationEvidenceHash(summary({
      provider: { id: 'openai', model: 'matrix', models: ['gpt-fast', 'gpt-strong'] },
    }))).not.toBe(computeEvaluationEvidenceHash(summary({
      provider: { id: 'openai', model: 'matrix', models: ['gpt-fast', 'gpt-other'] },
    })))
  })

  it('binds persisted case verdicts to completed evidence and rejects later replacement', async () => {
    const store = await temporaryStore()
    const cases = [{
      id: 'case-1:1', caseId: 'case-1', repeat: 1, weight: 1,
      baseline: { pass: true, score: 100, assertions: [{ label: 'required', type: 'contains', blocking: true, pass: true, score: 100 }] },
      candidate: { pass: true, score: 100, assertions: [{ label: 'required', type: 'contains', blocking: true, pass: true, score: 100 }] },
    }]
    const completed = summary({ casesHash: computeEvaluationCasesHash(cases) })
    completed.evidenceHash = computeEvaluationEvidenceHash(completed)
    await store.appendRun({ ...completed, status: 'running', completedAt: null, evidenceHash: null })
    await store.writeCases(completed.id, cases)
    await store.appendRun(completed)

    const changed = structuredClone(cases)
    changed[0].candidate.pass = false
    changed[0].candidate.assertions[0].pass = false
    expect(computeEvaluationCasesHash(changed)).not.toBe(completed.casesHash)
    await expect(store.writeCases(completed.id, changed)).rejects.toThrow('immutable')
    await appendFile(store.storeFile, `${JSON.stringify({ schemaVersion: 2, type: 'cases', runId: completed.id, cases: changed })}\n`, 'utf8')
    await expect(store.getRun(completed.id)).rejects.toThrow('case evidence')
  })

  it('rejects non-finite signed metrics instead of coercing strings', async () => {
    const store = await temporaryStore()
    await expect(store.appendRun(summary({ metrics: { ...summary().metrics, scoreDeltaPp: '15' } }))).rejects.toThrow('Score delta')
  })
})
