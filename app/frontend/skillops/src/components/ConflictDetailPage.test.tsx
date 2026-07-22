// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConflictDetailPage } from './ConflictDetailPage'
import type { InstalledSkill } from '../types'

const skill: InstalledSkill = {
  skillId: 'review', skillVersion: '1.0.0', runtime: 'codex', source: 'global',
  sourcePath: '/home/.codex/skills/review/SKILL.md', provider: 'Codex', kind: 'skill', enabled: true,
}

const definitions = [
  { ...skill, definitionKey: 'codex:skill:global', contentHash: 'a'.repeat(64), status: 'active' },
  { ...skill, source: 'project' as const, sourcePath: '/repo/.agents/skills/review/SKILL.md', skillVersion: '2.0.0', definitionKey: 'codex:skill:project', contentHash: 'b'.repeat(64), status: 'active' },
]

const detail = {
  runtime: 'codex', skillId: 'review', classifications: ['content-conflict', 'version-conflict'], definitions,
  possibleLoadedDefinitions: definitions.map((item) => ({ definitionKey: item.definitionKey, possible: true, status: 'active' })),
  impact: { projects: ['/repo'], runtimes: ['codex'], installationSources: ['global', 'project'], providers: ['Codex', 'Project'] },
  comparisons: [{
    before: definitions[0].definitionKey, after: definitions[1].definitionKey,
    sections: {
      frontmatter: { changed: true, before: { version: '1.0.0' }, after: { version: '2.0.0' } },
      instructions: { changed: true, beforeHash: 'c'.repeat(64), afterHash: 'd'.repeat(64), beforeBytes: 3, afterBytes: 3 },
      tools: { changed: false, before: ['read'], after: ['read'] },
      references: { changed: false, before: [], after: [] },
      scripts: { changed: false, before: [], after: [] },
    },
  }],
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ConflictDetailPage', () => {
  it('shows structured evidence and requires preview plus exact confirmation before remove and undo', async () => {
    const requests = [] as Array<{ input: string; body: Record<string, unknown> }>
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      requests.push({ input, body })
      if (input === '/api/conflicts/inspect') return { ok: true, json: async () => detail }
      if (input === '/api/conflicts/preview') return { ok: true, json: async () => ({
        previewToken: 'preview-1', action: 'remove', definitionKey: definitions[0].definitionKey,
        definition: { sourcePath: definitions[0].sourcePath }, rollback: 'Restore backup.',
        changes: [{ target: definitions[0].sourcePath, operation: 'move', diff: { before: definitions[0].sourcePath, after: `${definitions[0].sourcePath}.disabled` } }],
      }) }
      if (input === '/api/conflicts/apply') return { ok: true, json: async () => ({ recordId: 'record-1', action: 'remove', status: 'applied', changed: true }) }
      if (input === '/api/conflicts/undo') return { ok: true, json: async () => ({ recordId: 'record-1', status: 'undone', restored: true }) }
      throw new Error(`Unexpected request: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const onChanged = vi.fn()
    render(<ConflictDetailPage skill={skill} onBack={() => undefined} onChanged={onChanged} />)

    expect(await screen.findByText('Content conflict')).toBeTruthy()
    expect(screen.getByText('Version conflict')).toBeTruthy()
    expect(screen.getByText('Structured content diff')).toBeTruthy()
    expect(document.body.textContent).toContain('c'.repeat(64))
    expect(document.body.textContent).not.toContain('Old')
    expect(requests.some((request) => request.input === '/api/conflicts/apply')).toBe(false)

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'remove' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate Action Plan' }))
    const confirmation = await screen.findByRole('checkbox')
    const apply = screen.getByRole('button', { name: 'Apply confirmed action' })
    expect((apply as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(confirmation)
    fireEvent.click(apply)

    const undo = await screen.findByRole('button', { name: 'Undo' })
    expect(requests.find((request) => request.input === '/api/conflicts/apply')?.body).toEqual({ previewToken: 'preview-1', confirm: true, confirmedDefinitionKey: definitions[0].definitionKey })
    expect(onChanged).toHaveBeenCalled()
    fireEvent.click(undo)
    expect(await screen.findByText('undone')).toBeTruthy()
    expect(requests.some((request) => request.input === '/api/conflicts/undo' && request.body.recordId === 'record-1')).toBe(true)
  })
})
