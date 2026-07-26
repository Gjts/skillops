// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { EvaluationError } from './errors.mjs'
import { handleManagedEvaluationApi } from './suite-api.mjs'

const suite = {
  schemaVersion: 1, id: 'suite-1', name: 'Suite one', version: '1.0.0', owner: 'qa', sensitivity: 'synthetic',
  artifactKind: 'skill', repeats: 1, suiteHash: 'c'.repeat(64), datasetHash: null, datasetId: null,
  cases: [{ id: 'case-1', input: 'private test input', weight: 1, assertions: [{ label: 'required', type: 'contains', value: 'private value', blocking: true }] }],
}
const artifact = (id, hash) => ({
  artifact: { kind: 'skill', artifactId: id, version: '1.0.0', source: 'github', sourceRef: `github:https://github.com/acme/${id}/blob/${hash.repeat(40)}/SKILL.md#SKILL.md`, contentHash: hash.repeat(64), gitCommit: hash.repeat(40) },
  contents: `private ${id} content`,
})
const summary = {
  id: 'run-1', status: 'queued', suiteId: 'suite-1', provider: { id: 'openai', model: 'gpt-test' }, evidenceHash: null,
}

function request(method, url, body, headers = {}) {
  const bytes = Buffer.from(body === undefined ? '' : JSON.stringify(body))
  return {
    method,
    url,
    headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (bytes.length) yield bytes },
  }
}

function response() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(value = '') { this.body += value },
  }
}

function services(overrides = {}) {
  return {
    suites: {
      list: vi.fn().mockResolvedValue([{ id: suite.id, name: suite.name, suiteHash: suite.suiteHash }]),
      get: vi.fn().mockResolvedValue(suite),
    },
    artifacts: { resolve: vi.fn(async (ref) => ref.includes('baseline') ? artifact('baseline', 'a') : artifact('candidate', 'b')) },
    manager: {
      enqueue: vi.fn().mockResolvedValue({ summary, reused: false }),
      cancel: vi.fn().mockResolvedValue({ summary: { ...summary, status: 'cancelled' }, cancelled: true }),
    },
    store: {
      listRuns: vi.fn().mockResolvedValue({ items: [summary], nextCursor: null }),
      getRun: vi.fn().mockResolvedValue(summary),
      getCases: vi.fn().mockResolvedValue([
        { id: 'case-1:1', caseId: 'case-1', baseline: { pass: true, score: 100 }, candidate: { pass: true, score: 100 } },
        { id: 'case-2:1', caseId: 'case-2', baseline: { pass: true, score: 100 }, candidate: { pass: false, score: 0 } },
      ]),
      getDecision: vi.fn().mockResolvedValue(null),
      appendDecision: vi.fn().mockImplementation(async (runId, decision) => ({
        decision: {
          decisionId: `decision_${'c'.repeat(64)}`,
          evaluationRunId: runId,
          artifactId: 'candidate',
          candidateRefHash: 'b'.repeat(64),
          decision,
          recordedAt: '2026-07-25T12:00:00.000Z',
        },
        reused: false,
      })),
    },
    ...overrides,
  }
}

async function call(method, url, body, service = services(), headers, options = {}) {
  const res = response()
  const pathname = new URL(url, 'http://127.0.0.1').pathname
  const handled = await handleManagedEvaluationApi(request(method, url, body, headers), res, pathname, { managedEvaluationServices: service, ...options })
  return { handled, response: res, json: res.body ? JSON.parse(res.body) : null, service }
}

