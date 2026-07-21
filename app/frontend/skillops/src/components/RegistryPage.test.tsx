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
})
