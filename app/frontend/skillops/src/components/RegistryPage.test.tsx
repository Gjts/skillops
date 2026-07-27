// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RegistryPage } from './RegistryPage'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

describe('registry governance nomination', () => {
  it('nominates an enabled scanned Skill by server-resolved sourceRef', async () => {
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/scan') return Promise.resolve({ ok: true, json: async () => [{
        skillId: 'review-skill', skillVersion: '1.0.0', runtime: 'codex', source: 'project',
        sourcePath: 'C:/workspace/.codex/skills/review/SKILL.md', provider: 'Project', kind: 'skill', enabled: true,
      }] })
      if (input === '/api/capabilities') return Promise.resolve({ ok: true, status: 201, json: async () => ({ capability: { id: 'cap-1' } }) })
      return Promise.reject(new Error(`Unexpected request: ${input} ${init?.method || 'GET'}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<RegistryPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Nominate' }))
    expect(await screen.findByRole('button', { name: 'Nominated' })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/capabilities', expect.objectContaining({
      body: JSON.stringify({ sourceRef: 'local-scan:codex:C:/workspace/.codex/skills/review/SKILL.md' }),
    }))
  })

  it('requires a new nomination after rescanning changed content at the same path', async () => {
    let scanCount = 0
    const fetchMock = vi.fn((input: string) => {
      if (input === '/api/scan') {
        scanCount += 1
        return Promise.resolve({ ok: true, json: async () => [{
          skillId: 'review-skill', skillVersion: '1.0.0', runtime: 'codex', source: 'project',
          sourcePath: 'C:/workspace/.codex/skills/review/SKILL.md', provider: 'Project', kind: 'skill', enabled: true,
          contentHash: String(scanCount).repeat(64),
        }] })
      }
      if (input === '/api/capabilities') return Promise.resolve({ ok: true, status: 201, json: async () => ({ capability: { id: 'cap-1' } }) })
      return Promise.reject(new Error(`Unexpected request: ${input}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<RegistryPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Nominate' }))
    expect(await screen.findByRole('button', { name: 'Nominated' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Scan again' }))
    expect(await screen.findByRole('button', { name: 'Nominate' })).toBeTruthy()
  })

  it('scopes health counts by runtime and excludes disabled definitions from collisions', async () => {
    const fetchMock = vi.fn((input: string) => {
      if (input !== '/api/scan') return Promise.reject(new Error(`Unexpected request: ${input}`))
      return Promise.resolve({ ok: true, json: async () => [
        {
          skillId: 'review', skillVersion: '1.0.0', runtime: 'codex', source: 'global',
          sourcePath: '/home/me/.agents/skills/review/SKILL.md', provider: 'Agents', kind: 'skill', enabled: true,
        },
        {
          skillId: 'review', skillVersion: '2.0.0', runtime: 'codex', source: 'plugin',
          sourcePath: '/plugins/review/SKILL.md', provider: 'review-plugin', kind: 'skill', enabled: false,
          disabledReason: 'skill-config',
        },
        {
          skillId: 'review', skillVersion: '1.0.0', runtime: 'claude-code', source: 'global',
          sourcePath: '/home/me/.claude/skills/review/SKILL.md', provider: 'Claude Code', kind: 'skill', enabled: true,
        },
        {
          skillId: 'Review', skillVersion: '2.0.0', runtime: 'claude-code', source: 'project',
          sourcePath: '/repo/.claude/skills/review/SKILL.md', provider: 'Project', kind: 'skill', enabled: true,
        },
      ] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(<RegistryPage />)
    await screen.findByText('/home/me/.agents/skills/review/SKILL.md')

    const healthButton = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.registry-health button')]
      .find((button) => button.textContent?.includes(label))
    expect(healthButton('Definition conflicts')?.textContent).toContain('2')
    expect(healthButton('Duplicate definitions')?.textContent).toContain('0')
    expect(healthButton('Disabled')?.textContent).toContain('1')

    fireEvent.click(screen.getByRole('button', { name: /Show Codex Skills/ }))
    expect(healthButton('Definition conflicts')?.textContent).toContain('0')
    expect(healthButton('Duplicate definitions')?.textContent).toContain('0')
    expect(healthButton('Disabled')?.textContent).toContain('1')

    fireEvent.click(healthButton('Disabled')!)
    expect(screen.getByText('Skill configuration disabled')).toBeTruthy()
  })

  it('shows scan provenance, effective status, and partial observability', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string) => {
      if (input !== '/api/scan') return Promise.reject(new Error(`Unexpected request: ${input}`))
      return Promise.resolve({
        ok: true,
        json: async () => ({
          definitions: [{
            skillId: 'admin-review',
            skillVersion: '1.0.0',
            runtime: 'codex',
            source: 'global',
            sourcePath: '/etc/codex/skills/admin-review/SKILL.md',
            provider: 'Codex Admin',
            kind: 'skill',
            enabled: true,
            status: 'active',
            configurationSource: 'admin',
          }],
          scan: {
            id: 'scan_123',
            projectRoot: '/workspace/repository',
            startedAt: '2026-07-22T00:00:00.000Z',
            completedAt: '2026-07-22T00:00:00.012Z',
            durationMs: 12,
            coverage: [],
            errors: [],
            observability: [{
              runtime: 'claude-code',
              state: 'partial',
              reason: 'External policy cannot be reconstructed.',
            }],
          },
        }),
      })
    }))

    render(<RegistryPage />)

    expect(await screen.findByText('scan_123')).toBeTruthy()
    expect(screen.getByText('/workspace/repository')).toBeTruthy()
    expect(screen.getByText('Admin')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('Partially observable')).toBeTruthy()
  })
  it('keeps large definition inventories bounded to 50 rows per page', async () => {
    const definitions = Array.from({ length: 101 }, (_, index) => ({
      skillId: `skill-${String(index).padStart(3, '0')}`,
      skillVersion: '1.0.0',
      runtime: 'codex',
      source: 'global',
      sourcePath: `/home/me/.codex/skills/skill-${index}/SKILL.md`,
      provider: 'Codex',
      kind: 'skill',
      enabled: true,
    }))
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => definitions })))

    const { container } = render(<RegistryPage />)
    expect(await screen.findByText('skill-000')).toBeTruthy()
    expect(container.querySelectorAll('.registry-table tbody > tr:not(.registry-runtime-group)')).toHaveLength(50)
    expect(screen.queryByText('skill-050')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(await screen.findByText('skill-050')).toBeTruthy()
    expect(screen.queryByText('skill-000')).toBeNull()
    expect(new URLSearchParams(window.location.search).get('page')).toBe('2')
  })

  it('drives Registry pagination from the server without receiving the full inventory', async () => {
    const allDefinitions = Array.from({ length: 101 }, (_, index) => ({
      skillId: `server-skill-${String(index).padStart(3, '0')}`,
      skillVersion: '1.0.0',
      runtime: 'codex' as const,
      source: 'global' as const,
      sourcePath: `/skills/server-skill-${index}/SKILL.md`,
      provider: 'Codex',
      kind: 'skill' as const,
      enabled: true,
    }))
    const deliveredPageSizes: number[] = []
    const fetchMock = vi.fn((input: string) => {
      const url = new URL(input, 'http://localhost')
      const page = Number(url.searchParams.get('page') || 1)
      const definitions = allDefinitions.slice((page - 1) * 50, page * 50)
      deliveredPageSizes.push(definitions.length)
      return Promise.resolve({
        ok: true,
        json: async () => ({
          generatedAt: '2026-07-25T12:00:00.000Z',
          definitions,
          scan: null,
          page: { page, pageSize: 50, totalItems: 101, totalPages: 3, hasPrevious: page > 1, hasNext: page < 3 },
          aggregates: {
            totalDefinitions: 101,
            sharedSkillCount: 0,
            enabledDefinitionCount: 101,
            runtimes: [
              { runtime: 'codex', count: 101, unique: 101, sources: [{ value: 'global', count: 101 }, { value: 'project', count: 0 }, { value: 'plugin', count: 0 }] },
              { runtime: 'claude-code', count: 0, unique: 0, sources: [{ value: 'global', count: 0 }, { value: 'project', count: 0 }, { value: 'plugin', count: 0 }] },
              { runtime: 'cursor', count: 0, unique: 0, sources: [{ value: 'global', count: 0 }, { value: 'project', count: 0 }, { value: 'plugin', count: 0 }] },
            ],
            metrics: { uniqueEnabledSkills: 101, enabledDefinitions: 101, pluginEnabledSkills: 0, disabledSkills: 0 },
            attention: { attention: 0, conflict: 0, duplicate: 0, disabled: 0, missing: 0 },
            sources: [{ value: 'global', count: 101 }, { value: 'project', count: 0 }, { value: 'plugin', count: 0 }],
            providers: [{ provider: 'Codex', count: 101 }],
            visibleRuntimes: [{ runtime: 'codex', count: 101 }, { runtime: 'claude-code', count: 0 }, { runtime: 'cursor', count: 0 }],
          },
          definitionIssues: {},
          sharedDefinitionKeys: [],
        }),
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container } = render(<RegistryPage />)
    expect(await screen.findByText('server-skill-000')).toBeTruthy()
    expect(screen.queryByText('server-skill-050')).toBeNull()
    expect(container.querySelectorAll('.registry-table tbody > tr:not(.registry-runtime-group)')).toHaveLength(50)

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(await screen.findByText('server-skill-050')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/scan?page=2', { method: 'POST' })
    expect(deliveredPageSizes.every((size) => size <= 50)).toBe(true)

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search installed Skills' }), { target: { value: 'server-skill-1' } })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search installed Skills' }), { target: { value: 'server-skill-100' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/scan?query=server-skill-100', { method: 'POST' }))
    expect(fetchMock.mock.calls.some(([input]) => input === '/api/scan?query=server-skill-1')).toBe(false)
  })

  it('renders developer diagnostics for the Advanced diagnostics route', async () => {
    window.history.replaceState({}, '', '/assets?view=diagnostics')
    vi.stubGlobal('fetch', vi.fn((input: string) => {
      if (!input.startsWith('/api/scan')) return Promise.reject(new Error(`Unexpected request: ${input}`))
      return Promise.resolve({
        ok: true,
        json: async () => ({
          generatedAt: '2026-07-27T00:00:00.000Z',
          definitions: [],
          scan: {
            id: 'scan-diagnostics-1',
            projectRoot: 'C:/workspace',
            startedAt: '2026-07-27T00:00:00.000Z',
            completedAt: '2026-07-27T00:00:00.012Z',
            durationMs: 12,
            coverage: [{ runtime: 'codex', directory: 'C:/workspace/.codex/skills', source: 'project', configurationSource: 'project', state: 'scanned' }],
            errors: [{ runtime: 'claude-code', path: 'C:/restricted', code: 'EACCES', message: 'Access denied' }],
            observability: [{ runtime: 'claude-code', state: 'partial', reason: 'Filesystem-only visibility.' }],
          },
          page: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0, hasPrevious: false, hasNext: false },
          aggregates: {
            totalDefinitions: 0,
            enabledDefinitionCount: 0,
            sharedSkillCount: 0,
            runtimes: [],
            metrics: { uniqueEnabledSkills: 0, enabledDefinitions: 0, pluginEnabledSkills: 0, disabledSkills: 0 },
            attention: { attention: 0, conflict: 0, duplicate: 0, disabled: 0, missing: 0 },
            sources: [],
            providers: [],
            visibleRuntimes: [],
          },
          definitionIssues: {},
          sharedDefinitionKeys: [],
        }),
      })
    }))

    render(<RegistryPage />)

    const diagnostics = await screen.findByRole('region', { name: 'Developer diagnostics' })
    expect(diagnostics.textContent).toContain('scan-diagnostics-1')
    expect(diagnostics.textContent).toContain('C:/workspace/.codex/skills')
    expect(diagnostics.textContent).toContain('Filesystem-only visibility.')
    expect(diagnostics.textContent).toContain('EACCES')
    expect(window.location.search).toContain('view=diagnostics')
  })

  it('applies compatible Assets query and conflict filters from the URL', async () => {
    window.history.replaceState({}, '', '/assets?tab=skills&query=review&attention=conflict')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: async () => [
        {
          skillId: 'review',
          skillVersion: '1.0.0',
          runtime: 'codex',
          source: 'global',
          sourcePath: '/home/me/.codex/skills/review/SKILL.md',
          provider: 'Codex',
          kind: 'skill',
          enabled: true,
        },
        {
          skillId: 'Review',
          skillVersion: '2.0.0',
          runtime: 'codex',
          source: 'project',
          sourcePath: '/repo/.codex/skills/review/SKILL.md',
          provider: 'Project',
          kind: 'skill',
          enabled: true,
        },
        {
          skillId: 'unrelated',
          skillVersion: '1.0.0',
          runtime: 'codex',
          source: 'global',
          sourcePath: '/home/me/.codex/skills/unrelated/SKILL.md',
          provider: 'Codex',
          kind: 'skill',
          enabled: true,
        },
      ],
    })))

    render(<RegistryPage />)

    expect(await screen.findByText('/repo/.codex/skills/review/SKILL.md')).toBeTruthy()
    expect(screen.getByRole('searchbox', { name: 'Search installed Skills' })).toHaveProperty('value', 'review')
    expect(screen.getByRole('button', { name: /Definition conflicts/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByText('/home/me/.codex/skills/unrelated/SKILL.md')).toBeNull()
    expect(window.location.search).toContain('tab=skills')
  })

  it('restores Registry filters and pagination when browser history changes', async () => {
    const definitions = Array.from({ length: 101 }, (_, index) => ({
      skillId: `skill-${String(index).padStart(3, '0')}`,
      skillVersion: '1.0.0',
      runtime: 'codex',
      source: 'global',
      sourcePath: `/home/me/.codex/skills/skill-${index}/SKILL.md`,
      provider: 'Codex',
      kind: 'skill',
      enabled: true,
    }))
    window.history.replaceState({}, '', '/registry?tab=skills&runtime=codex&source=global&provider=Codex&status=enabled&page=2')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => definitions })))

    render(<RegistryPage />)

    expect(await screen.findByText('/home/me/.codex/skills/skill-50/SKILL.md')).toBeTruthy()
    expect(screen.queryByText('/home/me/.codex/skills/skill-0/SKILL.md')).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Registry source' })).toHaveProperty('value', 'global')
    expect(screen.getByRole('combobox', { name: 'Registry provider' })).toHaveProperty('value', 'Codex')
    expect(window.location.pathname).toBe('/registry')

    await act(async () => {
      window.history.pushState({}, '', '/registry?tab=skills&query=skill-000')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    expect(screen.getByRole('searchbox', { name: 'Search installed Skills' })).toHaveProperty('value', 'skill-000')
    expect(await screen.findByText('/home/me/.codex/skills/skill-0/SKILL.md')).toBeTruthy()
    expect(screen.queryByText('/home/me/.codex/skills/skill-50/SKILL.md')).toBeNull()
    expect(window.location.search).toContain('tab=skills')
  })
})
