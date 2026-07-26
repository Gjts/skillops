// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PromptRegistryBrowser } from './PromptRegistry'

function response(body: unknown, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body })
}

const baselineRef = `prompt-registry:${'a'.repeat(40)}:prompts%2Frelease.prompt.json:${'b'.repeat(64)}`
const candidateRef = `prompt-registry:${'c'.repeat(40)}:prompts%2Frelease.prompt.json:${'d'.repeat(64)}`
const nextRef = `prompt-registry:${'e'.repeat(40)}:prompts%2Frelease.prompt.json:${'f'.repeat(64)}`
const item = (sourceRef: string, commit: string, name: string) => ({
  artifact: { artifactId: 'release-summary', sourceRef, contentHash: sourceRef.slice(-64), version: commit },
  id: 'release-summary', name, description: '<img src=x onerror=alert(1)>', relativePath: 'prompts/release.prompt.json',
  commit, provider: 'openai', model: 'gpt-5.6-sol', variables: ['release'],
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Prompt Registry UI', () => {
  it('loads Git metadata, selects immutable versions, compares them, and nominates without displaying bodies', async () => {
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input.startsWith('/api/prompt-registry/status')) {
        const page = Number(new URL(input, 'http://127.0.0.1').searchParams.get('page'))
        return response({
          available: true,
          workspace: 'demo',
          promptDirectory: 'prompts',
          currentBranch: 'main',
          commit: 'a'.repeat(40),
          branches: page === 2 ? ['release/archive'] : ['experiment', 'main'],
          branchesPage: { page, pageSize: 50, totalItems: 51, totalPages: 2, hasPrevious: page > 1, hasNext: page < 2 },
          persistence: 'git-source-only',
        })
      }
      if (input === '/api/prompt-registry/prompts') {
        const page = JSON.parse(String(init?.body)).page
        return response({
          items: page === 2 ? [item(nextRef, 'e'.repeat(40), 'Release v3')] : [item(baselineRef, 'a'.repeat(40), 'Release v1'), item(candidateRef, 'c'.repeat(40), 'Release v2')],
          warningCount: 0, page, totalPages: 2,
        })
      }
      if (input === '/api/prompt-registry/compare') return response({ artifactId: 'release-summary', changed: true, changedFields: ['prompt'] })
      if (input === '/api/prompt-registry/nominate') return response({ capability: { id: 'cap-local-1' }, reused: false }, 201)
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    const onBaseline = vi.fn()
    const onCandidate = vi.fn()
    const onModelHint = vi.fn()
    const { container, rerender } = render(<PromptRegistryBrowser baselineRef="" candidateRef="" onBaseline={onBaseline} onCandidate={onCandidate} onModelHint={onModelHint} />)
    expect(await screen.findByText('Release v1')).toBeTruthy()
    const branchNavigation = screen.getByRole('navigation', { name: 'Git branch or commit' })
    fireEvent.click(within(branchNavigation).getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(container.querySelector('option[value="release/archive"]')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledWith('/api/prompt-registry/status?page=2&pageSize=50', undefined)
    expect(screen.getAllByText('<img src=x onerror=alert(1)>')).toHaveLength(2)
    expect(container.querySelector('img')).toBeNull()
    expect(document.body.textContent).not.toContain('private prompt body')
    fireEvent.click(screen.getAllByRole('button', { name: 'Use as baseline' })[0])
    fireEvent.click(screen.getAllByRole('button', { name: 'Use as candidate' })[1])
    expect(onBaseline).toHaveBeenCalledWith(baselineRef)
    expect(onCandidate).toHaveBeenCalledWith(candidateRef)
    rerender(<PromptRegistryBrowser baselineRef={baselineRef} candidateRef={candidateRef} onBaseline={onBaseline} onCandidate={onCandidate} onModelHint={onModelHint} />)
    fireEvent.click(screen.getByRole('button', { name: 'Compare versions' }))
    expect(await screen.findByText('Changed fields: prompt')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Target skeleton'), { target: { value: 'prompt:release-summary' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create governed Candidate' }))
    expect(await screen.findByText(/Governed Candidate created:/)).toBeTruthy()
    expect(document.body.textContent).toContain('cap-local-1')
    fireEvent.click(screen.getAllByRole('button', { name: 'Use model hint' })[0])
    expect(onModelHint).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5.6-sol' })
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Page 1 of 2' })).getByRole('button', { name: 'Next page' }))
    expect(await screen.findByText('Release v3')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/prompt-registry/nominate', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ sourceRef: candidateRef, targetSkeleton: 'prompt:release-summary' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/prompt-registry/prompts', expect.objectContaining({
      body: expect.stringContaining('"page":2'),
    }))
  })
})
