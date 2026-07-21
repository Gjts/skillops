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
      body: JSON.stringify({ sourceRef: 'local-scan:codex:C:/workspace/.codex/skills/review/SKILL.md', owner: 'local-owner' }),
    }))
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
})
