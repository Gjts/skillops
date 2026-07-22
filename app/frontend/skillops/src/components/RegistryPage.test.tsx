// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RegistryPage } from './RegistryPage'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

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
    render(<RegistryPage events={[]} />)
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
    render(<RegistryPage events={[]} />)
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
    const { container } = render(<RegistryPage events={[]} />)
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

    render(<RegistryPage events={[]} />)

    expect(await screen.findByText('scan_123')).toBeTruthy()
    expect(screen.getByText('/workspace/repository')).toBeTruthy()
    expect(screen.getByText('Admin')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('Partially observable')).toBeTruthy()
  })
})
