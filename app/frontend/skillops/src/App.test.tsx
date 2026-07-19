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

    fireEvent.click(screen.getByRole('button', { name: 'Evaluation preview' }))
    expect(screen.getByRole('heading', { level: 2, name: 'Evaluation preview' })).toBeTruthy()
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
      return Promise.resolve({ ok: true, json: async () => input === '/api/events' ? stored : [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(<App />)
    const file = new File([JSON.stringify([{ id: 'imported', event: 'skill.completed', skillId: 'imported-skill', runtime: 'codex', timestamp: new Date().toISOString(), outcome: 'success' }])], 'events.json', { type: 'application/json' })
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } })

    expect((await screen.findByRole('status')).textContent).toContain('Imported 1 new event')
    expect(await screen.findByText('imported-skill')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/import', expect.objectContaining({ method: 'POST' }))
  })

  it('searches and paginates more than twenty runs', async () => {
    window.history.replaceState({}, '', '/runs')
    const now = Date.now()
    const runs = Array.from({ length: 25 }, (_, index) => ({
      id: `run-${index + 1}`,
      event: 'skill.completed',
      skillId: index === 24 ? 'needle-skill' : `skill-${index + 1}`,
      runtime: 'codex',
      timestamp: new Date(now - index * 1_000).toISOString(),
      project: index === 24 ? 'needle-project' : 'workspace',
      outcome: 'success',
    }))
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => Promise.resolve({ ok: true, json: async () => input === '/api/events' ? runs : [] })))
    render(<App />)
    expect(await screen.findByText('1–20 of 25 runs')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(screen.getByText('21–25 of 25 runs')).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search runs' }), { target: { value: 'needle-project' } })
    expect(screen.getByText('1–1 of 1 run')).toBeTruthy()
    expect(screen.getByText('needle-skill')).toBeTruthy()
  })

  it('keeps sample evaluations read-only and explicit about unavailable actions', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Evaluation preview' }))
    expect(screen.getByText('Decision controls are intentionally unavailable')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New comparison' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Promote candidate' })).toBeNull()
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
