// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactRegistry } from './ArtifactRegistry'

const hash = (value: string) => value.repeat(64)
const commit = (value: string) => value.repeat(40)

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Artifact Registry UI', () => {
  it('filters kind-scoped assets, inspects immutable versions, compares metadata, and previews Candidates', async () => {
    const snapshot = {
      schemaVersion: 1,
      generatedAt: '2026-07-22T01:00:00.000Z',
      artifacts: [
        { id: 'skill:review', artifactId: 'review', kind: 'skill', name: 'review', owner: 'platform', status: 'stable', createdAt: null, updatedAt: null, versionIds: ['skill:review@a', 'skill:review@b'] },
        { id: 'prompt:review', artifactId: 'review', kind: 'prompt', name: 'review-prompt', owner: 'design', status: 'ready', createdAt: null, updatedAt: null, versionIds: ['prompt:review@a'] },
      ],
      versions: [
        { id: 'skill:review@a', artifactId: 'skill:review', sourceArtifactId: 'review', kind: 'skill', version: '2.0.0', contentHash: hash('a'), gitCommit: commit('a'), schemaVersion: 1, runtimeTargets: ['codex'], compatibility: { codex: 'supported', 'claude-code': 'supported', cursor: 'unsupported' }, dependencies: [], source: 'github', sourceRef: 'github:stable', status: 'stable', createdAt: null },
        { id: 'skill:review@b', artifactId: 'skill:review', sourceArtifactId: 'review', kind: 'skill', version: '1.0.0', contentHash: hash('b'), gitCommit: null, schemaVersion: 1, runtimeTargets: ['codex'], compatibility: { codex: 'supported', 'claude-code': 'supported', cursor: 'unsupported' }, dependencies: [], source: 'local-scan', sourceRef: 'local-scan:review', status: 'ready', createdAt: null },
        { id: 'prompt:review@a', artifactId: 'prompt:review', sourceArtifactId: 'review', kind: 'prompt', version: '1.0.0', contentHash: hash('c'), gitCommit: commit('c'), schemaVersion: 1, runtimeTargets: ['codex'], compatibility: { codex: 'supported', 'claude-code': 'supported', cursor: 'unsupported' }, dependencies: [], source: 'prompt-registry', sourceRef: 'prompt-registry:review', status: 'ready', createdAt: null },
      ],
      installations: [
        { id: 'install-1', artifactId: 'skill:review', artifactVersionId: 'skill:review@a', runtime: 'codex', scope: 'project', targetPath: '/repo/SKILL.md', desiredState: 'present', observedState: 'drifted', observedHash: hash('b') },
      ],
      compatibility: {
        skill: { codex: 'supported', 'claude-code': 'supported', cursor: 'unsupported' },
        prompt: { codex: 'supported', 'claude-code': 'supported', cursor: 'unsupported' },
        workflow: { codex: 'unsupported', 'claude-code': 'unsupported', cursor: 'unsupported' },
        rules: { codex: 'supported', 'claude-code': 'supported', cursor: 'unsupported' },
        agent: { codex: 'unsupported', 'claude-code': 'unsupported', cursor: 'unsupported' },
      },
    }
    let resolveFirstDiff: (value: Response) => void = () => undefined
    let resolveFirstImport: (value: Response) => void = () => undefined
    const firstDiff = new Promise<Response>((resolve) => { resolveFirstDiff = resolve })
    const firstImport = new Promise<Response>((resolve) => { resolveFirstImport = resolve })
    let diffCalls = 0
    let importCalls = 0
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input)
      if (url === '/api/artifacts') return response(snapshot)
      if (url === '/api/artifacts/diff') {
        diffCalls += 1
        return diffCalls === 1
          ? firstDiff
          : response({ artifactId: 'skill:review', changed: true, changedFields: ['contentHash'], fields: { contentHash: { left: hash('d'), right: hash('e') } } })
      }
      if (url === '/api/artifacts/import-preview') {
        importCalls += 1
        return importCalls === 1
          ? firstImport
          : response({ mode: 'preview', persisted: false, version: { ...snapshot.versions[0], id: 'skill:second@candidate', artifactId: 'skill:second', sourceArtifactId: 'second', status: 'candidate' }, currentVersionIds: [], diff: null })
      }
      return response({ error: 'Not found' }, 404)
    }))

    render(<ArtifactRegistry />)
    expect(await screen.findByText('Unified Artifact Registry')).toBeTruthy()
    expect(screen.getAllByText('skill:review')).toHaveLength(2)
    expect(screen.getByText('prompt:review')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'prompt' } })
    await waitFor(() => expect(screen.queryByText('skill:review')).toBeNull())
    expect(screen.getAllByText('prompt:review')).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'all' } })

    fireEvent.click(screen.getAllByText('skill:review')[0])
    expect(await screen.findByText('Immutable versions')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Compare versions' }))
    fireEvent.change(screen.getByLabelText('Left version'), { target: { value: 'skill:review@b' } })
    fireEvent.change(screen.getByLabelText('Left version'), { target: { value: 'skill:review@a' } })
    fireEvent.click(screen.getByRole('button', { name: 'Compare versions' }))
    expect(await screen.findByText('contentHash')).toBeTruthy()
    expect(screen.getByText(hash('d'))).toBeTruthy()
    expect(screen.getByText(hash('e'))).toBeTruthy()
    resolveFirstDiff(await response({ artifactId: 'skill:review', changed: true, changedFields: ['source'], fields: { source: { left: 'stale-left', right: 'stale-right' } } }))
    await waitFor(() => expect(screen.queryByText('source')).toBeNull())

    fireEvent.change(screen.getByLabelText('Preview a GitHub Candidate'), { target: { value: 'https://github.com/acme/first' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview Candidate' }))
    fireEvent.change(screen.getByLabelText('Preview a GitHub Candidate'), { target: { value: 'https://github.com/acme/second' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview Candidate' }))
    expect(await screen.findByText('skill:second')).toBeTruthy()
    resolveFirstImport(await response({ mode: 'preview', persisted: false, version: { ...snapshot.versions[0], id: 'skill:first@candidate', artifactId: 'skill:first', sourceArtifactId: 'first', status: 'candidate' }, currentVersionIds: [], diff: null }))
    await waitFor(() => expect(screen.queryByText('skill:first')).toBeNull())
    expect(screen.getByText('Preview only; Stable was not changed.')).toBeTruthy()
  })
})
