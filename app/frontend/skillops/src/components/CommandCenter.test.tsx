// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n/I18nProvider'
import { CommandCenter, type CommandCenterSnapshot } from './CommandCenter'

const snapshot: CommandCenterSnapshot = {
  generatedAt: '2026-07-25T12:00:00.000Z',
  scope: { runtime: 'all', days: 7 },
  sources: { events: 'ok', connections: 'ok', provider: 'ok' },
  readiness: {
    level: 'ready',
    verifiedRuntimes: ['codex'],
    installedRuntimes: ['codex'],
    providerConfigured: false,
    items: [
      { id: 'runtime', state: 'ready', label: 'Runtime connections', checkedAt: '2026-07-25T12:00:00.000Z', evidenceAt: '2026-07-25T11:55:00.000Z', href: '/settings?section=connections' },
    ],
  },
  metrics: {
    terminalRuns: 2,
    knownOutcomes: 0,
    successRate: { numerator: 0, denominator: 0, value: null, label: 'Known outcomes' },
    runtimeOutcomeCoverage: { numerator: 0, denominator: 2, value: 0, label: 'Runtime outcome coverage' },
    reportedCostUsd: null,
    costCoverage: { numerator: 0, denominator: 2, value: 0, label: 'Cost coverage' },
    observedAssets: 1,
  },
  metricDefinitions: {
    terminalRuns: 'terminal events in the selected period',
    knownOutcomes: 'terminal runs with explicit outcomes',
    successRate: 'known success / known outcomes',
    runtimeOutcomeCoverage: 'known outcomes / terminal runs',
    observedAssets: 'distinct observed Skills',
    reportedCostUsd: 'sum of reported costs',
    costCoverage: 'reported costs / terminal runs',
  },
  issues: [
    { id: 'review-unknown-outcomes', priority: 80, severity: 'medium', href: '/activity?tab=runs&outcome=unknown', data: { count: 2 } },
    { id: 'review-cost-coverage', priority: 70, severity: 'low', href: '/activity?tab=runs&cost=unreported', data: { reported: 0, total: 2 } },
    { id: 'configure-provider', priority: 40, severity: 'low', href: '/benchmarks?tab=suites&configure=provider', data: {} },
  ],
  nextActions: [],
  recentActivity: [],
}
snapshot.nextActions = [
  {
    id: 'review-unknown-outcomes',
    priority: 'trust',
    title: 'Review unknown outcomes',
    reason: 'Two terminal runs have unknown outcomes.',
    impact: 'Reduces confidence in the available evidence.',
    evidenceRefs: ['run-outcome:unknown'],
    href: '/activity?tab=runs&outcome=unknown',
    actionLabel: 'Review unknown outcomes',
    severity: 'medium',
  },
  {
    id: 'review-cost-coverage',
    priority: 'maintenance',
    title: 'Review cost coverage',
    reason: 'Two runs do not report cost.',
    impact: 'Can reduce completeness over time.',
    evidenceRefs: ['metric:costCoverage'],
    href: '/activity?tab=runs&cost=unreported',
    actionLabel: 'Review cost coverage',
    severity: 'low',
  },
  {
    id: 'configure-provider',
    priority: 'improvement',
    title: 'Configure an AI provider',
    reason: 'New AI-backed benchmarks need a provider.',
    impact: 'Limits an optional workflow.',
    evidenceRefs: ['provider:not-configured'],
    href: '/benchmarks?tab=suites&configure=provider',
    actionLabel: 'Configure provider',
    severity: 'low',
  },
]

