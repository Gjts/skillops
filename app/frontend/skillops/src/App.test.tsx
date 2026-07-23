// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

beforeEach(() => {
  window.history.replaceState({}, '', '/')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('SkillOps primary flow', () => {
  it('shows a real empty dataset instead of demo metrics and updates the runtime filter', async () => {
    const { container } = render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'No Skill runs from any runtime' })).toBeTruthy()
    await screen.findByText('Local events')
    expect(container.querySelector('[data-metric="Skill runs"] strong')?.getAttribute('data-value')).toBe('0')

    fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'codex' } })
    expect((screen.getByLabelText('Runtime') as HTMLSelectElement).value).toBe('codex')
    expect(container.querySelector('[data-metric="Skill runs"] strong')?.getAttribute('data-value')).toBe('0')
  })

  it('shows unreported Runtime cost instead of formatting missing metadata as zero', async () => {
    const now = new Date().toISOString()
    const events = Array.from({ length: 10 }, (_, index) => ({
      id: `missing-cost-${index}`,
      event: 'skill.completed',
      skillId: `skill-${index}`,
      runtime: 'codex',
      timestamp: now,
      outcome: 'success',
    }))
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => input === '/api/events' ? events : [],
    })))

    const { container } = render(<App />)
    await screen.findByText('Local events')
    const cost = container.querySelector<HTMLElement>('[data-metric="Reported cost"]')!
    expect(within(cost).getByText('—')).toBeTruthy()
    expect(within(cost).getByText('Not reported')).toBeTruthy()
    expect(within(cost).getByText('0 of 10 runs include cost metadata')).toBeTruthy()
    expect(cost.textContent).not.toContain('per successful run')
  })

  it('sums only reported Runtime costs and links to those runs', async () => {
    const now = new Date().toISOString()
    const events = Array.from({ length: 10 }, (_, index) => ({
      id: `mixed-cost-${index}`,
      event: 'skill.completed',
      skillId: `skill-${index}`,
      runtime: 'codex',
      timestamp: now,
      outcome: 'success',
      costUsd: index === 0 ? 0.01 : index === 1 ? 0.02 : undefined,
    }))
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => input === '/api/events' ? events : [],
    })))

    const { container } = render(<App />)
    await screen.findByText('Local events')
    const cost = container.querySelector<HTMLElement>('[data-metric="Reported cost"]')!
    expect(within(cost).getByText('$0.03')).toBeTruthy()
    expect(within(cost).getByText('2 of 10 runs include cost metadata')).toBeTruthy()
    fireEvent.click(within(cost).getByRole('button', { name: 'View costed runs' }))
    expect(window.location.pathname).toBe('/runs')
    expect(new URLSearchParams(window.location.search).get('cost')).toBe('reported')
  })

  it('renders an explicitly reported zero cost as $0.00', async () => {
    const events = [{
      id: 'zero-cost',
      event: 'skill.completed',
      skillId: 'free-runtime',
      runtime: 'codex',
      timestamp: new Date().toISOString(),
      outcome: 'success',
      costUsd: 0,
    }]
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => input === '/api/events' ? events : [],
    })))

    const { container } = render(<App />)
    await screen.findByText('Local events')
    const cost = container.querySelector<HTMLElement>('[data-metric="Reported cost"]')!
    expect(within(cost).getByText('$0.00')).toBeTruthy()
    expect(within(cost).getByText('1 of 1 runs include cost metadata')).toBeTruthy()
  })

  it('marks fallback cost as Demo data inside the cost KPI', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))
    const { container } = render(<App />)
    await screen.findByText('Demo dataset')
    const cost = container.querySelector<HTMLElement>('[data-metric="Reported cost"]')!
    expect(within(cost).getByText('Demo data')).toBeTruthy()
  })

  it('labels demo fallback and explains local API failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))
    const { container } = render(<App />)
    await screen.findByText('Demo dataset')
    expect(screen.getByRole('alert').textContent).toContain('connection refused')
    expect(container.querySelector('[data-metric="Skill runs"] strong')?.getAttribute('data-value')).toBe('1284')
  })

  it('navigates between product surfaces', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Skills' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'No Skill runs from any runtime' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Skill Lab' }))
    expect(screen.getByRole('heading', { level: 2, name: 'Compare a new open-source Skill' })).toBeTruthy()
    expect(document.querySelector('.sidebar')?.classList.contains('is-open')).toBe(false)
  })

  it('keeps the active product surface in the URL and restores browser history', async () => {
    window.history.replaceState({}, '', '/runs')
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(window.location.pathname).toBe('/settings')
    window.history.pushState({}, '', '/skills')
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(screen.getByRole('heading', { level: 1, name: 'Skills' })).toBeTruthy()
  })

  it('aborts an in-flight full event read when navigation enters Runs', async () => {
    let eventSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost')
      if (url.pathname === '/api/events') {
        eventSignal = init?.signal ?? undefined
        return Promise.race<Response>([])
      }
      if (url.pathname === '/api/runs') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0, hasPrevious: false, hasNext: false }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [] })
    }))

    render(<App />)
    await act(async () => { await Promise.resolve() })
    expect(eventSignal?.aborted).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Runs' }))

    expect(eventSignal?.aborted).toBe(true)
  })

  it('loads Governance directly and exposes it in primary navigation', async () => {
    window.history.replaceState({}, '', '/governance')
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => input === '/api/capabilities' ? { items: [] } : [],
    })))
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: 'Governance' })).toBeTruthy()
    expect(await screen.findByRole('heading', { level: 2, name: 'Capability governance' })).toBeTruthy()
  })

  it('polls the event API so newly recorded runs appear without reloading', async () => {
    vi.useFakeTimers()
    let events: object[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => Promise.resolve({
      ok: true,
      json: async () => input === '/api/events' ? events : [],
    })))
    render(<App />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('Local events')).toBeTruthy()
    events = [{ id: 'polled', event: 'skill.completed', skillId: 'polled-skill', runtime: 'codex', timestamp: new Date().toISOString(), outcome: 'success' }]

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(screen.getAllByText('polled-skill').length).toBeGreaterThan(0)
    expect(screen.getAllByText('unversioned').length).toBeGreaterThan(0)
    expect(screen.getByText('Refreshes every 3s')).toBeTruthy()
  })

  it('polls runtime connection health after an external installation change', async () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/settings')
    let status = 'not-installed'
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => Promise.resolve({
      ok: true,
      json: async () => input === '/api/connections'
        ? [{ runtime: 'codex', status }, { runtime: 'claude-code', status: 'not-installed' }, { runtime: 'cursor', status: 'preview' }]
        : [],
    })))
    render(<App />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const codexRow = screen.getByText('Codex').closest('.connection-row') as HTMLElement
    expect(within(codexRow).getByText('Not installed')).toBeTruthy()

    status = 'installed'
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(within(codexRow).getByText('Installed')).toBeTruthy()
  })

  it('persists imported files through the local API and reports the stored count', async () => {
    window.history.replaceState({}, '', '/runs')
    let stored: object[] = []
    const fetchMock = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === '/api/import' && init?.method === 'POST') {
        stored = JSON.parse(String(init.body))
        return Promise.resolve({ ok: true, json: async () => ({ created: stored, importedCount: stored.length }) })
      }
      if (String(input).startsWith('/api/runs?')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: stored,
            page: 1,
            pageSize: 20,
            totalItems: stored.length,
            totalPages: stored.length ? 1 : 0,
            hasPrevious: false,
            hasNext: false,
          }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => input === '/api/events' ? stored : [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(<App />)
    await screen.findByText('Local events')
    const file = new File([JSON.stringify([{ id: 'imported', event: 'skill.completed', skillId: 'imported-skill', runtime: 'codex', timestamp: new Date().toISOString(), outcome: 'success' }])], 'events.json', { type: 'application/json' })
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } })

    expect((await screen.findByText('Imported 1 new event into the local event store.')).getAttribute('role')).toBe('status')
    expect(await screen.findByText('imported-skill')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/import', expect.objectContaining({ method: 'POST' }))
  })

  it.each([
    { count: 0, firstLabel: '0–0 of 0 runs', lastLabel: null, lastCount: 0 },
    { count: 1, firstLabel: '1–1 of 1 run', lastLabel: null, lastCount: 1 },
    { count: 20, firstLabel: '1–20 of 20 runs', lastLabel: null, lastCount: 20 },
    { count: 21, firstLabel: '1–20 of 21 runs', lastLabel: '21–21 of 21 runs', lastCount: 1 },
    { count: 45, firstLabel: '1–20 of 45 runs', lastLabel: '41–45 of 45 runs', lastCount: 5 },
  ])('renders the $count-run pagination boundary', async ({ count, firstLabel, lastLabel, lastCount }) => {
    window.history.replaceState({}, '', '/runs?page=1&pageSize=20')
    const now = Date.now()
    const runs = Array.from({ length: count }, (_, index) => ({
      id: `boundary-${count}-${index + 1}`,
      event: 'skill.completed',
      skillId: `boundary-skill-${count}-${index + 1}`,
      runtime: 'codex',
      timestamp: new Date(now - index * 1_000).toISOString(),
      outcome: 'success',
    }))
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      const url = new URL(input, 'http://localhost')
      if (url.pathname === '/api/events') return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => runs })
      if (url.pathname === '/api/runs') {
        const page = Number(url.searchParams.get('page'))
        const totalPages = Math.ceil(count / 20)
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            items: runs.slice((page - 1) * 20, page * 20),
            page,
            pageSize: 20,
            totalItems: count,
            totalPages,
            hasPrevious: page > 1 && totalPages > 0,
            hasNext: page < totalPages,
          }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [] })
    }))

    render(<App />)

    expect(await screen.findByText(firstLabel)).toBeTruthy()
    if (!count) expect(screen.getByText('No Skill runs yet')).toBeTruthy()
    else expect(screen.getAllByRole('button', { name: /View run/ })).toHaveLength(Math.min(count, 20))
    if (lastLabel) {
      fireEvent.click(screen.getByRole('button', { name: 'Last page' }))
      expect(await screen.findByText(lastLabel)).toBeTruthy()
      expect(screen.getAllByRole('button', { name: /View run/ })).toHaveLength(lastCount)
    } else {
      expect((screen.getByRole('button', { name: 'Last page' }) as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('uses the paginated runs API and replaces the previous page in the DOM', async () => {
    window.history.replaceState({}, '', '/runs?page=1&pageSize=20')
    const now = Date.now()
    const runs = Array.from({ length: 45 }, (_, index) => ({
      id: `run-${index + 1}`,
      event: 'skill.completed',
      skillId: index === 44 ? 'needle-skill' : `skill-${index + 1}`,
      runtime: 'codex',
      timestamp: new Date(now - index * 1_000).toISOString(),
      project: index === 44 ? 'needle-project' : 'workspace',
      outcome: 'success',
    }))
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      const url = new URL(input, 'http://localhost')
      if (url.pathname === '/api/events') {
        return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => runs })
      }
      if (url.pathname === '/api/runs') {
        const query = url.searchParams.get('query')?.toLowerCase() ?? ''
        const matching = runs.filter((run) => !query || [run.skillId, run.id, run.project].some((value) => value.toLowerCase().includes(query)))
        const page = Number(url.searchParams.get('page') ?? 1)
        const pageSize = Number(url.searchParams.get('pageSize') ?? 20)
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            items: matching.slice((page - 1) * pageSize, page * pageSize),
            page,
            pageSize,
            totalItems: matching.length,
            totalPages: Math.ceil(matching.length / pageSize),
            hasPrevious: page > 1,
            hasNext: page * pageSize < matching.length,
          }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)

    expect(await screen.findByText('1–20 of 45 runs')).toBeTruthy()
    expect(screen.getByText('1–20 of 45 runs').getAttribute('role')).toBe('status')
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/runs?'))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(await screen.findByText('21–40 of 45 runs')).toBeTruthy()
    expect(screen.getByText('21–40 of 45 runs').getAttribute('role')).toBe('status')
    expect(screen.queryByText('skill-1')).toBeNull()
    expect(screen.getByText('skill-21')).toBeTruthy()
    expect(new URLSearchParams(window.location.search).get('page')).toBe('2')
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(await screen.findByText('41–45 of 45 runs')).toBeTruthy()
    expect(screen.getByText('needle-skill')).toBeTruthy()
    expect(new URLSearchParams(window.location.search).get('page')).toBe('3')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search runs' }), { target: { value: 'needle-project' } })
    expect(await screen.findByText('1–1 of 1 run')).toBeTruthy()
    expect(new URLSearchParams(window.location.search).get('page')).toBe('1')
    expect(new URLSearchParams(window.location.search).get('query')).toBe('needle-project')
  })

  it('rejects malformed run items from the local API', async () => {
    window.history.replaceState({}, '', '/runs')
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => input.startsWith('/api/runs')
        ? { items: [{ event: 'skill.completed', skillId: 'missing-id', runtime: 'codex', timestamp: new Date().toISOString(), outcome: 'success' }], page: 1, pageSize: 20, totalItems: 1, totalPages: 1, hasPrevious: false, hasNext: false }
        : [],
    })))

    render(<App />)

    expect((await screen.findByRole('alert')).textContent).toContain('Could not load runs: The runs response was invalid.')
  })

  it('restores page two and ignores an older page-three response after rapid navigation', async () => {
    window.history.replaceState({}, '', '/runs?page=2&pageSize=20&sort=timestamp_desc')
    const now = Date.now()
    const runs = Array.from({ length: 45 }, (_, index) => ({
      id: `stable-${index + 1}`,
      event: 'skill.completed',
      skillId: `stable-skill-${index + 1}`,
      runtime: 'codex',
      timestamp: new Date(now - index * 1_000).toISOString(),
      outcome: 'success',
    }))
    const pageResponse = (page: number) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        items: runs.slice((page - 1) * 20, page * 20),
        page,
        pageSize: 20,
        totalItems: runs.length,
        totalPages: 3,
        hasPrevious: page > 1,
        hasNext: page < 3,
      }),
    })
    let pageThreeRequested = false
    let releasePageThree: () => void = () => undefined
    const pageThree = new Promise<unknown>((resolve) => {
      releasePageThree = () => resolve(pageResponse(3))
    })
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      const url = new URL(input, 'http://localhost')
      if (url.pathname === '/api/events') return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => runs })
      if (url.pathname === '/api/runs') {
        const page = Number(url.searchParams.get('page'))
        if (page === 3) {
          pageThreeRequested = true
          return pageThree
        }
        return Promise.resolve(pageResponse(page))
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)

    expect(await screen.findByText('21–40 of 45 runs')).toBeTruthy()
    expect(screen.getByText('stable-skill-21')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Current page, page 2' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await vi.waitFor(() => expect(pageThreeRequested).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    await vi.waitFor(() => expect(new URLSearchParams(window.location.search).get('page')).toBe('2'))
    await act(async () => { releasePageThree(); await pageThree })

    expect(screen.getByText('stable-skill-21')).toBeTruthy()
    expect(screen.queryByText('stable-skill-41')).toBeNull()
    expect(new URLSearchParams(window.location.search).get('page')).toBe('2')
  })

  it('restores Runs URL state across cross-page browser history', async () => {
    window.history.replaceState({}, '', '/')
    const now = Date.now()
    const runs = Array.from({ length: 21 }, (_, index) => ({
      id: `history-${index + 1}`,
      event: 'skill.completed',
      skillId: `history-skill-${index + 1}`,
      runtime: 'codex',
      timestamp: new Date(now - index * 1_000).toISOString(),
      outcome: 'success',
    }))
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      const url = new URL(input, 'http://localhost')
      if (url.pathname === '/api/events') return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => runs })
      if (url.pathname === '/api/runs') {
        const page = Number(url.searchParams.get('page'))
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            items: runs.slice((page - 1) * 20, page * 20),
            page,
            pageSize: 20,
            totalItems: runs.length,
            totalPages: 2,
            hasPrevious: page > 1,
            hasNext: page < 2,
          }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [] })
    }))
    render(<App />)
    await screen.findByText('Local events')
    fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'claude-code' } })
    fireEvent.change(screen.getByLabelText('Date range'), { target: { value: '14' } })

    window.history.replaceState({}, '', '/runs?page=2&pageSize=20&query=history&runtime=codex&days=30&sort=timestamp_desc')
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')) })

    expect(await screen.findByText('21–21 of 21 runs')).toBeTruthy()
    expect((screen.getByRole('searchbox', { name: 'Search runs' }) as HTMLInputElement).value).toBe('history')
    expect((screen.getByLabelText('Runtime') as HTMLSelectElement).value).toBe('codex')
    expect((screen.getByLabelText('Date range') as HTMLSelectElement).value).toBe('30')

    window.history.replaceState({}, '', '/')
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')) })

    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy()
    expect((screen.getByLabelText('Runtime') as HTMLSelectElement).value).toBe('codex')
    expect((screen.getByLabelText('Date range') as HTMLSelectElement).value).toBe('30')
  })

  it('keeps page two stable and scopes bounded new-run polls to active filters', async () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/runs?page=2&pageSize=20&runtime=codex&sort=timestamp_asc')
    const now = Date.now()
    const originalRuns = Array.from({ length: 45 }, (_, index) => ({
      id: `polled-${index + 1}`,
      event: 'skill.completed',
      skillId: `polled-skill-${index + 1}`,
      runtime: 'codex',
      timestamp: new Date(now - index * 1_000).toISOString(),
      outcome: 'success',
    }))
    let codexRuns = originalRuns
    let claudeRuns: typeof originalRuns = []
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      const url = new URL(input, 'http://localhost')
      if (url.pathname === '/api/runs') {
        const runs = url.searchParams.get('runtime') === 'claude-code' ? claudeRuns : codexRuns
        const page = Number(url.searchParams.get('page'))
        const pageSize = Number(url.searchParams.get('pageSize'))
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            items: runs.slice((page - 1) * pageSize, page * pageSize),
            page,
            pageSize,
            totalItems: runs.length,
            totalPages: Math.ceil(runs.length / pageSize),
            hasPrevious: page > 1,
            hasNext: page * pageSize < runs.length,
          }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('21–40 of 45 runs')).toBeTruthy()
    expect(fetchMock.mock.calls.some(([input]) => new URL(input, 'http://localhost').pathname === '/api/events')).toBe(false)

    claudeRuns = [{
      id: 'polled-other-runtime',
      event: 'skill.completed',
      skillId: 'other-runtime-skill',
      runtime: 'claude-code',
      timestamp: new Date(now + 2_000).toISOString(),
      outcome: 'success',
    }]
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(fetchMock.mock.calls.some(([input]) => {
      const url = new URL(input, 'http://localhost')
      return url.pathname === '/api/runs' && url.searchParams.get('page') === '1' && url.searchParams.get('pageSize') === '20' && url.searchParams.get('sort') === 'timestamp_desc'
    })).toBe(true)
    expect(screen.queryByText(/new runs? available/)).toBeNull()

    codexRuns = [{
      id: 'polled-new',
      event: 'skill.completed',
      skillId: 'new-first-page-skill',
      runtime: 'codex',
      timestamp: new Date(now + 1_000).toISOString(),
      outcome: 'success',
    }, ...codexRuns]
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })

    expect(screen.getByText('1 new run available')).toBeTruthy()
    expect(screen.getByText('polled-skill-21')).toBeTruthy()
    expect(screen.queryByText('new-first-page-skill')).toBeNull()

    codexRuns = [{
      id: 'polled-replacement',
      event: 'skill.completed',
      skillId: 'replacement-first-page-skill',
      runtime: 'codex',
      timestamp: new Date(now + 3_000).toISOString(),
      outcome: 'success',
    }, ...codexRuns.slice(0, -1)]
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(screen.getByText('2 new runs available')).toBeTruthy()
    expect(new URLSearchParams(window.location.search).get('page')).toBe('2')
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('41–46 of 46 runs')).toBeTruthy()
    expect(screen.getByText('2 new runs available')).toBeTruthy()
    expect(new URLSearchParams(window.location.search).get('page')).toBe('3')
    fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'claude-code' } })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText(/new runs? available/)).toBeNull()
  })

  it('moves to the last valid page when bounded polling observes deletions', async () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/runs?page=2&pageSize=50')
    let runs = Array.from({ length: 75 }, (_, index) => ({
      id: `shrinking-${index + 1}`,
      event: 'skill.completed',
      skillId: `shrinking-skill-${index + 1}`,
      runtime: 'codex',
      timestamp: new Date(Date.now() - index * 1_000).toISOString(),
      outcome: 'success',
    }))
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      const url = new URL(input, 'http://localhost')
      if (url.pathname !== '/api/runs') return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [] })
      const page = Number(url.searchParams.get('page'))
      const pageSize = Number(url.searchParams.get('pageSize'))
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          items: runs.slice((page - 1) * pageSize, page * pageSize),
          page,
          pageSize,
          totalItems: runs.length,
          totalPages: Math.ceil(runs.length / pageSize),
          hasPrevious: page > 1,
          hasNext: page * pageSize < runs.length,
        }),
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('51–75 of 75 runs')).toBeTruthy()

    runs = runs.slice(0, 25)
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })

    expect(screen.getByText('1–25 of 25 runs')).toBeTruthy()
    expect(new URLSearchParams(window.location.search).get('page')).toBe('1')
    expect(screen.queryByText('shrinking-skill-75')).toBeNull()
  })

  it('retries the bounded Runs API and leaves Demo mode after recovery', async () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/runs')
    let available = false
    const liveRun = {
      id: 'recovered-run',
      event: 'skill.completed',
      skillId: 'recovered-skill',
      runtime: 'codex',
      timestamp: new Date().toISOString(),
      outcome: 'success',
    }
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      const url = new URL(input, 'http://localhost')
      if (url.pathname === '/api/events') return Promise.race<Response>([])
      if (url.pathname !== '/api/runs') return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [] })
      if (!available) return Promise.reject(new Error('connection refused'))
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ items: [liveRun], page: 1, pageSize: 20, totalItems: 1, totalPages: 1, hasPrevious: false, hasNext: false }),
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('Demo dataset')).toBeTruthy()

    available = true
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })

    expect(screen.getByText('Local events')).toBeTruthy()
    expect(screen.getByText('recovered-skill')).toBeTruthy()
    expect(fetchMock.mock.calls.some(([input]) => new URL(input, 'http://localhost').pathname === '/api/events')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
    expect(screen.getByText('Demo dataset')).toBeTruthy()
    expect(screen.queryByText('Local events')).toBeNull()
  })

  it('reports bounded query validation without replacing local state with Demo data', async () => {
    window.history.replaceState({}, '', `/runs?query=${'q'.repeat(201)}`)
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      const url = new URL(input, 'http://localhost')
      if (url.pathname === '/api/runs') {
        return Promise.resolve({ ok: false, status: 400, headers: new Headers(), json: async () => ({ error: 'query must be at most 200 characters.' }) })
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [] })
    }))

    render(<App />)

    expect((await screen.findByRole('alert')).textContent).toContain('query must be at most 200 characters.')
    expect(screen.getByText('Local events')).toBeTruthy()
    expect(screen.queryByText('Demo dataset')).toBeNull()
    expect((screen.getByRole('searchbox', { name: 'Search runs' }) as HTMLInputElement).maxLength).toBe(200)
  })

  it('recovers a first Runs request that fails after another page established Local mode', async () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/')
    const liveRun = {
      id: 'local-recovered-run',
      event: 'skill.completed',
      skillId: 'local-recovered-skill',
      runtime: 'codex',
      timestamp: new Date().toISOString(),
      outcome: 'success',
    }
    let runAttempts = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      const url = new URL(input, 'http://localhost')
      if (url.pathname === '/api/events') {
        return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [liveRun] })
      }
      if (url.pathname === '/api/runs') {
        runAttempts += 1
        if (runAttempts === 1) return Promise.reject(new Error('temporary runs failure'))
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ items: [liveRun], page: 1, pageSize: 20, totalItems: 1, totalPages: 1, hasPrevious: false, hasNext: false }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [] })
    }))

    render(<App />)
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('Local events')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByRole('alert').textContent).toContain('temporary runs failure')

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })

    expect(screen.getByText('local-recovered-skill')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('loads a run timeline only when its detail opens', async () => {
    window.history.replaceState({}, '', '/runs')
    const run = {
      id: '.',
      event: 'skill.completed',
      skillId: 'detail-skill',
      runtime: 'codex',
      sessionId: 'detail-session',
      timestamp: '2026-07-23T12:00:02.000Z',
      outcome: 'success',
    }
    const session = {
      id: 'detail-session-start',
      event: 'session.started',
      runtime: 'codex',
      sessionId: 'detail-session',
      timestamp: '2026-07-23T12:00:01.000Z',
    }
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      const url = new URL(input, 'http://localhost')
      if (url.pathname === '/api/runs') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ items: [run], page: 1, pageSize: 20, totalItems: 1, totalPages: 1, hasPrevious: false, hasNext: false }),
        })
      }
      if (url.pathname === '/api/runs/~.') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ run, events: [session, run], totalEvents: 3, truncated: true }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    expect(await screen.findByText('detail-skill')).toBeTruthy()
    expect(fetchMock.mock.calls.some(([input]) => new URL(input, 'http://localhost').pathname === '/api/runs/~.')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /View run \. for detail-skill/ }))

    const dialog = await screen.findByRole('dialog', { name: 'detail-skill' })
    expect(await within(dialog).findByText('2 / 3 events')).toBeTruthy()
    expect(within(dialog).getByText('Showing 2 of 3 correlated events.')).toBeTruthy()
    expect(fetchMock.mock.calls.some(([input]) => new URL(input, 'http://localhost').pathname === '/api/runs/~.')).toBe(true)
  })

  it('restores the full loaded state when a page or filter request fails', async () => {
    window.history.replaceState({}, '', '/runs?page=1&pageSize=20')
    const runs = Array.from({ length: 21 }, (_, index) => ({
      id: `rollback-${index + 1}`,
      event: 'skill.completed',
      skillId: `rollback-skill-${index + 1}`,
      runtime: 'codex',
      timestamp: new Date(Date.now() - index * 1_000).toISOString(),
      outcome: 'success',
    }))
    let failSecondPage = false
    let failQuery = false
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      const url = new URL(input, 'http://localhost')
      if (url.pathname !== '/api/runs') return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [] })
      const page = Number(url.searchParams.get('page'))
      if ((page === 2 && failSecondPage) || (url.searchParams.get('query') === 'unavailable' && failQuery)) {
        const error = failQuery ? 'filter unavailable' : 'page unavailable'
        return Promise.resolve({ ok: false, status: 500, headers: new Headers(), json: async () => ({ error }) })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          items: runs.slice((page - 1) * 20, page * 20),
          page,
          pageSize: 20,
          totalItems: runs.length,
          totalPages: 2,
          hasPrevious: page > 1,
          hasNext: page < 2,
        }),
      })
    }))

    render(<App />)
    expect(await screen.findByText('1–20 of 21 runs')).toBeTruthy()
    const historyLength = window.history.length
    failSecondPage = true
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))

    expect((await screen.findByRole('alert')).textContent).toContain('page unavailable')
    expect(new URLSearchParams(window.location.search).get('page')).toBe('1')
    expect(screen.getByRole('button', { name: 'Current page, page 1' })).toBeTruthy()
    expect(screen.getByText('rollback-skill-1')).toBeTruthy()
    expect(window.history.length).toBe(historyLength)

    failSecondPage = false
    fireEvent.click(screen.getByRole('button', { name: 'Last page' }))
    expect(await screen.findByText('21–21 of 21 runs')).toBeTruthy()
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

    failQuery = true
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search runs' }), { target: { value: 'unavailable' } })
    expect((await screen.findByRole('alert')).textContent).toContain('filter unavailable')
    expect(new URLSearchParams(window.location.search).get('page')).toBe('2')
    expect(new URLSearchParams(window.location.search).has('query')).toBe(false)
    expect(screen.getByRole('button', { name: 'Current page, page 2' })).toBeTruthy()
    expect(screen.getByText('rollback-skill-21')).toBeTruthy()
  })

  it('does not duplicate browser history when pending pagination returns to the current page', async () => {
    window.history.replaceState({}, '', '/runs?page=2&pageSize=20')
    const runs = Array.from({ length: 45 }, (_, index) => ({
      id: `pending-${index + 1}`,
      event: 'skill.completed',
      skillId: `pending-skill-${index + 1}`,
      runtime: 'codex',
      timestamp: new Date(Date.now() - index * 1_000).toISOString(),
      outcome: 'success',
    }))
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      const url = new URL(input, 'http://localhost')
      if (url.pathname !== '/api/runs') return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [] })
      const page = Number(url.searchParams.get('page'))
      const pageSize = Number(url.searchParams.get('pageSize'))
      if (page === 3) return Promise.race<Response>([])
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          items: runs.slice((page - 1) * pageSize, page * pageSize),
          page,
          pageSize,
          totalItems: runs.length,
          totalPages: 3,
          hasPrevious: page > 1,
          hasNext: page < 3,
        }),
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    expect(await screen.findByText('21–40 of 45 runs')).toBeTruthy()
    const historyLength = window.history.length
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(screen.getByRole('button', { name: 'Current page, page 3' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))

    await vi.waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => new URL(input, 'http://localhost').searchParams.get('page') === '2')).toHaveLength(2))
    expect(screen.getByRole('button', { name: 'Current page, page 2' })).toBeTruthy()
    expect(new URLSearchParams(window.location.search).get('page')).toBe('2')
    expect(window.history.length).toBe(historyLength)
  })

  it('keeps seeded Runs available when the local API is offline', async () => {
    window.history.replaceState({}, '', '/runs')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))

    render(<App />)

    expect(await screen.findByText('Demo dataset')).toBeTruthy()
    expect((await screen.findAllByRole('button', { name: /^View run / })).length).toBeGreaterThan(0)
    expect(screen.queryByText('No Skill runs yet')).toBeNull()
  })

  it('opens the live Skill Lab and its persisted AI settings', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Skill Lab' }))
    expect(screen.getByRole('textbox', { name: 'Candidate GitHub URL' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Configure AI' }))
    expect(screen.getByRole('dialog', { name: 'AI settings' })).toBeTruthy()
    expect(screen.getByText('Saved API keys are written to the local SkillOps data file.')).toBeTruthy()
  })

  it('shows every real Skill row on the unbounded Skills page', async () => {
    const now = new Date().toISOString()
    const localEvents = ['one', 'two', 'three'].map((skillId) => ({
      id: skillId,
      event: 'skill.completed',
      skillId,
      skillVersion: '1.0.0',
      runtime: 'codex',
      timestamp: now,
      outcome: 'success',
    }))
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => Promise.resolve({
      ok: true,
      json: async () => input === '/api/events' ? localEvents : [],
    })))
    render(<App />)
    await screen.findByText('Local events')
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
    expect(screen.getByText('one')).toBeTruthy()
    expect(screen.getByText('two')).toBeTruthy()
    expect(screen.getByText('three')).toBeTruthy()
    const unreportedRow = screen.getByText('one').closest('tr') as HTMLElement
    expect(within(unreportedRow).getByText('Not reported')).toBeTruthy()
  })

  it('keeps cross-runtime Skill activity attached to the matching definition source', async () => {
    const now = new Date().toISOString()
    const localEvents = [
      { id: 'codex-definition', event: 'skill.discovered', skillId: 'shared-skill', runtime: 'codex', timestamp: now, sourcePath: 'C:\\Users\\dev\\.codex\\skills\\shared-skill\\SKILL.md', source: 'global' },
      { id: 'claude-definition', event: 'skill.discovered', skillId: 'shared-skill', runtime: 'claude-code', timestamp: now, sourcePath: 'C:\\Users\\dev\\.claude\\skills\\shared-skill\\SKILL.md', source: 'global' },
      { id: 'codex-run', event: 'skill.completed', skillId: 'shared-skill', runtime: 'codex', timestamp: now, outcome: 'success' },
      { id: 'claude-run', event: 'skill.completed', skillId: 'shared-skill', runtime: 'claude-code', timestamp: now, outcome: 'success' },
    ]
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => Promise.resolve({
      ok: true,
      json: async () => input === '/api/events' ? localEvents : [],
    })))
    render(<App />)
    await screen.findByText('Local events')
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))

    const skillRows = screen.getAllByText('shared-skill').map((cell) => cell.closest('tr') as HTMLElement)
    expect(skillRows).toHaveLength(2)
    const codexRow = skillRows.find((row) => within(row).queryByText('Codex'))!
    fireEvent.click(within(codexRow).getByRole('button', { name: 'Expand Skill details' }))
    expect(screen.getByText('C:\\Users\\dev\\.codex\\skills\\shared-skill\\SKILL.md')).toBeTruthy()
    expect(screen.queryByText('C:\\Users\\dev\\.claude\\skills\\shared-skill\\SKILL.md')).toBeNull()
  })

  it('opens the runtime connection flow and changes adapters', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect runtime' }))
    const dialog = screen.getByRole('dialog', { name: 'Connect a runtime' })
    expect(dialog).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: /Claude Code/ }))
    expect(within(dialog).getByText('npm run claude:install')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the connection flow for the runtime selected in the current empty state', async () => {
    render(<App />)
    await screen.findByText('Local events')
    fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'cursor' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect runtime' }))

    expect(within(screen.getByRole('dialog', { name: 'Connect a runtime' })).getByText('npm run emit -- skill.started --skill frontend-builder --runtime cursor')).toBeTruthy()
  })

  it('uses inspected hook status and configures the selected runtime', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => Promise.resolve({
      ok: true,
      json: async () => input === '/api/events'
        ? [{ id: 'old-codex-event', event: 'session.started', runtime: 'codex', timestamp: new Date().toISOString() }]
        : input === '/api/connections'
          ? [
              { runtime: 'codex', status: 'not-installed' },
              { runtime: 'claude-code', status: 'installed' },
              { runtime: 'cursor', status: 'preview' },
            ]
          : [],
    })))
    render(<App />)
    await screen.findByText('Local events')
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    const codexRow = screen.getByText('Codex').closest('.connection-row') as HTMLElement
    const claudeRow = screen.getByText('Claude Code').closest('.connection-row') as HTMLElement
    expect(within(codexRow).getByText('Not installed')).toBeTruthy()
    expect(within(claudeRow).getByText('Installed')).toBeTruthy()

    expect(within(codexRow).getByRole('button', { name: 'Configure Codex' })).toBeTruthy()
    expect(within(claudeRow).getByText('No runtime activity recorded')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Local event data' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Export JSONL' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear event data' }))
    expect(screen.getByRole('alertdialog', { name: 'Clear 1 local events?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(claudeRow).getByRole('button', { name: 'Configure Claude Code' }))
    expect(within(screen.getByRole('dialog', { name: 'Connect a runtime' })).getByText('npm run claude:install')).toBeTruthy()
  })

  it('uses scanner source metadata for project Skills', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{
        id: 'discovered-project',
        event: 'skill.discovered',
        skillId: 'project-only-skill',
        skillVersion: '1.0.0',
        runtime: 'claude-code',
        timestamp: '2020-01-01T00:00:00.000Z',
        source: 'project',
        sourcePath: '/workspace/project/.claude/skills/project-only-skill/SKILL.md',
      }],
    }))
    render(<App />)
    await screen.findByText('Local events')
    fireEvent.click(screen.getByRole('button', { name: 'Registry' }))
    const row = (await screen.findByText('project-only-skill')).closest('tr')!
    expect(within(row).getAllByText('Project').length).toBeGreaterThan(0)
  })

  it('runs a real registry scan through the local API', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === '/api/scan' && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => [{
            skillId: 'freshly-scanned-skill',
            skillVersion: '2.0.0',
            runtime: 'codex',
            source: 'global',
            sourcePath: '/home/user/.codex/skills/freshly-scanned-skill/SKILL.md',
          }],
        })
      }
      return Promise.resolve({ ok: true, json: async () => [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Registry' }))
    expect(await screen.findByText('freshly-scanned-skill')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/scan', { method: 'POST' })
  })

  it('shows real Skill totals and filesystem-backed categories', async () => {
    const scan = [
      { skillId: 'global-one', skillVersion: '1.0.0', runtime: 'codex', source: 'global', sourcePath: '/home/.codex/skills/global-one/SKILL.md', provider: 'Codex', kind: 'skill', enabled: true },
      { skillId: 'plugin-two', skillVersion: '1.0.0', runtime: 'codex', source: 'plugin', sourcePath: '/home/.codex/plugins/cache/example/skills/plugin-two/SKILL.md', provider: 'example', kind: 'skill', enabled: true },
      { skillId: 'project-three', skillVersion: '1.0.0', runtime: 'claude-code', source: 'project', sourcePath: '/repo/.claude/skills/project-three/SKILL.md', provider: 'Project', kind: 'skill', enabled: true },
      { skillId: 'disabled-four', skillVersion: '1.0.0', runtime: 'codex', source: 'plugin', sourcePath: '/home/.codex/plugins/cache/disabled/skills/disabled-four/SKILL.md', provider: 'disabled', kind: 'skill', enabled: false },
    ]
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => Promise.resolve({
      ok: true,
      json: async () => input === '/api/scan' ? scan : [],
    })))
    const { container } = render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Registry' }))
    expect(screen.queryByLabelText('Date range')).toBeNull()
    expect(container.querySelector('.topbar .runtime-select')).toBeNull()

    await screen.findByText('global-one')
    expect(container.querySelector('[data-metric="Available Skills"] strong')?.textContent).toBe('3')
    expect(container.querySelector('[data-metric="Plugin Skills"] strong')?.textContent).toBe('1')
    expect(container.querySelector('[data-metric="Disabled Skills"] strong')?.textContent).toBe('1')
    expect(screen.getByRole('button', { name: 'Show Codex Skills: 2 enabled definitions' })).toBeTruthy()
    const sourceCategories = screen.getByRole('region', { name: 'By installation source categories' })
    expect(within(sourceCategories).getByRole('button', { name: /Project1/ })).toBeTruthy()
    expect(screen.getByText('3 shown · 4 scanned')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Registry status'), { target: { value: 'disabled' } })
    expect(await screen.findByText('disabled-four')).toBeTruthy()
    expect(screen.getByText('1 shown · 4 scanned')).toBeTruthy()
    expect(within(screen.getByLabelText('Registry provider')).getByRole('option', { name: 'disabled' })).toBeTruthy()
    expect(screen.getByRole('searchbox', { name: 'Search installed Skills' })).toBeTruthy()
  })

  it('separates Codex and Claude Code into primary Registry workspaces', async () => {
    const scan = [
      { skillId: 'codex-only', skillVersion: '1.0.0', runtime: 'codex', source: 'global', sourcePath: '/codex/codex-only/SKILL.md', provider: 'Codex', kind: 'skill', enabled: true },
      { skillId: 'shared-skill', skillVersion: '1.0.0', runtime: 'codex', source: 'global', sourcePath: '/codex/shared/SKILL.md', provider: 'Codex', kind: 'skill', enabled: true },
      { skillId: 'claude-only', skillVersion: '2.0.0', runtime: 'claude-code', source: 'plugin', sourcePath: '/claude/claude-only/SKILL.md', provider: 'Claude Code', kind: 'skill', enabled: true },
      { skillId: 'shared-skill', skillVersion: '2.0.0', runtime: 'claude-code', source: 'global', sourcePath: '/claude/shared/SKILL.md', provider: 'Claude Code', kind: 'skill', enabled: true },
    ]
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => Promise.resolve({
      ok: true,
      json: async () => input === '/api/scan' ? scan : [],
    })))
    window.history.replaceState({}, '', '/registry')
    const { container } = render(<App />)
    await screen.findByText('codex-only')

    expect(screen.getByRole('region', { name: 'Runtime workspaces' })).toBeTruthy()
    expect(screen.queryByLabelText('Registry runtime')).toBeNull()
    expect(screen.getByText('Codex · 2 definitions')).toBeTruthy()
    expect(screen.getByText('Claude Code · 2 definitions')).toBeTruthy()
    expect(screen.getAllByText('Shared').length).toBe(2)

    fireEvent.click(screen.getByRole('button', { name: 'Show Codex Skills: 2 enabled definitions' }))
    expect(container.querySelector('[data-metric="Available Skills"] strong')?.textContent).toBe('2')
    expect(screen.getByText('codex-only')).toBeTruthy()
    expect(screen.queryByText('claude-only')).toBeNull()
    expect(screen.getByText('Codex inventory · 2 shown')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Show Claude Code Skills: 2 enabled definitions' }))
    expect(screen.getByText('claude-only')).toBeTruthy()
    expect(screen.queryByText('codex-only')).toBeNull()
    expect(screen.getByText('Claude Code inventory · 2 shown')).toBeTruthy()
  })
})
