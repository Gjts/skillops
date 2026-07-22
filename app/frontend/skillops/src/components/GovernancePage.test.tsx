// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GovernancePage } from './GovernancePage'
import type { Capability } from '../types'

const artifact = {
  kind: 'skill' as const,
  artifactId: 'review-skill',
  version: '2.0.0',
  source: 'github' as const,
  sourceRef: 'github:https://github.com/acme/review#skills/review/SKILL.md',
  contentHash: 'a'.repeat(64),
}

function capability(stage: Capability['stage'], stale = false): Capability {
  return {
    id: 'cap-1', artifact, baseline: null, owner: 'artifact-owner', targetSkeleton: 'local-scan:codex:C:/skills/review/SKILL.md',
    stage, policyId: 'default-v1', latestEvidenceRunId: stage === 'candidate' ? null : 'run-1',
    evidence: stage === 'candidate' ? null : {
      qualityRunId: 'run-1', redteamRunId: null, baselineHash: 'b'.repeat(64), candidateHash: artifact.contentHash,
      suiteHash: 'c'.repeat(64), datasetHash: null, policyHash: 'd'.repeat(64), qualityEvidenceHash: 'e'.repeat(64),
      redteamEvidenceHash: null, evidenceHash: 'f'.repeat(64), boundAt: '2026-07-21T00:00:00.000Z',
    },
    approvals: [], evidenceStale: stale, reviewerIdentityAssurance: 'server-resolved',
    createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
  }
}

