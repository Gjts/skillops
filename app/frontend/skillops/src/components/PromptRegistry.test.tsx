// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PromptRegistryBrowser } from './PromptRegistry'

function response(body: unknown, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body })
}

const baselineRef = `prompt-registry:${'a'.repeat(40)}:prompts%2Frelease.prompt.json:${'b'.repeat(64)}`
const candidateRef = `prompt-registry:${'c'.repeat(40)}:prompts%2Frelease.prompt.json:${'d'.repeat(64)}`
const item = (sourceRef: string, commit: string, name: string) => ({
  artifact: { artifactId: 'release-summary', sourceRef, contentHash: sourceRef.slice(-64), version: commit },
  id: 'release-summary', name, description: '<img src=x onerror=alert(1)>', relativePath: 'prompts/release.prompt.json',
  commit, provider: 'openai', model: 'gpt-5.6-sol', variables: ['release'],
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Prompt Registry UI', () => {
  it('loads Git metadata, selects immutable versions, compares them, and nominates without displaying bodies', async () => {
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/prompt-registry/status') return response({
        available: true, workspace: 'demo', promptDirectory: 'prompts', currentBranch: 'main', commit: 'a'.repeat(40), branches: ['experiment', 'main'], persistence: 'git-source-only',
      })
      if (input === '/api/prompt-registry/prompts') return response({ items: [item(baselineRef, 'a'.repeat(40), 'Release v1'), item(candidateRef, 'c'.repeat(40), 'Release v2')], warnings: [] })
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
    expect(fetchMock).toHaveBeenCalledWith('/api/prompt-registry/nominate', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ sourceRef: candidateRef, targetSkeleton: 'prompt:release-summary' }),
    }))
  })
})
