// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagedEvaluations } from './ManagedEvaluations'

const artifact = (id: string, hash: string) => ({
  kind: 'skill' as const, artifactId: id, version: '1.0.0', source: 'github' as const, sourceRef: `github:${id}`, contentHash: hash.repeat(64),
})
const suite = {
  id: 'suite-1', name: 'Quality suite', version: '1.0.0', owner: 'qa', sensitivity: 'synthetic', artifactKind: 'skill',
  repeats: 1, caseCount: 1, suiteHash: 'c'.repeat(64), datasetHash: null, datasetId: null,
}
const baseRun = {
  id: 'run-1', mode: 'suite' as const, status: 'completed' as const, suiteId: 'suite-1', suiteVersion: '1.0.0',
  suiteHash: suite.suiteHash, datasetHash: null, baseline: artifact('baseline', 'a'), candidate: artifact('candidate', 'b'),
  engine: { name: 'promptfoo' as const, version: '0.121.19' }, provider: { id: 'openai', model: 'gpt-test' },
  metrics: {
    baselineScore: 80, candidateScore: 90, scoreDeltaPp: 10, casesPassed: 1, casesTotal: 1, eligibleCases: 1, suiteCaseCoveragePct: 100, passRatePct: 100,
    regressionRatePct: 0, baselineTokens: null, candidateTokens: null, baselineCostUsd: null, candidateCostUsd: null,
    costDeltaPct: null, baselineP95LatencyMs: 10, candidateP95LatencyMs: null, latencyDeltaPct: null,
    criticalFindings: 0, highFindings: 0,
  },
  policyHash: 'd'.repeat(64), gates: [{ id: 'suite-case-coverage', status: 'passed' as const, blocking: true }],
  evidenceHash: 'e'.repeat(64), gateResult: 'passed' as const, requestedBy: 'qa', requestedAt: '2026-07-21T00:00:00.000Z',
  startedAt: '2026-07-21T00:00:01.000Z', completedAt: '2026-07-21T00:00:02.000Z', errorCode: null, evidenceFresh: true,
}
const caseResult = {
  id: 'case-1:1', caseId: 'case-1',
  baseline: { pass: true, score: 80, assertions: [{ label: 'baseline-only assertion', type: 'contains', blocking: true, pass: true, score: 80 }] },
  candidate: { pass: true, score: 100, assertions: [{ label: 'required phrase', type: 'contains', blocking: true, pass: true, score: 100 }] },
}

function response(body: unknown, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body })
}

const capabilityLookup = (runId: string) => `/api/capabilities?evaluationRunId=${encodeURIComponent(runId)}&pageSize=20`

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function configureOpenAi() {
  fireEvent.click(screen.getByRole('button', { name: 'Configure AI' }))
  const dialog = screen.getByRole('dialog', { name: 'AI settings' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'OpenAI' }))
  fireEvent.change(within(dialog).getByPlaceholderText('Enter OpenAI API key'), { target: { value: 'session-secret' } })
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Model' }), { target: { value: 'gpt-test' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save settings' }))
}