describe('managed evaluation API', () => {
  it('lists suites and returns a detail contract without test inputs or assertion values', async () => {
    const list = await call('GET', '/api/evaluation-suites')
    expect(list.handled).toBe(true)
    expect(list.json.items[0].id).toBe('suite-1')
    expect(list.json).toMatchObject({
      page: 1,
      pageSize: 50,
      totalItems: 1,
      totalPages: 1,
      hasPrevious: false,
      hasNext: false,
      generatedAt: expect.any(String),
    })
    const detail = await call('GET', '/api/evaluation-suites/suite-1')
    expect(detail.json.cases[0]).toEqual({ id: 'case-1', weight: 1, assertions: [{ label: 'required', type: 'contains', blocking: true }] })
    expect(detail.response.body).not.toContain('private test input')
    expect(detail.response.body).not.toContain('private value')
  })

  it('stably paginates Suite definitions and rejects invalid page bounds', async () => {
    const service = services()
    service.suites.list.mockResolvedValue(Array.from({ length: 45 }, (_, index) => ({
      id: `suite-${String(45 - index).padStart(2, '0')}`,
      name: `Suite ${45 - index}`,
      suiteHash: String(index).padStart(64, '0'),
    })))

    const result = await call('GET', '/api/evaluation-suites?page=2&pageSize=20', undefined, service)
    expect(result.response.statusCode).toBe(200)
    expect(result.json.items.map((item) => item.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `suite-${String(index + 21).padStart(2, '0')}`),
    )
    expect(result.json).toMatchObject({
      page: 2,
      pageSize: 20,
      totalItems: 45,
      totalPages: 3,
      hasPrevious: true,
      hasNext: true,
      generatedAt: expect.any(String),
    })

    const invalid = await call('GET', '/api/evaluation-suites?pageSize=25', undefined, service)
    expect(invalid.response.statusCode).toBe(400)
    expect(invalid.json.error).toEqual({
      code: 'INVALID_REQUEST',
      message: 'pageSize must be 20, 50, or 100.',
    })
  })

  it('creates an asynchronous run after validating provider and resolving both artifacts', async () => {
    const service = services()
    const result = await call('POST', '/api/evaluation-runs', {
      suiteId: 'suite-1', baselineRef: 'local-scan:baseline', candidateRef: 'github:candidate',
      provider: { provider: 'openai', model: 'gpt-test', apiKey: 'sentinel-key' },
      requestedBy: 'qa', clientRequestId: 'request-1', timeoutMs: 45_000,
    }, service, undefined, { teamPrincipal: { id: 'user:developer' } })
    expect(result.response.statusCode).toBe(202)
    expect(result.json).toEqual({ run: summary, reused: false })
    expect(result.response.body).not.toContain('sentinel-key')
    expect(service.manager.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'suite',
      suite, baseline: expect.objectContaining({ artifact: expect.objectContaining({ artifactId: 'baseline' }) }),
      candidate: expect.objectContaining({ artifact: expect.objectContaining({ artifactId: 'candidate' }) }),
      provider: expect.objectContaining({ provider: 'openai', model: 'gpt-test' }),
      requestedBy: 'user:developer',
      timeoutMs: 45_000,
    }))
  })

  it('uses stable validation errors for missing providers, unknown config, media type, and size', async () => {
    const base = { suiteId: 'suite-1', baselineRef: 'local-scan:baseline', candidateRef: 'github:candidate', requestedBy: 'qa' }
    const missing = await call('POST', '/api/evaluation-runs', base)
    expect(missing.response.statusCode).toBe(422)
    expect(missing.json.error.code).toBe('VALIDATION_FAILED')
    const implementation = await call('POST', '/api/evaluation-runs', { ...base, provider: { provider: 'openai', apiKey: 'key', implementation: 'exec:node' } })
    expect(implementation.response.statusCode).toBe(422)
    expect(implementation.json.error.message).toContain('unsupported field')
    const media = await call('POST', '/api/evaluation-runs', { ...base, provider: {} }, services(), { 'content-type': 'text/plain' })
    expect(media.response.statusCode).toBe(415)
    const oversized = await call('POST', '/api/evaluation-runs', { ...base, provider: {} }, services(), { 'content-length': '600000' })
    expect(oversized.response.statusCode).toBe(413)
  })

  it('supports run filters, safe case pagination, detail, and explicit cancellation', async () => {
    const service = services()
    const list = await call('GET', '/api/evaluation-runs?status=completed&suiteId=suite-1&capabilityId=cap-1&limit=10&cursor=old', undefined, service)
    expect(service.store.listRuns).toHaveBeenCalledWith({ status: 'completed', suiteId: 'suite-1', capabilityId: 'cap-1', limit: '10', cursor: 'old' })
    expect(list.json.items).toEqual([summary])
    expect(list.json.generatedAt).toEqual(expect.any(String))
    expect((await call('GET', '/api/evaluation-runs/run-1', undefined, service)).json).toEqual(summary)
    const cases = await call('GET', '/api/evaluation-runs/run-1/cases?limit=1', undefined, service)
    expect(cases.json).toEqual({
      items: [expect.objectContaining({ id: 'case-1:1' })],
      nextCursor: 'case-1:1',
      generatedAt: expect.any(String),
    })
    const cancelled = await call('POST', '/api/evaluation-runs/run-1/cancel', {}, service)
    expect(cancelled.json.cancelled).toBe(true)
  })

  it('stores only an allowlisted managed decision and returns it across reloads', async () => {
    const completed = {
      ...summary,
      mode: 'suite',
      status: 'completed',
      candidate: artifact('candidate', 'b').artifact,
      policyHash: 'd'.repeat(64),
      evidenceHash: 'e'.repeat(64),
    }
    const service = services({ policyHash: completed.policyHash })
    service.store.getRun.mockResolvedValue(completed)
    expect((await call('GET', '/api/evaluation-runs/run-1', undefined, service)).json.evidenceFresh).toBe(true)
    const created = await call('POST', '/api/evaluations/run-1/decision', { decision: 'keep-baseline' }, service)
    expect(created.response.statusCode).toBe(201)
    expect(created.json).toEqual({
      decision: expect.objectContaining({
        decisionId: expect.stringMatching(/^decision_[a-f0-9]{64}$/),
        evaluationRunId: 'run-1',
        decision: 'keep-baseline',
      }),
      reused: false,
      generatedAt: expect.any(String),
      revision: expect.stringMatching(/^decision_[a-f0-9]{64}$/),
    })
    expect(service.store.appendDecision).toHaveBeenCalledWith('run-1', 'keep-baseline')

    service.store.getDecision.mockResolvedValue({ ...created.json.decision, rationale: 'private rationale', rawOutput: 'private output' })
    const canonical = {
      decision: created.json.decision,
      generatedAt: expect.any(String),
      revision: created.json.decision.decisionId,
    }
    expect((await call('GET', '/api/evaluations/run-1/decision', undefined, service)).json).toEqual(canonical)
    expect((await call('GET', '/api/evaluation-runs/run-1/decision', undefined, service)).json).toEqual(canonical)
    const rejected = await call('POST', '/api/evaluations/run-1/decision', { decision: 'keep-baseline', rawOutput: 'secret' }, service)
    expect(rejected.response.statusCode).toBe(422)
    expect(rejected.response.body).not.toContain('secret')
  })

  it('fails closed when Create Candidate evidence lacks current complete Suite coverage', async () => {
    const completed = {
      ...summary,
      mode: 'suite',
      status: 'completed',
      candidate: artifact('candidate', 'b').artifact,
      metrics: { casesTotal: 1, eligibleCases: 2, suiteCaseCoveragePct: 50 },
      policyHash: 'd'.repeat(64),
      gates: [{ id: 'suite-case-coverage', status: 'failed', blocking: true }],
      gateResult: 'failed',
      evidenceHash: 'e'.repeat(64),
    }
    const service = services({ policyHash: completed.policyHash })
    service.store.getRun.mockResolvedValue(completed)

    const rejected = await call('POST', '/api/evaluations/run-1/decision', { decision: 'create-candidate' }, service)
    expect(rejected.response.statusCode).toBe(409)
    expect(rejected.json.error.message).toContain('complete Suite case coverage')
    expect(service.store.appendDecision).not.toHaveBeenCalled()

    service.store.getRun.mockResolvedValue({
      ...completed,
      metrics: { ...completed.metrics, casesTotal: 2, suiteCaseCoveragePct: 100 },
      gates: [{ id: 'suite-case-coverage', status: 'passed', blocking: true }],
      gateResult: 'passed',
    })
    expect((await call('POST', '/api/evaluations/run-1/decision', { decision: 'create-candidate' }, service)).response.statusCode).toBe(201)
  })

  it('exports sanitized JSON and inert HTML reports', async () => {
    const service = services()
    const reportSummary = {
      id: 'run-1', mode: 'suite', status: 'completed', suiteId: 'suite-1', suiteVersion: '1.0.0',
      suiteHash: 'c'.repeat(64), datasetHash: null, baseline: artifact('baseline', 'a').artifact,
      candidate: artifact('candidate', 'b').artifact, engine: { name: 'promptfoo', version: '0.121.19' },
      provider: { id: 'openai', model: '<script>alert(1)</script>' }, metrics: null, policyHash: null, gates: [],
      evidenceHash: 'd'.repeat(64), gateResult: 'passed', requestedBy: 'qa',
      requestedAt: '2026-07-22T00:00:00.000Z', startedAt: '2026-07-22T00:00:01.000Z',
      completedAt: '2026-07-22T00:00:02.000Z', errorCode: null,
    }
    service.store.getRun.mockResolvedValue(reportSummary)
    service.store.getDecision.mockResolvedValue({
      decisionId: `decision_${'c'.repeat(64)}`,
      evaluationRunId: reportSummary.id,
      artifactId: reportSummary.candidate.artifactId,
      candidateRefHash: reportSummary.candidate.contentHash,
      decision: 'keep-baseline',
      recordedAt: '2026-07-25T12:00:00.000Z',
      rationale: 'sentinel-private-rationale',
      rawOutput: 'sentinel-private-output',
    })
    const json = await call('GET', '/api/evaluation-runs/run-1/report?format=json', undefined, service)
    expect(json.json).toEqual({
      schemaVersion: 1,
      summary: expect.objectContaining({ id: 'run-1' }),
      cases: expect.any(Array),
      decision: {
        decisionId: `decision_${'c'.repeat(64)}`,
        evaluationRunId: 'run-1',
        artifactId: reportSummary.candidate.artifactId,
        candidateRefHash: reportSummary.candidate.contentHash,
        decision: 'keep-baseline',
        recordedAt: '2026-07-25T12:00:00.000Z',
      },
    })
    expect(json.response.body).not.toContain('private test input')
    expect(json.response.body).not.toContain('sentinel-private-rationale')
    expect(json.response.body).not.toContain('sentinel-private-output')

    const res = response()
    await handleManagedEvaluationApi(request('GET', '/api/evaluation-runs/run-1/report?format=html'), res, '/api/evaluation-runs/run-1/report', { managedEvaluationServices: service })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.body).toContain('SkillOps Evaluation Report')
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(res.body).not.toContain('<script>alert(1)</script>')
  })


  it('returns a conflict for duplicates and hides unexpected exception details', async () => {
    const duplicate = services({ manager: { enqueue: vi.fn().mockRejectedValue(new EvaluationError('An active evaluation already exists.', 409)), cancel: vi.fn() } })
    const body = {
      suiteId: 'suite-1', baselineRef: 'local-scan:baseline', candidateRef: 'github:candidate',
      provider: { provider: 'openai', model: 'gpt-test', apiKey: 'key' }, requestedBy: 'qa',
    }
    const conflict = await call('POST', '/api/evaluation-runs', body, duplicate)
    expect(conflict.response.statusCode).toBe(409)
    expect(conflict.json.error.code).toBe('CONFLICT')
    const broken = services({ suites: { list: vi.fn().mockRejectedValue(new Error('sensitive stack detail')), get: vi.fn() } })
    const failure = await call('GET', '/api/evaluation-suites', undefined, broken)
    expect(failure.response.statusCode).toBe(500)
    expect(failure.response.body).not.toContain('sensitive stack detail')
  })

  it('rejects non-loopback requests and returns false for unrelated routes', async () => {
    const res = response()
    const forged = request('GET', '/api/evaluation-runs')
    forged.socket.remoteAddress = '10.0.0.7'
    expect(await handleManagedEvaluationApi(forged, res, '/api/evaluation-runs', { managedEvaluationServices: services() })).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(await handleManagedEvaluationApi(request('GET', '/api/events'), response(), '/api/events', { managedEvaluationServices: services() })).toBe(false)
  })
})
