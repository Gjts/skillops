// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandCenter, type CommandCenterSnapshot } from './CommandCenter'

const snapshot: CommandCenterSnapshot = {
  generatedAt: '2026-07-25T12:00:00.000Z',
  scope: { runtime: 'all', days: 7 },
  sources: { events: 'ok', connections: 'ok', provider: 'ok' },
  readiness: { level: 'ready', verifiedRuntimes: ['codex'], installedRuntimes: ['codex'], providerConfigured: false },
  metrics: { runs: 2, knownOutcomes: 0, unknownOutcomes: 2, successRate: null, activeSkills: 1, costUsd: null, costReportedRuns: 0, costCoverage: 0 },
  metricDefinitions: {
    runs: 'terminal events in the selected period',
    successRate: 'known success / known outcomes',
    activeSkills: 'distinct observed Skills',
    costUsd: 'sum of reported costs',
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
snapshot.nextActions = snapshot.issues.slice(0, 3)

function response(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

afterEach(() => {
  cleanup()
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
    expect(screen.getByText('Known success divided by known outcomes; unknown outcomes are excluded.')).toBeTruthy()

    fireEvent.click(within(actions).getByRole('button', { name: 'Review unknown outcomes' }))
    expect(onOpen).toHaveBeenCalledWith('/activity?tab=runs&outcome=unknown')
  })

  it('keeps healthy aggregate sections visible when one source is partial', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      ...snapshot,
      sources: { events: 'partial', connections: 'ok', provider: 'ok' },
      metrics: { ...snapshot.metrics, runs: 1 },
    })))
    render(<CommandCenter runtime="all" days={7} onOpen={() => undefined} />)

    expect((await screen.findByRole('alert')).textContent).toContain('Some local sources are unavailable or partial.')
    expect(document.querySelector('[data-metric="Skill runs"] [data-value="1"]')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Issues' })).toBeTruthy()
  })

  it('offers retry and a permanently labeled demo instead of blanking on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))
    render(<CommandCenter runtime="all" days={7} onOpen={() => undefined} />)

    expect((await screen.findByRole('alert')).textContent).toContain('connection refused')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Use demo dataset' }))
    expect(screen.getAllByText('Demo dataset').length).toBeGreaterThan(0)
    expect(screen.getByText('Synthetic examples are never mixed with local data.')).toBeTruthy()
  })
})
