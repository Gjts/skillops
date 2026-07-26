// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
})
