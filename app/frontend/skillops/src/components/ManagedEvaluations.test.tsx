// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
    baselineScore: 80, candidateScore: 90, scoreDeltaPp: 10, casesPassed: 1, casesTotal: 1, passRatePct: 100,
    regressionRatePct: 0, baselineTokens: null, candidateTokens: null, baselineCostUsd: null, candidateCostUsd: null,
    costDeltaPct: null, baselineP95LatencyMs: 10, candidateP95LatencyMs: null, latencyDeltaPct: null,
    criticalFindings: 0, highFindings: 0,
  },
  policyHash: 'd'.repeat(64), gates: [{ id: 'pass-rate', status: 'passed' as const, blocking: true }],
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
        return response({ decision: { runId: 'run-1', artifactId: 'candidate', candidateHash: 'b'.repeat(64), decision, decidedAt: '2026-07-25T12:00:00.000Z' }, reused: false }, 201)
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
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/capabilities/cap-1/evaluate', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ runId: 'run-1' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/evaluation-runs/run-1/decision', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ decision: 'create-candidate' }),
    }))
  })
})
