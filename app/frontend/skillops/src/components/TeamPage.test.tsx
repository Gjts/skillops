// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamPage } from './TeamPage'

function response(body: unknown, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body })
}

function page(items: unknown[], overrides: Record<string, unknown> = {}) {
  const current = Number(overrides.page || 1)
  const totalItems = Number(overrides.totalItems ?? items.length)
  const totalPages = Number(overrides.totalPages ?? (totalItems ? 1 : 0))
  return {
    items,
    page: current,
    pageSize: 20,
    totalItems,
    totalPages,
    hasPrevious: current > 1 && totalItems > 0,
    hasNext: current < totalPages,
    revision: 8,
    ...overrides,
  }
}

const empty = {
  revision: 0,
  team: null,
  counts: { workspaces: 0, projects: 0, environments: 0, activeMembers: 0, activeDevices: 0, policyPacks: 0, exceptions: 0 },
  lastCollectorAt: null,
  capabilities: { deployment: 'local-git', networkApi: false, sso: false, scim: false },
  templateAdoption: { totalProjects: 0, adoptedProjects: 0, currentProjects: 0, driftedProjects: 0, pendingUpgradeProjects: 0, adoptionRatePct: 0 },
}

const configured = {
  ...empty,
  revision: 8,
  team: { id: 'acme', name: 'Acme Team' },
  counts: { workspaces: 1, projects: 1, environments: 1, activeMembers: 1, activeDevices: 1, policyPacks: 1, exceptions: 1 },
  lastCollectorAt: '2026-07-22T00:00:00.000Z',
  templateAdoption: { totalProjects: 1, adoptedProjects: 1, currentProjects: 0, driftedProjects: 0, pendingUpgradeProjects: 1, adoptionRatePct: 100 },
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

describe('Team control plane UI', () => {
  it('bootstraps an unconfigured local Team without offering a network deployment mode', async () => {
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/team' && !init) return response(empty)
      if (input === '/api/team' && init?.method === 'POST') return response({ ...empty, team: { id: 'local-team', name: 'Local Team' } }, 201)
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<TeamPage />)

    expect(await screen.findByText('Set up the local Team control plane')).toBeTruthy()
    expect(screen.getByText('Local + Git only; no network API is exposed.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create Team' }))
    expect(fetchMock).toHaveBeenCalledWith('/api/team', expect.objectContaining({ method: 'POST', body: '{"id":"local-team","name":"Local Team"}' }))
  })

  it('shows the unified asset directory plus approval and release queues from backend facts', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string) => {
      if (input === '/api/team') return response(configured)
      if (input === '/api/team/catalog?page=1&pageSize=20') return response(page([{ artifactVersionId: 'skill:review:a', artifactId: 'skill:review', version: '2.0.0', contentHash: 'a'.repeat(64), source: 'github', lifecycleStatus: 'ready', owner: 'user:owner', usedByProjectIds: ['project-a'], evidenceHash: 'e'.repeat(64) }]))
      if (input === '/api/team/queues?kind=approval&page=1&pageSize=20') return response(page([{ capabilityId: 'cap-review', artifactId: 'review', owner: 'user:owner', evidenceHash: 'e'.repeat(64) }]))
      if (input === '/api/team/queues?kind=release&page=1&pageSize=20') return response(page([{ capabilityId: 'cap-release', artifactId: 'release', stage: 'approved', targetSkeleton: 'project-a' }]))
      return response({ error: { message: 'Not found' } }, 404)
    }))
    render(<TeamPage />)

    expect(await screen.findByText('Acme Team')).toBeTruthy()
    expect(screen.getByText('skill:review')).toBeTruthy()
    expect(screen.getAllByText('project-a')).toHaveLength(2)
    expect(screen.getByText('Approval Inbox')).toBeTruthy()
    expect(screen.getByText('Release Queue')).toBeTruthy()
    expect(screen.getByText(/Latest Collector activity:/)).toBeTruthy()
    expect(screen.getByText('Template adoption')).toBeTruthy()
    expect(screen.getByText('100%')).toBeTruthy()
    expect(screen.getByText('Pending template upgrades')).toBeTruthy()
  })

  it.each([
    {
      href: '/settings?section=advanced-team&view=policies',
      title: 'Policies status',
      description: 'Policy editing remains available through the local CLI and API.',
      labels: ['Policy Packs', 'Policy exceptions'],
    },
    {
      href: '/settings?section=advanced-team&view=templates',
      title: 'Templates status',
      description: 'Template editing remains available through the local CLI and API.',
      labels: ['Template adoption', 'Template drift', 'Pending template upgrades'],
    },
  ])('shows the focused $title view without implying a browser editor', async ({ href, title, description, labels }) => {
    window.history.replaceState({}, '', href)
    vi.stubGlobal('fetch', vi.fn((input: string) => {
      if (input === '/api/team') return response(configured)
      if (input === '/api/team/catalog?page=1&pageSize=20') return response(page([]))
      if (input === '/api/team/queues?kind=approval&page=1&pageSize=20') return response(page([]))
      if (input === '/api/team/queues?kind=release&page=1&pageSize=20') return response(page([]))
      return response({ error: { message: 'Not found' } }, 404)
    }))
    render(<TeamPage />)

    const focused = await screen.findByRole('region', { name: title })
    expect(focused.textContent).toContain(description)
    for (const label of labels) expect(focused.textContent).toContain(label)
  })

  it('moves through bounded server pages without loading the full Team catalog', async () => {
    const fetchMock = vi.fn((input: string) => {
      if (input === '/api/team') return response(configured)
      if (input === '/api/team/catalog?page=1&pageSize=20') return response(page([{ artifactVersionId: 'skill:item-01:a', artifactId: 'skill:item-01', version: '1.0.0', contentHash: 'a'.repeat(64), source: 'github', lifecycleStatus: 'ready', owner: 'user:owner', usedByProjectIds: [], evidenceHash: null }], { totalItems: 21, totalPages: 2 }))
      if (input === '/api/team/catalog?page=2&pageSize=20') return response(page([{ artifactVersionId: 'skill:item-21:b', artifactId: 'skill:item-21', version: '1.0.0', contentHash: 'b'.repeat(64), source: 'github', lifecycleStatus: 'ready', owner: 'user:owner', usedByProjectIds: [], evidenceHash: null }], { page: 2, totalItems: 21, totalPages: 2 }))
      if (input === '/api/team/queues?kind=approval&page=1&pageSize=20') return response(page([]))
      if (input === '/api/team/queues?kind=release&page=1&pageSize=20') return response(page([]))
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<TeamPage />)

    expect(await screen.findByText('skill:item-01')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(await screen.findByText('skill:item-21')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/team/catalog?page=2&pageSize=20', undefined)
  })

  it('creates a sanitized backend backup from the Team page', async () => {
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/team' && !init) return response(configured)
      if (input === '/api/team/catalog?page=1&pageSize=20') return response(page([]))
      if (input === '/api/team/queues?kind=approval&page=1&pageSize=20') return response(page([]))
      if (input === '/api/team/queues?kind=release&page=1&pageSize=20') return response(page([]))
      if (input === '/api/team/backup' && init?.method === 'POST') return response({ file: 'team-backup.json' }, 201)
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<TeamPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Create backup' }))
    expect(await screen.findByText('Backup created: team-backup.json')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/team/backup', expect.objectContaining({ method: 'POST', body: '{}' }))
  })
})
