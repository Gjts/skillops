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
    approvals: [], evidenceStale: stale, reviewerIdentityAssurance: 'locally-declared',
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

  it('discloses locally-declared reviewer identity and submits independent approval', async () => {
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
    expect(await screen.findByText(/Reviewer identity is locally declared/)).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Reviewer ID' }), { target: { value: 'second-reviewer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Independent approval' }))
    expect(await screen.findByRole('button', { name: 'Start Canary' })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/capabilities/cap-1/approve', expect.objectContaining({ body: expect.stringContaining('second-reviewer') }))
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
})
