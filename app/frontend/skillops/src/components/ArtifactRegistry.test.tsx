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
    window.history.replaceState({}, '', '/assets')
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
      if (url.startsWith('/api/artifacts?')) {
        const params = new URL(url, 'http://127.0.0.1').searchParams
        const selectedArtifacts = snapshot.artifacts.filter((artifact) => !params.get('kind') || artifact.kind === params.get('kind'))
        const selectedIds = new Set(selectedArtifacts.map((artifact) => artifact.id))
        return response({
          ...snapshot,
          artifacts: selectedArtifacts,
          versions: snapshot.versions.filter((version) => selectedIds.has(version.artifactId)),
          installations: snapshot.installations.filter((installation) => selectedIds.has(installation.artifactId)),
          page: 1,
          pageSize: 50,
          totalItems: selectedArtifacts.length,
          totalPages: selectedArtifacts.length ? 1 : 0,
          hasPrevious: false,
          hasNext: false,
          stats: { totalArtifacts: snapshot.artifacts.length, driftedInstallations: 1 },
          facets: {
            kinds: [{ value: 'prompt', count: 1 }, { value: 'skill', count: 1 }],
            sources: [{ value: 'github', count: 1 }, { value: 'local-scan', count: 1 }, { value: 'prompt-registry', count: 1 }],
            statuses: [{ value: 'ready', count: 1 }, { value: 'stable', count: 1 }],
            runtimes: [{ value: 'codex', count: 2 }],
            owners: [{ value: 'design', count: 1 }, { value: 'platform', count: 1 }],
          },
        })
      }
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
    await waitFor(() => expect(screen.getAllByText('prompt:review')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'all' } })

    fireEvent.click((await screen.findAllByText('skill:review'))[0])
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

  it('drives filters and stable pagination from the server and restores Artifact URL state', async () => {
    window.history.replaceState({}, '', '/assets?tab=skills&artifactPage=2')
    const artifacts = Array.from({ length: 51 }, (_, index) => ({
      id: `skill:artifact-${String(index).padStart(3, '0')}`,
      artifactId: `artifact-${String(index).padStart(3, '0')}`,
      kind: 'skill',
      name: `artifact-${String(index).padStart(3, '0')}`,
      owner: index % 2 ? 'design' : 'platform',
      status: 'stable',
      createdAt: null,
      updatedAt: null,
      versionIds: [`skill:artifact-${String(index).padStart(3, '0')}@1`],
    }))
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      const parsed = new URL(url, 'http://127.0.0.1')
      const query = (parsed.searchParams.get('query') || '').toLowerCase()
      const page = Number(parsed.searchParams.get('page') || 1)
      const pageSize = Number(parsed.searchParams.get('pageSize') || 50)
      const filtered = artifacts.filter((artifact) => !query || artifact.name.includes(query))
      const visible = filtered.slice((page - 1) * pageSize, page * pageSize)
      return response({
        schemaVersion: 1,
        generatedAt: '2026-07-22T01:00:00.000Z',
        artifacts: visible,
        versions: visible.map((artifact) => ({
          id: `${artifact.id}@1`,
          artifactId: artifact.id,
          sourceArtifactId: artifact.artifactId,
          kind: 'skill',
          version: '1.0.0',
          contentHash: hash('a'),
          gitCommit: null,
          schemaVersion: 1,
          runtimeTargets: ['codex'],
          compatibility: { codex: 'supported', 'claude-code': 'supported', cursor: 'unsupported' },
          dependencies: [],
          source: 'local-scan',
          sourceRef: `local-scan:${artifact.id}`,
          status: 'stable',
          createdAt: null,
        })),
        installations: [],
        compatibility: { skill: { codex: 'supported', 'claude-code': 'supported', cursor: 'unsupported' } },
        warnings: [],
        page,
        pageSize,
        totalItems: filtered.length,
        totalPages: Math.ceil(filtered.length / pageSize),
        hasPrevious: page > 1,
        hasNext: page * pageSize < filtered.length,
        stats: { totalArtifacts: artifacts.length, driftedInstallations: 0 },
        facets: {
          kinds: [{ value: 'skill', count: 51 }],
          sources: [{ value: 'local-scan', count: 51 }],
          statuses: [{ value: 'stable', count: 51 }],
          runtimes: [{ value: 'codex', count: 51 }],
          owners: [{ value: 'design', count: 25 }, { value: 'platform', count: 26 }],
        },
      })
    }))

    render(<ArtifactRegistry />)

    expect((await screen.findAllByText('artifact-050')).length).toBeGreaterThan(0)
    expect(screen.queryByText('artifact-000')).toBeNull()
    expect(requested[0]).toContain('page=2')
    expect(window.location.search).toContain('tab=skills')

    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    expect((await screen.findAllByText('artifact-000')).length).toBeGreaterThan(0)
    expect(window.location.search).not.toContain('artifactPage=2')

    fireEvent.change(screen.getByLabelText('Search Artifacts'), { target: { value: 'artifact-010' } })
    await waitFor(() => expect(requested.at(-1)).toContain('query=artifact-010'))
    expect((await screen.findAllByText('artifact-010')).length).toBeGreaterThan(0)
    expect(window.location.search).toContain('artifactQuery=artifact-010')

    await waitFor(() => {
      window.history.pushState({}, '', '/assets?tab=skills&artifactQuery=artifact-020')
      window.dispatchEvent(new PopStateEvent('popstate'))
      expect(requested.at(-1)).toContain('query=artifact-020')
    })
    expect((await screen.findAllByText('artifact-020')).length).toBeGreaterThan(0)
    expect(window.location.search).toContain('tab=skills')

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'skill' } })
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'local-scan' } })
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'stable' } })
    fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'codex' } })
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'platform' } })
    await waitFor(() => {
      expect(requested.at(-1)).toContain('kind=skill')
      expect(requested.at(-1)).toContain('source=local-scan')
      expect(requested.at(-1)).toContain('status=stable')
      expect(requested.at(-1)).toContain('runtime=codex')
      expect(requested.at(-1)).toContain('owner=platform')
    })
    expect(window.location.search).toContain('artifactKind=skill')
    expect(window.location.search).toContain('artifactSource=local-scan')
    expect(window.location.search).toContain('artifactStatus=stable')
    expect(window.location.search).toContain('artifactRuntime=codex')
    expect(window.location.search).toContain('artifactOwner=platform')
  })

  it('refreshes an already-current scan token when remounted after a Registry mutation', async () => {
    window.history.replaceState({}, '', '/assets?tab=skills')
    const requested: Array<{ url: string; method: string }> = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      requested.push({ url: String(input), method: init?.method || 'GET' })
      return response({
        schemaVersion: 1,
        generatedAt: '2026-07-22T01:00:00.000Z',
        sourceStatus: 'complete',
        artifacts: [],
        versions: [],
        installations: [],
        compatibility: {},
        warnings: [],
        page: 1,
        pageSize: 50,
        totalItems: 0,
        totalPages: 0,
        hasPrevious: false,
        hasNext: false,
        stats: { totalArtifacts: 0, driftedInstallations: 0 },
        facets: { kinds: [], sources: [], statuses: [], runtimes: [], owners: [] },
      })
    }))

    render(<ArtifactRegistry refreshToken="scan-after-apply" />)

    await waitFor(() => expect(requested).toHaveLength(1))
    expect(requested[0].url).toContain('/api/artifacts/refresh?')
    expect(requested[0].method).toBe('POST')
  })
})
