// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentProjection } from './AgentsPage'
import { AgentsPage } from './AgentsPage'

const codex: AgentProjection = {
  key: 'a'.repeat(32),
  name: 'reviewer',
  runtime: 'codex',
  definition: { sourcePath: 'project/.codex/agents/reviewer.md', skillVersion: '1.0.0' },
  configurationState: 'conflicted',
  evidenceState: 'observed-recently',
  lastVerifiedAt: '2026-07-25T11:56:01.000Z',
  terminalRuns: [{ id: 'codex-terminal', event: 'skill.failed', kind: 'agent', skillId: 'reviewer', runtime: 'codex', timestamp: '2026-07-25T11:56:01.000Z', outcome: 'failed' }],
  knownOutcomes: 1,
  outcomeCoverage: { numerator: 1, denominator: 1, value: 100 },
  latestOutcome: 'failed',
  timeline: [{ id: 'codex-terminal', event: 'skill.failed', kind: 'agent', skillId: 'reviewer', runtime: 'codex', timestamp: '2026-07-25T11:56:01.000Z', outcome: 'failed' }],
}
const claude: AgentProjection = {
  key: 'b'.repeat(32),
  name: 'reviewer',
  runtime: 'claude-code',
  definition: { sourcePath: 'project/.claude/agents/reviewer.md', skillVersion: '2.0.0' },
  configurationState: 'active',
  evidenceState: 'telemetry-gap',
  terminalRuns: [],
  knownOutcomes: 0,
  outcomeCoverage: { numerator: 0, denominator: 0, value: null },
  timeline: [{ id: 'claude-start', event: 'subagent.started', runtime: 'claude-code', timestamp: '2026-07-25T11:30:00.000Z' }],
}
const planner: AgentProjection = {
  key: 'c'.repeat(32),
  name: 'planner',
  runtime: 'codex',
  definition: { sourcePath: 'project/.codex/agents/planner.md' },
  configurationState: 'active',
  evidenceState: 'unverified',
  terminalRuns: [],
  knownOutcomes: 0,
  outcomeCoverage: { numerator: 0, denominator: 0, value: null },
  timeline: [],
}

function page(items: AgentProjection[], available = items.length) {
  return { generatedAt: '2026-07-25T12:00:00.000Z', items, page: 1, pageSize: 50, totalItems: items.length, totalPages: items.length ? 1 : 0, available, hasPrevious: false, hasNext: false }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

describe('Agent projections', () => {
  it('loads bounded projections, preserves keyboard tabs, and opens exact run evidence', async () => {
    const fetchMock = vi.fn((input: string) => {
      const url = new URL(input, 'http://localhost')
      if (url.pathname.startsWith('/api/agents/')) {
        const item = url.pathname.endsWith(codex.key) ? codex : claude
        return Promise.resolve({ ok: true, json: async () => ({ item }) })
      }
      const definitions = url.searchParams.get('tab') === 'definitions'
      const runtime = url.searchParams.get('runtime')
      const source = definitions ? [planner, codex, claude] : [codex, claude]
      const items = runtime ? source.filter((item) => item.runtime === runtime) : source
      return Promise.resolve({ ok: true, json: async () => ({ ...page(items, source.length), sourceStatus: 'partial' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onOpen = vi.fn()
    render(<AgentsPage onOpen={onOpen} />)

    const observedTab = screen.getByRole('tab', { name: 'Observed Activity' })
    expect(await screen.findByRole('table', { name: 'Agents' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Some local sources are unavailable or partial.')
    observedTab.focus()
    fireEvent.keyDown(observedTab, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Definitions' }))
    expect(await screen.findByText('planner')).toBeTruthy()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(observedTab)
    await screen.findByText('Observed recently')

    expect(screen.getByText('Telemetry gap')).toBeTruthy()
    expect(screen.getByText('Conflicted')).toBeTruthy()
    const codexRow = screen.getAllByText('Codex').find((element) => element.tagName === 'TD')!.closest('tr') as HTMLElement
    const inspect = within(codexRow).getByRole('button', { name: 'Inspect reviewer' })
    inspect.focus()
    fireEvent.click(inspect)
    const dialog = screen.getByRole('dialog', { name: 'reviewer' })
    expect(within(dialog).getByText('100% (1/1)')).toBeTruthy()
    expect(within(dialog).getByText('skill.failed')).toBeTruthy()
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Open latest Run' })[0])
    expect(onOpen).toHaveBeenCalledWith('/activity?tab=runs&run=codex-terminal')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'reviewer' })).toBeNull()
    expect(document.activeElement).toBe(inspect)

    fireEvent.click(screen.getByRole('tab', { name: 'Definitions' }))
    expect(await screen.findByText('planner')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'claude-code' } })
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('runtime')).toBe('claude-code'))
    await waitFor(() => expect(screen.queryByText('planner')).toBeNull())
    expect(fetchMock.mock.calls.every(([input]) => !String(input).startsWith('/api/events'))).toBe(true)
  })
})