describe('managed evaluations UI', () => {
  it('requests Managed Suite definition pages from the server', async () => {
    const lastSuite = { ...suite, id: 'suite-51', name: 'Last suite' }
    const fetchMock = vi.fn((input: string) => {
      if (input === '/api/evaluation-suites') return response({
        items: [suite], page: 1, pageSize: 50, totalItems: 51, totalPages: 2, hasPrevious: false, hasNext: true,
      })
      if (input === '/api/evaluation-suites?page=2&pageSize=50') return response({
        items: [lastSuite], page: 2, pageSize: 50, totalItems: 51, totalPages: 2, hasPrevious: true, hasNext: false,
      })
      if (input === '/api/evaluation-runs?limit=50') return response({ items: [] })
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ManagedEvaluations tab="suites" />)
    expect(await screen.findByText('Quality suite')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))

    expect(await screen.findByText('Last suite')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/evaluation-suites?page=2&pageSize=50', undefined)
    expect(screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(true)
  })

  it('moves through Managed History cursor pages without hiding older runs', async () => {
    const olderRun = {
      ...baseRun,
      id: 'run-older',
      requestedAt: '2026-07-20T00:00:00.000Z',
      candidate: artifact('older-candidate', 'f'),
    }
    let releaseOlder!: () => void
    const olderPage = new Promise((resolve) => {
      releaseOlder = () => resolve({ ok: true, status: 200, json: async () => ({ items: [olderRun], nextCursor: null }) })
    })
    const fetchMock = vi.fn((input: string) => {
      if (input === '/api/evaluation-suites') return response({ items: [suite] })
      if (input === '/api/evaluation-runs?limit=50') return response({ items: [baseRun], nextCursor: 'run-1' })
      if (input === '/api/evaluation-runs?limit=50&cursor=run-1') return olderPage
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ManagedEvaluations tab="history" />)
    expect(await screen.findByText(/candidate · 1.0.0/)).toBeTruthy()
    const nextPage = screen.getByRole('button', { name: 'Next page' })
    fireEvent.click(nextPage)
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => input === '/api/evaluation-runs?limit=50&cursor=run-1')).toHaveLength(1))
    expect(nextPage.hasAttribute('disabled')).toBe(true)
    fireEvent.click(nextPage)
    expect(fetchMock.mock.calls.filter(([input]) => input === '/api/evaluation-runs?limit=50&cursor=run-1')).toHaveLength(1)
    releaseOlder()
    expect(await screen.findByText(/older-candidate · 1.0.0/)).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/evaluation-runs?limit=50&cursor=run-1', undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    expect(await screen.findByText(/candidate · 1.0.0/)).toBeTruthy()
  })

  it('restores persisted history, displays null metrics as unavailable, and filters safe case metadata', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string) => {
      if (input === '/api/evaluation-suites') return response({ items: [suite] })
      if (input === '/api/evaluation-runs?limit=50') return response({ items: [baseRun] })
      if (input.includes('/cases')) return response({ items: [caseResult], nextCursor: null })
      if (input.includes('/decision')) return response({ decision: null })
      return response({ error: { message: 'Not found' } }, 404)
    }))
    render(<ManagedEvaluations tab="history" />)
    const historyRun = await screen.findByRole('button', { name: /Completed.*suite-1.*candidate/ })
    fireEvent.click(historyRun)
    expect(await screen.findByText('Case results')).toBeTruthy()
    expect(screen.getByText('+10.0 pp')).toBeTruthy()
    expect(screen.getByText('1 passed · 0 failed · 0 errors · 0 skipped')).toBeTruthy()
    expect(screen.getByText('1 / 1 (100.0%)')).toBeTruthy()
    expect(screen.getByText('0 regressions')).toBeTruthy()
    expect(screen.getByText('Evidence is current')).toBeTruthy()
    expect(screen.getByText('Candidate meets the configured release gate.')).toBeTruthy()
    for (const action of ['Create Candidate', 'Keep Baseline', 'Reject Candidate', 'Collect More Evidence']) {
      expect(screen.getByRole('button', { name: action })).toBeTruthy()
    }
    expect(screen.getAllByText('Not available').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/baseline-only assertion.*required phrase/)).toBeTruthy()
    expect(screen.getByText('80.0')).toBeTruthy()
    expect(screen.getByText('100.0')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter by case or assertion' }), { target: { value: 'baseline-only' } })
    expect(screen.getByText('case-1')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter by case or assertion' }), { target: { value: 'missing' } })
    expect(screen.queryByText('case-1')).toBeNull()
    expect(screen.getByText(/full prompts and model outputs are not returned/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Download JSON report' }).getAttribute('href')).toBe('/api/evaluation-runs/run-1/report?format=json')
    expect(screen.getByRole('link', { name: 'Open HTML report' }).getAttribute('href')).toBe('/api/evaluation-runs/run-1/report?format=html')
  })

  it('shows recovered partial history and fails closed for legacy evidence without authoritative coverage', async () => {
    const legacyRun = {
      ...baseRun,
      metrics: { ...baseRun.metrics, eligibleCases: null, suiteCaseCoveragePct: null },
      gates: [{ id: 'pass-rate', status: 'passed' as const, blocking: true }],
    }
    const fetchMock = vi.fn((input: string) => {
      if (input === '/api/evaluation-suites') return response({ items: [suite] })
      if (input === '/api/evaluation-runs?limit=50') return response({ items: [legacyRun], sourceStatus: 'partial' })
      if (input.includes('/cases')) return response({ items: [caseResult], nextCursor: null })
      if (input.includes('/decision')) return response({ decision: null })
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ManagedEvaluations tab="history" />)
    expect((await screen.findByRole('alert')).textContent).toContain('Some local sources are unavailable or partial.')
    fireEvent.click(await screen.findByRole('button', { name: /Completed.*suite-1.*candidate/ }))
    await screen.findByText('Case results')
    fireEvent.change(screen.getByRole('textbox', { name: 'Target skeleton' }), { target: { value: 'codex:review' } })
    expect(screen.getAllByText('Not available').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: 'Create Candidate' }).hasAttribute('disabled')).toBe(true)
  })

  it('keeps the page usable and marks History partial when its noncritical store is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string) => {
      if (input === '/api/evaluation-suites') return response({ items: [suite] })
      if (input === '/api/evaluation-runs?limit=50') return response({ error: { message: 'Unavailable' } }, 500)
      return response({ error: { message: 'Not found' } }, 404)
    }))

    render(<ManagedEvaluations tab="history" />)
    expect((await screen.findByRole('alert')).textContent).toContain('Some local sources are unavailable or partial.')
    expect(screen.getByText('No managed evaluation runs yet.')).toBeTruthy()
  })

  it('starts a queued run with page-memory settings and cancels it explicitly', async () => {
    const queued = { ...baseRun, id: 'run-queued', status: 'queued' as const, metrics: null, policyHash: null, gates: [], evidenceHash: null, gateResult: 'not-evaluated' as const, startedAt: null, completedAt: null }
    const cancelled = { ...queued, status: 'cancelled' as const, completedAt: '2026-07-21T00:00:03.000Z', errorCode: 'CANCELLED' }
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/evaluation-suites') return response({ items: [suite] })
      if (input === '/api/evaluation-runs?limit=50') return response({ items: [] })
      if (input === '/api/evaluation-runs' && init?.method === 'POST') return response({ run: queued, reused: false }, 202)
      if (input === '/api/evaluation-runs/run-queued/cancel') return response({ summary: cancelled, cancelled: true })
      if (input === '/api/evaluation-runs/run-queued') return response(queued)
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ManagedEvaluations tab="suites" />)
    expect(await screen.findByText('Quality suite')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Baseline reference' }), { target: { value: 'local-scan:baseline' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Candidate reference' }), { target: { value: 'github:candidate#SKILL.md' } })
    await configureOpenAi()
    fireEvent.click(screen.getByRole('button', { name: 'Review preflight' }))
    expect(screen.getByRole('region', { name: 'Managed Suite preflight' }).textContent).toContain('1 eligible cases')
    expect(screen.getByRole('region', { name: 'Managed Suite preflight' }).textContent).toContain('Artifact content, suite case inputs, assertion criteria, and judge context.')
    fireEvent.click(screen.getByRole('button', { name: 'Start evaluation' }))
    expect(await screen.findByText(/server queue/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('Cancelled')).toBeTruthy()
    const createCall = fetchMock.mock.calls.find(([input, init]) => input === '/api/evaluation-runs' && init?.method === 'POST')
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual(expect.objectContaining({
      baselineRef: 'local-scan:baseline', candidateRef: 'github:candidate#SKILL.md',
      provider: expect.objectContaining({ apiKey: 'session-secret', model: 'gpt-test' }),
    }))
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
  })

  it('polls an active run and stops after the terminal summary arrives', async () => {
    const queued = { ...baseRun, id: 'run-poll', status: 'queued' as const, metrics: null, policyHash: null, gates: [], evidenceHash: null, gateResult: 'not-evaluated' as const, startedAt: null, completedAt: null }
    let polls = 0
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/evaluation-suites') return response({ items: [suite] })
      if (input === '/api/evaluation-runs?limit=50') return response({ items: polls ? [baseRun] : [] })
      if (input === '/api/evaluation-runs' && init?.method === 'POST') return response({ run: queued }, 202)
      if (input === '/api/evaluation-runs/run-poll') { polls += 1; return response({ ...baseRun, id: 'run-poll' }) }
      if (input.includes('/run-poll/cases')) return response({ items: [caseResult] })
      if (input.includes('/decision')) return response({ decision: null })
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ManagedEvaluations tab="suites" />)
    expect(await screen.findByText('Quality suite')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Baseline reference' }), { target: { value: 'local-scan:baseline' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Candidate reference' }), { target: { value: 'github:candidate#SKILL.md' } })
    await configureOpenAi()
    fireEvent.click(screen.getByRole('button', { name: 'Review preflight' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start evaluation' }))
    expect(await screen.findByText(/server queue/)).toBeTruthy()
    expect(await screen.findByText('Case results', {}, { timeout: 2_000 })).toBeTruthy()
    expect(polls).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 1_050))
    expect(polls).toBe(1)
  })

  it('creates a validated Candidate without asking for internal IDs and records idempotent decisions', async () => {
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/evaluation-suites') return response({ items: [suite] })
      if (input === '/api/evaluation-runs?limit=50') return response({ items: [baseRun] })
      if (input.includes('/cases')) return response({ items: [caseResult], nextCursor: null })
      if (input.endsWith('/decision') && init?.method === 'POST') {
        const decision = JSON.parse(String(init.body)).decision
        return response({ decision: { decisionId: `decision_${'c'.repeat(64)}`, evaluationRunId: 'run-1', artifactId: 'candidate', candidateRefHash: 'b'.repeat(64), decision, recordedAt: '2026-07-25T12:00:00.000Z' }, reused: false }, 201)
      }
      if (input.endsWith('/decision')) return response({ decision: null })
      if (input === '/api/capabilities' && init?.method === 'POST') {
        return response({ capability: { id: 'cap-1', latestEvidenceRunId: null }, reused: false }, 201)
      }
      if (input === '/api/capabilities/cap-1/evaluate') return response({ id: 'cap-1', stage: 'ready', latestEvidenceRunId: 'run-1' })
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ManagedEvaluations tab="history" />)
    fireEvent.click(await screen.findByRole('button', { name: /Completed.*suite-1.*candidate/ }))
    await screen.findByText('Case results')
    fireEvent.change(screen.getByRole('textbox', { name: 'Target skeleton' }), { target: { value: 'local-scan:codex:C:/skills/review/SKILL.md' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Candidate' }))
    expect((await screen.findByRole('link', { name: 'Open Releases' })).getAttribute('href')).toBe('/releases?capability=cap-1')

    const nomination = fetchMock.mock.calls.find(([input]) => input === '/api/capabilities')
    expect(JSON.parse(String(nomination?.[1]?.body))).toEqual({
      artifact: baseRun.candidate,
      baseline: baseRun.baseline,
      targetSkeleton: 'local-scan:codex:C:/skills/review/SKILL.md',
      evaluationRunId: 'run-1',
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/capabilities/cap-1/evaluate', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ runId: 'run-1' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/evaluations/run-1/decision', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ decision: 'create-candidate' }),
    }))
  })

  it('continues an origin-reserved Candidate whose evidence bind was interrupted', async () => {
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/evaluation-suites') return response({ items: [suite] })
      if (input === '/api/evaluation-runs?limit=50') return response({ items: [baseRun] })
      if (input.includes('/cases')) return response({ items: [caseResult], nextCursor: null })
      if (input === '/api/evaluations/run-1/decision') {
        return response({ decision: {
          decisionId: `decision_${'c'.repeat(64)}`,
          evaluationRunId: 'run-1',
          artifactId: 'candidate',
          candidateRefHash: 'b'.repeat(64),
          decision: 'create-candidate',
          recordedAt: '2026-07-25T12:00:00.000Z',
        } })
      }
      if (input === capabilityLookup('run-1')) return response({ items: [{ id: 'cap-existing', targetSkeleton: 'codex:review', originEvaluationRunId: 'run-1', latestEvidenceRunId: null }] })
      if (input === '/api/capabilities/cap-existing/evaluate' && init?.method === 'POST') return response({ id: 'cap-existing', latestEvidenceRunId: 'run-1' })
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ManagedEvaluations tab="history" />)
    fireEvent.click(await screen.findByRole('button', { name: /Completed.*suite-1.*candidate/ }))

    fireEvent.click(await screen.findByRole('button', { name: 'Continue Candidate' }))
    expect((await screen.findByRole('link', { name: 'Open Releases' })).getAttribute('href')).toBe('/releases?capability=cap-existing')
    expect(fetchMock).toHaveBeenCalledWith('/api/capabilities/cap-existing/evaluate', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ runId: 'run-1' }),
    }))
    expect(fetchMock.mock.calls.some(([input, init]) => input === '/api/capabilities' && init?.method === 'POST')).toBe(false)
    expect(screen.getByRole('button', { name: 'Keep Baseline' }).hasAttribute('disabled')).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/api/evaluations/run-1/decision', undefined)
  })

  it('keeps a re-evaluated Candidate complete instead of rebinding its older origin run', async () => {
    const fetchMock = vi.fn((input: string) => {
      if (input === '/api/evaluation-suites') return response({ items: [suite] })
      if (input === '/api/evaluation-runs?limit=50') return response({ items: [baseRun] })
      if (input.includes('/cases')) return response({ items: [caseResult], nextCursor: null })
      if (input === '/api/evaluations/run-1/decision') return response({ decision: {
        decisionId: `decision_${'c'.repeat(64)}`,
        evaluationRunId: 'run-1',
        artifactId: 'candidate',
        candidateRefHash: 'b'.repeat(64),
        decision: 'create-candidate',
        recordedAt: '2026-07-25T12:00:00.000Z',
      } })
      if (input === capabilityLookup('run-1')) return response({ items: [{
        id: 'cap-mature',
        targetSkeleton: 'codex:review',
        originEvaluationRunId: 'run-1',
        latestEvidenceRunId: 'run-2',
      }] })
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ManagedEvaluations tab="history" />)
    fireEvent.click(await screen.findByRole('button', { name: /Completed.*suite-1.*candidate/ }))

    expect((await screen.findByRole('link', { name: 'Open Releases' })).getAttribute('href')).toBe('/releases?capability=cap-mature')
    expect(screen.getByRole('button', { name: 'Create Candidate' }).hasAttribute('disabled')).toBe(true)
    expect(fetchMock.mock.calls.some(([input]) => input === '/api/capabilities/cap-mature/evaluate')).toBe(false)
  })

  it('fails closed when legacy data maps one run to multiple Candidates', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string) => {
      if (input === '/api/evaluation-suites') return response({ items: [suite] })
      if (input === '/api/evaluation-runs?limit=50') return response({ items: [baseRun] })
      if (input.includes('/cases')) return response({ items: [caseResult], nextCursor: null })
      if (input === '/api/evaluations/run-1/decision') return response({ decision: {
        decisionId: `decision_${'c'.repeat(64)}`,
        evaluationRunId: 'run-1',
        artifactId: 'candidate',
        candidateRefHash: 'b'.repeat(64),
        decision: 'create-candidate',
        recordedAt: '2026-07-25T12:00:00.000Z',
      } })
      if (input === capabilityLookup('run-1')) return response({ items: [
        { id: 'cap-one', originEvaluationRunId: 'run-1', latestEvidenceRunId: null },
        { id: 'cap-two', latestEvidenceRunId: 'run-1' },
      ] })
      return response({ error: { message: 'Not found' } }, 404)
    }))

    render(<ManagedEvaluations tab="history" />)
    fireEvent.click(await screen.findByRole('button', { name: /Completed.*suite-1.*candidate/ }))

    expect((await screen.findByRole('alert')).textContent).toContain('multiple legacy Candidate matches')
    expect(screen.queryByRole('link', { name: 'Open Releases' })).toBeNull()
  })

  it('drops out-of-order Candidate state when another run is selected', async () => {
    const runA = { ...baseRun, id: 'run-a', requestedAt: '2026-07-21T00:00:00.000Z' }
    const runB = { ...baseRun, id: 'run-b', requestedAt: '2026-07-22T00:00:00.000Z' }
    let releaseCapabilities!: () => void
    let markCapabilitiesRead!: () => void
    const capabilitiesRead = new Promise<void>((resolve) => { markCapabilitiesRead = resolve })
    const delayedCapabilities = new Promise((resolve) => {
      releaseCapabilities = () => resolve({
        ok: true,
        status: 200,
        json: async () => {
          markCapabilitiesRead()
          return { items: [{ id: 'cap-a', targetSkeleton: 'codex:a', originEvaluationRunId: 'run-a', latestEvidenceRunId: null }] }
        },
      })
    })
    const createDecision = (runId: string) => ({
      decisionId: `decision_${'c'.repeat(64)}`,
      evaluationRunId: runId,
      artifactId: 'candidate',
      candidateRefHash: 'b'.repeat(64),
      decision: 'create-candidate',
      recordedAt: '2026-07-25T12:00:00.000Z',
    })
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/evaluation-suites') return response({ items: [suite] })
      if (input === '/api/evaluation-runs?limit=50') return response({ items: [runA, runB] })
      if (input.includes('/cases')) return response({ items: [caseResult], nextCursor: null })
      if (input === '/api/evaluations/run-a/decision') return response({ decision: createDecision('run-a') })
      if (input === '/api/evaluations/run-b/decision' && init?.method === 'POST') return response({ decision: createDecision('run-b') }, 201)
      if (input === '/api/evaluations/run-b/decision') return response({ decision: null })
      if (input === capabilityLookup('run-a') && !init?.method) return delayedCapabilities
      if (input === '/api/capabilities' && init?.method === 'POST') return response({ capability: { id: 'cap-b', latestEvidenceRunId: null } }, 201)
      if (input === '/api/capabilities/cap-b/evaluate') return response({ id: 'cap-b', latestEvidenceRunId: 'run-b' })
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ManagedEvaluations tab="history" />)
    const rows = await screen.findAllByRole('button', { name: /Completed.*suite-1.*candidate/ })
    fireEvent.click(rows[0])
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(capabilityLookup('run-a'), undefined))
    fireEvent.click(rows[1])
    expect(await screen.findByText(/run-b · promptfoo/)).toBeTruthy()

    releaseCapabilities()
    await capabilitiesRead
    fireEvent.change(screen.getByRole('textbox', { name: 'Target skeleton' }), { target: { value: 'codex:b' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create Candidate' }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Create Candidate' }))

    expect((await screen.findByRole('link', { name: 'Open Releases' })).getAttribute('href')).toBe('/releases?capability=cap-b')
    expect(fetchMock.mock.calls.some(([input]) => input === '/api/capabilities/cap-a/evaluate')).toBe(false)
    const nomination = fetchMock.mock.calls.find(([input, init]) => input === '/api/capabilities' && init?.method === 'POST')
    expect(JSON.parse(String(nomination?.[1]?.body))).toEqual(expect.objectContaining({ evaluationRunId: 'run-b' }))
  })

  it('uses a selection generation so an A-B-A response cannot restore stale Candidate state', async () => {
    const runA = { ...baseRun, id: 'run-a', requestedAt: '2026-07-21T00:00:00.000Z' }
    const runB = { ...baseRun, id: 'run-b', requestedAt: '2026-07-22T00:00:00.000Z' }
    let releaseFirstCapabilities!: () => void
    let markFirstCapabilitiesRead!: () => void
    const firstCapabilitiesRead = new Promise<void>((resolve) => { markFirstCapabilitiesRead = resolve })
    const firstCapabilities = new Promise((resolve) => {
      releaseFirstCapabilities = () => resolve({
        ok: true,
        status: 200,
        json: async () => {
          markFirstCapabilitiesRead()
          return { items: [{ id: 'cap-old', originEvaluationRunId: 'run-a', latestEvidenceRunId: null }] }
        },
      })
    })
    let capabilityReads = 0
    const decision = {
      decisionId: `decision_${'c'.repeat(64)}`,
      evaluationRunId: 'run-a',
      artifactId: 'candidate',
      candidateRefHash: 'b'.repeat(64),
      decision: 'create-candidate',
      recordedAt: '2026-07-25T12:00:00.000Z',
    }
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/evaluation-suites') return response({ items: [suite] })
      if (input === '/api/evaluation-runs?limit=50') return response({ items: [runA, runB] })
      if (input.includes('/cases')) return response({ items: [caseResult], nextCursor: null })
      if (input === '/api/evaluations/run-a/decision') return response({ decision })
      if (input === '/api/evaluations/run-b/decision') return response({ decision: null })
      if (input === capabilityLookup('run-a') && !init?.method) {
        capabilityReads += 1
        return capabilityReads === 1
          ? firstCapabilities
          : response({ items: [{ id: 'cap-mature', originEvaluationRunId: 'run-a', latestEvidenceRunId: 'run-y' }] })
      }
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ManagedEvaluations tab="history" />)
    const rows = await screen.findAllByRole('button', { name: /Completed.*suite-1.*candidate/ })
    fireEvent.click(rows[0])
    await waitFor(() => expect(capabilityReads).toBe(1))
    fireEvent.click(rows[1])
    expect(await screen.findByText(/run-b · promptfoo/)).toBeTruthy()
    fireEvent.click(rows[0])
    expect((await screen.findByRole('link', { name: 'Open Releases' })).getAttribute('href')).toBe('/releases?capability=cap-mature')

    releaseFirstCapabilities()
    await firstCapabilitiesRead
    await waitFor(() => expect(screen.getByRole('link', { name: 'Open Releases' }).getAttribute('href')).toBe('/releases?capability=cap-mature'))
    expect(screen.queryByRole('button', { name: 'Continue Candidate' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Create Candidate' }).hasAttribute('disabled')).toBe(true)
  })
})