function response(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('Command Center', () => {
  it('renders bounded actions and metric definitions without inventing cost or success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(snapshot)))
    const onOpen = vi.fn()
    render(<CommandCenter runtime="all" days={7} onOpen={onOpen} />)

    expect(await screen.findByRole('heading', { name: 'Readiness' })).toBeTruthy()
    const actions = screen.getByRole('region', { name: 'Next actions' })
    expect(within(actions).getAllByRole('button')).toHaveLength(3)
    expect(screen.getByText('Not reported')).toBeTruthy()
    expect(screen.getByText('N/A')).toBeTruthy()
    expect(screen.getAllByText(/Known success divided by known outcomes; unknown outcomes are excluded\./)).toHaveLength(2)
    expect(screen.getByText('Some terminal runs do not have a known success or failure outcome.')).toBeTruthy()
    expect(screen.getByText('run-outcome:unknown')).toBeTruthy()
    expect(screen.getByText('Reduces confidence in the available evidence.')).toBeTruthy()
    expect(document.querySelector('[data-metric="Runtime outcome coverage"] small')?.textContent).toBe('0 / 2')

    fireEvent.click(within(actions).getByRole('button', { name: 'Review unknown outcomes' }))
    expect(onOpen).toHaveBeenCalledWith('/activity?tab=runs&outcome=unknown')
  })

  it('keeps healthy aggregate sections visible when one source is partial', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      ...snapshot,
      sources: { events: 'partial', connections: 'ok', provider: 'ok' },
      metrics: { ...snapshot.metrics, terminalRuns: 1 },
      recentActivity: [],
    })))
    render(<CommandCenter runtime="all" days={7} onOpen={() => undefined} />)

    expect((await screen.findByRole('alert')).textContent).toContain('Some local sources are unavailable or partial.')
    expect(document.querySelector('[data-metric="Skill runs"] [data-value="1"]')).toBeTruthy()
    expect(screen.getByText('Recent runs may be incomplete because the event source was only partially read.')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Issues' })).toBeTruthy()
  })

  it('does not turn an unavailable event source into factual zero metrics or empty onboarding', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      ...snapshot,
      sources: { ...snapshot.sources, events: 'unavailable' },
      metrics: {
        terminalRuns: 0,
        knownOutcomes: 0,
        successRate: { numerator: 0, denominator: 0, value: null, label: 'Known outcomes' },
        runtimeOutcomeCoverage: { numerator: 0, denominator: 0, value: null, label: 'Runtime outcome coverage' },
        reportedCostUsd: null,
        costCoverage: { numerator: 0, denominator: 0, value: null, label: 'Cost coverage' },
        observedAssets: 0,
      },
      recentActivity: [],
    })))

    render(<CommandCenter runtime="all" days={7} onOpen={() => undefined} />)

    expect((await screen.findByRole('alert')).textContent).toContain('Some local sources are unavailable or partial.')
    expect(screen.queryByRole('heading', { name: 'Connect a runtime to get started' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Metrics' })).toBeNull()
    expect(screen.getByText('Runtime metrics are unavailable while the event source cannot be read.')).toBeTruthy()
    expect(screen.queryByText('No real activity in the selected scope yet.')).toBeNull()
    expect(screen.getByText('Recent runs are unavailable while the event source cannot be read.')).toBeTruthy()
  })

  it('does not infer a disconnected workspace when connection facts are unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      ...snapshot,
      sources: { ...snapshot.sources, connections: 'unavailable' },
      readiness: {
        ...snapshot.readiness,
        level: 'setup',
        verifiedRuntimes: [],
        installedRuntimes: [],
      },
      metrics: {
        ...snapshot.metrics,
        terminalRuns: 0,
        knownOutcomes: 0,
        observedAssets: 0,
        runtimeOutcomeCoverage: { numerator: 0, denominator: 0, value: null, label: 'Runtime outcome coverage' },
        costCoverage: { numerator: 0, denominator: 0, value: null, label: 'Cost coverage' },
      },
      recentActivity: [],
    })))

    render(<CommandCenter runtime="all" days={7} onOpen={() => undefined} />)

    expect(await screen.findByRole('heading', { name: 'Metrics' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Connect a runtime to get started' })).toBeNull()
  })

  it('offers retry and a permanently labeled demo instead of blanking on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))
    const { rerender } = render(<CommandCenter runtime="all" days={7} onOpen={() => undefined} />)

    expect((await screen.findByRole('alert')).textContent).toContain('connection refused')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Use demo dataset' }))
    expect(screen.getAllByText('Demo dataset').length).toBeGreaterThan(0)
    expect(screen.getByText('Synthetic examples are never mixed with local data.')).toBeTruthy()
    expect(screen.queryByText('Configure AI Provider')).toBeNull()

    rerender(<CommandCenter runtime="all" days={14} onOpen={() => undefined} />)
    expect((await screen.findByRole('alert')).textContent).toContain('connection refused')
    expect(screen.getAllByText('Demo dataset').length).toBeGreaterThan(0)
  })

  it('hides raw offline payloads and marks demo primary-content readiness', async () => {
    const rawPayload = '{"code":"ECONNREFUSED","address":"127.0.0.1"}'
    const mark = vi.spyOn(performance, 'mark')
    const measure = vi.spyOn(performance, 'measure')
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { callback(0); return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(rawPayload)))

    render(<CommandCenter runtime="all" days={7} onOpen={() => undefined} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Local aggregate unavailable.')
    expect(alert.textContent).not.toContain(rawPayload)
    fireEvent.click(screen.getByRole('button', { name: 'Use demo dataset' }))
    await screen.findByText('Synthetic examples are never mixed with local data.')
    expect(mark).toHaveBeenCalledWith('skillops:data-received')
    expect(mark).toHaveBeenCalledWith('skillops:primary-content-ready')
    expect(measure).toHaveBeenCalledWith('skillops:primary-content', 'skillops:data-received', 'skillops:primary-content-ready')
  })

  it('hides static HTML fallback parse details when the local API is unavailable', async () => {
    const parseError = `Unexpected token '<', "<!doctype "... is not valid JSON`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError(parseError) },
    }))

    render(<CommandCenter runtime="all" days={7} onOpen={() => undefined} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Local aggregate unavailable.')
    expect(alert.textContent).not.toContain(parseError)
  })

  it('localizes server reason, impact, readiness code, and metric definitions', async () => {
    localStorage.setItem('skillops.locale.v1', 'zh')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      ...snapshot,
      readiness: {
        ...snapshot.readiness,
        items: [{ ...snapshot.readiness.items![0], reasonCode: 'awaiting-verification' }],
      },
    })))

    render(<I18nProvider><CommandCenter runtime="all" days={7} onOpen={() => undefined} /></I18nProvider>)

    expect(await screen.findByText('部分终止运行没有明确的成功或失败结果。')).toBeTruthy()
    expect(screen.getByText('降低现有证据的可信度。')).toBeTruthy()
    expect(screen.getByText('原因代码：awaiting-verification')).toBeTruthy()
    expect(screen.queryByText('Two terminal runs have unknown outcomes.')).toBeNull()
    expect(screen.queryByText('known success / known outcomes')).toBeNull()
  })

  it('shows activation guidance for a disconnected zero-activity workspace', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      ...snapshot,
      readiness: {
        ...snapshot.readiness,
        level: 'setup',
        verifiedRuntimes: [],
        installedRuntimes: [],
      },
      metrics: {
        ...snapshot.metrics,
        terminalRuns: 0,
        knownOutcomes: 0,
        observedAssets: 0,
        runtimeOutcomeCoverage: { numerator: 0, denominator: 0, value: null, label: 'Runtime outcome coverage' },
        costCoverage: { numerator: 0, denominator: 0, value: null, label: 'Cost coverage' },
      },
      nextActions: [],
      issues: [],
    })))
    const onOpen = vi.fn()
    render(<CommandCenter runtime="all" days={7} onOpen={onOpen} />)

    expect(await screen.findByRole('heading', { name: 'Connect a runtime to get started' })).toBeTruthy()
    expect(screen.getByText(/stores allowlisted metadata only/)).toBeTruthy()
    expect(screen.getByText('Three-step quick start')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Metrics' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Quick actions' })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Verify connection' })[0])
    expect(onOpen).toHaveBeenCalledWith('/settings?section=connections')
  })

  it('shows truthful zero metrics instead of connection setup for a verified runtime', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      ...snapshot,
      metrics: {
        ...snapshot.metrics,
        terminalRuns: 0,
        knownOutcomes: 0,
        observedAssets: 0,
        runtimeOutcomeCoverage: { numerator: 0, denominator: 0, value: null, label: 'Runtime outcome coverage' },
        costCoverage: { numerator: 0, denominator: 0, value: null, label: 'Cost coverage' },
      },
      nextActions: [],
      issues: [],
    })))
    render(<CommandCenter runtime="all" days={7} onOpen={() => undefined} />)

    expect(await screen.findByRole('heading', { name: 'Metrics' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Connect a runtime to get started' })).toBeNull()
    expect(screen.getByText('No real activity in the selected scope yet.')).toBeTruthy()
  })

  it('opens every recent run from the server-provided full-row destination', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      ...snapshot,
      recentActivity: [{
        id: 'run-1',
        event: 'skill.completed',
        runtime: 'codex',
        timestamp: '2026-07-25T11:59:00.000Z',
        skillId: 'review',
        outcome: 'success',
        href: '/activity?tab=runs&run=run-1',
      }],
    })))
    const onOpen = vi.fn()
    render(<CommandCenter runtime="all" days={7} onOpen={onOpen} />)

    const row = await screen.findByRole('button', { name: /review.*codex.*success/ })
    fireEvent.click(row)
    expect(onOpen).toHaveBeenCalledWith('/activity?tab=runs&run=run-1')
  })
})