function response(body: unknown, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body })
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('governance UI', () => {
  it('shows the pipeline, evidence provenance, and stale state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(response({ items: [capability('blocked', true)] })))
    render(<GovernancePage />)
    expect((await screen.findAllByText('review-skill')).length).toBe(2)
    expect(screen.getByText('Evidence is stale')).toBeTruthy()
    expect(screen.getByText('cccccccccccc')).toBeTruthy()
    expect(screen.getByRole('list', { name: 'Governance pipeline' })).toBeTruthy()
  })

  it('sends an in-memory reviewer token for independent approval', async () => {
    let current = capability('ready')
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/capabilities' && !init) return response({ items: [current] })
      if (String(input).endsWith('/approve')) {
        current = { ...current, stage: 'approved' }
        return response(current)
      }
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<GovernancePage />)
    expect(await screen.findByText(/server authenticates owners and reviewers/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Reviewer access token (not stored)'), { target: { value: 'reviewer-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Independent approval' }))
    expect(await screen.findByRole('button', { name: 'Preview Canary deployment' })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/capabilities/cap-1/approve', expect.objectContaining({
      body: '{"decision":"approved"}',
      headers: expect.objectContaining({ Authorization: 'Bearer reviewer-token' }),
    }))
  })
  it('requires a separate target plus preview and confirmation before Canary deployment', async () => {
    const current = capability('approved')
    const preview = {
      previewToken: 'canary-1', capabilityId: current.id, source: current.artifact.sourceRef, target: 'canary:review',
      projectRoot: 'C:\\projects\\review-canary',
      currentHash: null, candidateHash: current.artifact.contentHash,
      diff: { beforeLines: 0, afterLines: 12, changedLines: 12 }, conflict: false,
      backup: null, rollbackPlan: 'Remove the Canary deployment.', expiresAt: '2026-07-21T01:00:00.000Z',
    }
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/capabilities' && !init) return response({ items: [current] })
      if (String(input).endsWith('/canary')) return response(JSON.parse(String(init?.body)).action === 'preview' ? preview : { capability: { ...current, stage: 'canary' } })
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<GovernancePage />)
    fireEvent.change(await screen.findByLabelText('Separate Canary project root'), { target: { value: 'C:\\projects\\review-canary' } })
    fireEvent.change(await screen.findByLabelText('Separate Canary target'), { target: { value: 'canary:review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview Canary deployment' }))
    const apply = await screen.findByRole('button', { name: 'Confirm Canary deployment' })
    expect((apply as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(apply)
    expect(fetchMock).toHaveBeenCalledWith('/api/capabilities/cap-1/canary', expect.objectContaining({
      body: '{"action":"preview","targetSkeleton":"canary:review","projectRoot":"C:\\\\projects\\\\review-canary"}',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/capabilities/cap-1/canary', expect.objectContaining({
      body: '{"action":"apply","previewToken":"canary-1","confirm":true,"targetSkeleton":"canary:review","projectRoot":"C:\\\\projects\\\\review-canary"}',
    }))
  })


  it('clears a reviewer token after a failed approval attempt', async () => {
    const current = capability('ready')
    vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/capabilities' && !init) return response({ items: [current] })
      if (String(input).endsWith('/approve')) return response({ error: { message: 'Approval denied' } }, 403)
      return response({ error: { message: 'Not found' } }, 404)
    }))
    render(<GovernancePage />)
    const token = await screen.findByLabelText('Reviewer access token (not stored)')
    fireEvent.change(token, { target: { value: 'reviewer-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Independent approval' }))
    expect(await screen.findByText('Approval denied')).toBeTruthy()
    expect((token as HTMLInputElement).value).toBe('')
  })

  it('rebinds stale Canary evidence before exposing release controls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(response({ items: [capability('canary', true)] })))
    render(<GovernancePage />)
    expect(await screen.findByRole('button', { name: 'Validate and bind' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Preview promotion' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Preview installation' })).toBeNull()
  })

  it('routes historical requalification back to restoration, not Canary', async () => {
    let current = capability('deprecated', true)
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/capabilities' && !init) return response({ items: [current] })
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<GovernancePage />)
    expect(await screen.findByRole('button', { name: 'Validate and bind' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Preview restoration' })).toBeNull()
    view.unmount()

    current = { ...capability('approved'), requalifiesStage: 'deprecated' }
    render(<GovernancePage />)
    expect(await screen.findByRole('button', { name: 'Preview restoration' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start Canary' })).toBeNull()
  })

  it('routes requalified superseded evidence through the current Stable rollback', async () => {
    const previous = { ...capability('approved'), id: 'cap-previous', requalifiesStage: 'superseded' as const }
    const stable = { ...capability('stable'), id: 'cap-stable' }
    const preview = {
      previewToken: 'rollback-1',
      capabilityId: stable.id,
      source: previous.artifact.sourceRef,
      target: stable.targetSkeleton,
      currentHash: stable.artifact.contentHash,
      candidateHash: previous.artifact.contentHash,
      diff: { beforeLines: 12, afterLines: 10, changedLines: 3 },
      conflict: false,
      backup: 'SKILL.md.skillops-backup',
      rollbackPlan: 'Restore previous Stable.',
      expiresAt: '2026-07-21T01:00:00.000Z',
    }
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/capabilities' && !init) return response({ items: [previous, stable] })
      if (input === '/api/capabilities/cap-stable/rollback') return response(preview)
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<GovernancePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Preview rollback' }))
    const apply = await screen.findByRole('button', { name: 'Confirm rollback' })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(apply)
    expect(fetchMock).toHaveBeenCalledWith('/api/capabilities/cap-stable/rollback', expect.objectContaining({
      body: expect.stringContaining('"action":"apply"'),
    }))
  })

  it('requires preview plus a second confirmation before Stable', async () => {
    const current = capability('canary')
    const preview = {
      previewToken: 'preview-1', capabilityId: current.id, source: current.artifact.sourceRef, target: current.targetSkeleton,
      currentHash: 'b'.repeat(64), candidateHash: current.artifact.contentHash,
      diff: { beforeLines: 10, afterLines: 12, changedLines: 3 }, conflict: false,
      backup: 'SKILL.md.skillops-backup', rollbackPlan: 'Restore backup.', expiresAt: '2026-07-21T01:00:00.000Z',
    }
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/capabilities' && !init) return response({ items: [current] })
      if (String(input).endsWith('/promote')) return response(preview)
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<GovernancePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Preview promotion' }))
    expect(screen.getByRole('button', { name: 'Preview installation' })).toBeTruthy()
    const apply = await screen.findByRole('button', { name: 'Confirm Stable write' })
    const region = screen.getByRole('region', { name: 'File change preview' })
    expect(within(region).getByText(current.artifact.sourceRef)).toBeTruthy()
    expect(within(region).getByText(current.targetSkeleton)).toBeTruthy()
    expect(within(region).getByText('10')).toBeTruthy()
    expect(within(region).getByText('12')).toBeTruthy()
    expect(within(region).getByText('3')).toBeTruthy()
    expect(within(region).getByText('Restore backup.')).toBeTruthy()
    expect((apply as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect((apply as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(apply)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/capabilities/cap-1/promote', expect.objectContaining({ body: expect.stringContaining('"confirm":true') }))
  })

  it('previews Stable removal and then exposes restoration for the deprecated version', async () => {
    let current = capability('stable')
    const preview = {
      previewToken: 'deprecate-1', capabilityId: current.id, source: current.artifact.sourceRef, target: current.targetSkeleton,
      currentHash: current.artifact.contentHash, candidateHash: current.artifact.contentHash,
      diff: { beforeLines: 12, afterLines: 0, changedLines: 12 }, conflict: false,
      backup: 'SKILL.md.skillops-backup', rollbackPlan: 'Restore backup.', expiresAt: '2026-07-21T01:00:00.000Z',
    }
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/capabilities' && !init) return response({ items: [current] })
      if (String(input).endsWith('/deprecate')) {
        if (String(init?.body).includes('"action":"apply"')) current = { ...current, stage: 'deprecated' }
        return response(preview)
      }
      return response({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<GovernancePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Preview deprecation and removal' }))
    const apply = await screen.findByRole('button', { name: 'Confirm deprecation and removal' })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(apply)
    expect(await screen.findByRole('button', { name: 'Preview restoration' })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/capabilities/cap-1/deprecate', expect.objectContaining({ body: expect.stringContaining('"confirm":true') }))
  })
})
