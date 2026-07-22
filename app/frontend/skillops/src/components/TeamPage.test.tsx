// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamPage } from './TeamPage'

function response(body: unknown, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body })
}

const empty = {
  revision: 0,
  team: null,
  workspaces: [], projects: [], environments: [], members: [], devices: [], policyPacks: [], exceptions: [],
  capabilities: { deployment: 'local-git', networkApi: false, sso: false, scim: false },
  templateAdoption: { totalProjects: 0, adoptedProjects: 0, currentProjects: 0, driftedProjects: 0, pendingUpgradeProjects: 0, adoptionRatePct: 0 },
}

const configured = {
  ...empty,
  revision: 8,
  team: { id: 'acme', name: 'Acme Team' },
  workspaces: [{ id: 'engineering', name: 'Engineering' }],
  projects: [{ id: 'project-a', name: 'Project A', artifactIds: ['skill:review'], template: { id: 'team-default', version: '1.0.0', status: 'upgrade-available', candidateVersion: '2.0.0' } }],
  environments: [{ id: 'production', name: 'Production', channel: 'stable' }],
  members: [{ id: 'user:owner', displayName: 'Owner', role: 'Owner', status: 'active' }],
  devices: [{ id: 'laptop', name: 'Laptop', status: 'active', lastSeenAt: '2026-07-22T00:00:00.000Z' }],
  policyPacks: [{ id: 'secure', version: '1.0.0' }],
  exceptions: [{ id: 'exception-1', projectId: 'project-a', policyId: 'secure', status: 'approved' }],
  templateAdoption: { totalProjects: 1, adoptedProjects: 1, currentProjects: 0, driftedProjects: 0, pendingUpgradeProjects: 1, adoptionRatePct: 100 },
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Team control plane UI', () => {
  it('bootstraps an unconfigured local Team without offering a network deployment mode', async () => {
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/team' && !init) return response(empty)
      if (input === '/api/team' && init?.method === 'POST') return response({ ...empty, team: { id: 'local-team', name: 'Local Team' } }, 201)
      if (input === '/api/team/catalog') return response({ items: [] })
      if (input === '/api/team/queues') return response({ approvalInbox: [], releaseQueue: [] })
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
      if (input === '/api/team/catalog') return response({ items: [{ artifactVersionId: 'skill:review:a', artifactId: 'skill:review', version: '2.0.0', contentHash: 'a'.repeat(64), source: 'github', lifecycleStatus: 'ready', owner: 'user:owner', usedByProjectIds: ['project-a'], evidenceHash: 'e'.repeat(64) }] })
      if (input === '/api/team/queues') return response({ approvalInbox: [{ capabilityId: 'cap-review', artifactId: 'review', owner: 'user:owner', evidenceHash: 'e'.repeat(64) }], releaseQueue: [{ capabilityId: 'cap-release', artifactId: 'release', stage: 'approved', targetSkeleton: 'project-a' }] })
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

  it('creates a sanitized backend backup from the Team page', async () => {
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/team' && !init) return response(configured)
      if (input === '/api/team/catalog') return response({ items: [] })
      if (input === '/api/team/queues') return response({ approvalInbox: [], releaseQueue: [] })
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
