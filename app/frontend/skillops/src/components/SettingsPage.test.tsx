// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultAiSettings } from '../lib/ai-settings'
import { SettingsPage } from './SettingsPage'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => ({
    ok: true,
    status: 200,
    json: async () => input === '/api/ai-settings'
      ? createDefaultAiSettings()
      : { generatedAt: '2026-07-25T12:00:00.000Z', count: 0, lastRuntimeEventAt: null },
  })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

describe('Settings deep links', () => {
  it.each([
    ['connections', 'connections'],
    ['provider', 'provider'],
    ['data', 'data'],
  ])('focuses the %s section', async (section, expected) => {
    window.history.replaceState({}, '', `/settings?section=${section}`)
    render(<SettingsPage connections={[]} onConnect={() => undefined} onRefresh={() => undefined} onClear={async () => ({ removed: 0 })} onNavigate={() => undefined} />)

    await waitFor(() => expect((document.activeElement as HTMLElement)?.dataset.settingsSection).toBe(expected))
  })

  it('warns when the event summary was recovered from a partial source', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/ai-settings'
        ? createDefaultAiSettings()
        : { generatedAt: '2026-07-25T12:00:00.000Z', count: 1, lastRuntimeEventAt: null, sourceStatus: 'partial' },
    })))
    render(<SettingsPage connections={[]} onConnect={() => undefined} onRefresh={() => undefined} onClear={async () => ({ removed: 0 })} onNavigate={() => undefined} />)

    expect((await screen.findByRole('alert')).textContent).toContain('Some local sources are unavailable or partial')
  })

  it('refreshes the authoritative event summary immediately after clearing', async () => {
    let summaryReads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/ai-settings'
        ? createDefaultAiSettings()
        : { generatedAt: '2026-07-25T12:00:00.000Z', count: summaryReads++ ? 0 : 3, lastRuntimeEventAt: null },
    })))
    const onClear = vi.fn(async () => ({ removed: 3, backupFile: 'events.backup.jsonl' }))
    render(<SettingsPage connections={[]} onConnect={() => undefined} onRefresh={() => undefined} onClear={onClear} onNavigate={() => undefined} />)

    await screen.findByText('3 events')
    fireEvent.click(screen.getByRole('button', { name: 'Clear event data' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear and create backup' }))

    expect(await screen.findByText('0 events')).toBeTruthy()
    expect(onClear).toHaveBeenCalledOnce()
    expect(summaryReads).toBe(2)
  })

  it('routes every advanced entry to a distinct implemented surface', async () => {
    const onNavigate = vi.fn()
    render(<SettingsPage connections={[]} onConnect={() => undefined} onRefresh={() => undefined} onClear={async () => ({ removed: 0 })} onNavigate={onNavigate} />)
    await screen.findByText('0 events')

    fireEvent.click(screen.getByRole('button', { name: 'Team' }))
    fireEvent.click(screen.getByRole('button', { name: 'Policies' }))
    fireEvent.click(screen.getByRole('button', { name: 'Templates' }))
    fireEvent.click(screen.getByRole('button', { name: 'PromptHub' }))
    fireEvent.click(screen.getByRole('button', { name: 'Audit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Developer diagnostics' }))
    expect(onNavigate.mock.calls).toEqual([
      ['team', '/settings?section=advanced-team'],
      ['team', '/settings?section=advanced-team&view=policies'],
      ['team', '/settings?section=advanced-team&view=templates'],
      ['assets', '/assets?artifactKind=prompt&artifactSource=prompthub'],
      ['releases', '/releases'],
      ['assets', '/assets?view=diagnostics'],
    ])
  })
})
