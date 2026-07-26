// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectModal } from './ConnectModal'

const healthyPreflight = {
  checkedAt: '2026-07-25T12:00:00.000Z',
  node: { version: '22.22.0', minimumVersion: '22.22.0', supported: true },
  git: { available: true },
  localApi: { available: true },
  dataDirectory: { available: true, writable: true },
  runtimes: {
    available: true,
    items: [{ runtime: 'codex', configurationDetected: true, configurationStatus: 'installed', adapterReferenceHealth: 'healthy' }],
  },
}

const disconnected = [
  { runtime: 'codex' as const, status: 'not-installed' as const, configurationStatus: 'not-installed' as const, connectionStage: 'not-detected' as const, eventCount: 0 },
  { runtime: 'claude-code' as const, status: 'not-installed' as const, configurationStatus: 'not-installed' as const, connectionStage: 'not-detected' as const, eventCount: 0 },
  { runtime: 'cursor' as const, status: 'preview' as const, configurationStatus: 'preview' as const, connectionStage: 'preview-only' as const, eventCount: 0 },
]

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('runtime connection dialog accessibility', () => {
  it('closes when the user presses Escape', () => {
    const onClose = vi.fn()
    render(<ConnectModal onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('moves focus into the dialog and exposes the complete verification flow', () => {
    render(<ConnectModal connections={disconnected} onRefresh={async () => disconnected} onClose={() => undefined} />)

    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Codex/ }))
    for (const label of [
      '1 · Run preflight',
      '2 · Review redacted preview',
      '3 · Confirm write',
      '4 · Restart runtime',
      '5 · Inspect configuration',
      '6 · Trigger a real Skill',
      '7 · Wait for lifecycle evidence',
      '8 · Verified',
    ]) expect(screen.getByText(label)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Finish setup' })).toHaveProperty('disabled', true)
  })

  it('does not treat installation or old activity as verified evidence', () => {
    const awaiting = [
      {
        runtime: 'codex' as const,
        status: 'installed' as const,
        configurationStatus: 'installed' as const,
        connectionStage: 'awaiting-verification' as const,
        eventCount: 2,
        lastActivityAt: '2026-07-19T12:00:00.000Z',
        verificationBoundaryAt: '2026-07-20T12:00:00.000Z',
      },
      ...disconnected.slice(1),
    ]
    render(<ConnectModal connections={awaiting} onRefresh={async () => awaiting} onClose={() => undefined} />)

    expect(screen.getByText('Adapter installed')).toBeTruthy()
    expect(screen.getByText('The adapter changed after the last evidence. Run a Skill again.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Finish setup' })).toHaveProperty('disabled', true)
  })

  it('wraps keyboard focus and restores it when the dialog unmounts', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { unmount } = render(<ConnectModal connections={disconnected} onRefresh={async () => disconnected} onClose={() => undefined} />)
    const dialog = screen.getByRole('dialog')
    const first = screen.getByRole('button', { name: 'Close' })
    const last = screen.getByRole('button', { name: 'Cancel' })

    first.focus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('shows the sanitized server preflight facts without executing commands', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => healthyPreflight,
    }))

    render(<ConnectModal connections={disconnected} onRefresh={async () => disconnected} onClose={() => undefined} />)

    expect(await screen.findByText('Node.js 22.22.0')).toBeTruthy()
    expect(screen.getByText('Git')).toBeTruthy()
    expect(screen.getByText('Local API')).toBeTruthy()
    expect(screen.getByText('Data directory')).toBeTruthy()
    expect(screen.getByText('Codex adapter reference')).toBeTruthy()
    expect(screen.getAllByText('Ready')).toHaveLength(5)
    expect(screen.queryByText('npm run codex:install')).toBeNull()
    const confirmation = screen.getByRole('checkbox', { name: 'I reviewed the redacted dry-run preview.' })
    expect(confirmation).toHaveProperty('checked', false)
    fireEvent.click(confirmation)
    expect(screen.getByText('npm run codex:install')).toBeTruthy()
  })

  it('keeps installation locked when preflight facts need attention', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...healthyPreflight, dataDirectory: { available: true, writable: false } }),
    }))

    render(<ConnectModal connections={disconnected} onRefresh={async () => disconnected} onClose={() => undefined} />)

    const confirmation = await screen.findByRole('checkbox', { name: 'I reviewed the redacted dry-run preview.' })
    expect(confirmation).toHaveProperty('disabled', true)
    expect(screen.getByText('Read-only')).toBeTruthy()
    expect(screen.queryByText('npm run codex:install')).toBeNull()
  })

  it('shows an unavailable directory probe as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...healthyPreflight, dataDirectory: { available: false, writable: false } }),
    }))

    render(<ConnectModal connections={disconnected} onRefresh={async () => disconnected} onClose={() => undefined} />)

    expect(await screen.findByText('Unavailable')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'I reviewed the redacted dry-run preview.' })).toHaveProperty('disabled', true)
  })

  it('treats an unconfigured adapter as ready to install', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ...healthyPreflight,
        runtimes: {
          available: true,
          items: [{ ...healthyPreflight.runtimes.items[0], configurationStatus: 'not-installed', adapterReferenceHealth: 'not-configured' }],
        },
      }),
    }))

    render(<ConnectModal connections={disconnected} onRefresh={async () => disconnected} onClose={() => undefined} />)

    await waitFor(() => expect(screen.getAllByText('Ready')).toHaveLength(5))
    expect(screen.getByRole('checkbox', { name: 'I reviewed the redacted dry-run preview.' })).toHaveProperty('disabled', false)
  })

  it('keeps the reinstall path available for a broken adapter reference', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ...healthyPreflight,
        runtimes: {
          available: true,
          items: [{ ...healthyPreflight.runtimes.items[0], configurationStatus: 'broken', adapterReferenceHealth: 'unhealthy' }],
        },
      }),
    }))

    render(<ConnectModal connections={disconnected} onRefresh={async () => disconnected} onClose={() => undefined} />)

    const confirmation = await screen.findByRole('checkbox', { name: 'I reviewed the redacted dry-run preview.' })
    expect(screen.getByText('Needs attention')).toBeTruthy()
    expect(confirmation).toHaveProperty('disabled', false)
    fireEvent.click(confirmation)
    expect(screen.getByText('npm run codex:install')).toBeTruthy()
  })

  it('refreshes preflight facts after a broken adapter is repaired', async () => {
    const brokenPreflight = {
      ...healthyPreflight,
      runtimes: {
        available: true,
        items: [{ ...healthyPreflight.runtimes.items[0], configurationStatus: 'broken', adapterReferenceHealth: 'unhealthy' }],
      },
    }
    const broken = [
      { ...disconnected[0], status: 'broken' as const, configurationStatus: 'broken' as const, connectionStage: 'degraded' as const },
      ...disconnected.slice(1),
    ]
    const repaired = [
      { ...disconnected[0], status: 'installed' as const, configurationStatus: 'installed' as const, connectionStage: 'awaiting-verification' as const },
      ...disconnected.slice(1),
    ]
    const fetchPreflight = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => brokenPreflight })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => healthyPreflight })
    const onRefresh = vi.fn().mockResolvedValue(repaired)
    vi.stubGlobal('fetch', fetchPreflight)

    render(<ConnectModal connections={broken} onRefresh={onRefresh} onClose={() => undefined} />)
    expect(await screen.findByText('Needs attention')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Check installation' }))

    await waitFor(() => expect(screen.getAllByText('Ready')).toHaveLength(5))
    expect(screen.getByText('Adapter installed')).toBeTruthy()
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(fetchPreflight).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the preflight response is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ node: healthyPreflight.node, runtimes: healthyPreflight.runtimes }),
    }))

    render(<ConnectModal connections={disconnected} onRefresh={async () => disconnected} onClose={() => undefined} />)

    expect((await screen.findByRole('alert')).textContent).toContain('Local preflight results are unavailable.')
    expect(screen.getByRole('checkbox', { name: 'I reviewed the redacted dry-run preview.' })).toHaveProperty('disabled', true)
  })

  it('aborts a stalled preflight request and exposes a retry', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_input: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')))
      })
    }))

    render(<ConnectModal connections={disconnected} onRefresh={async () => disconnected} onClose={() => undefined} />)
    expect(screen.getByText('Checking…')).toBeTruthy()

    await act(async () => { await vi.advanceTimersByTimeAsync(8_000) })

    expect(signal?.aborted).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('Local preflight results are unavailable.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('does not infer verification from an event count when the server stage is absent', () => {
    const installed = [
      {
        runtime: 'codex' as const,
        status: 'installed' as const,
        configurationStatus: 'installed' as const,
        eventCount: 2,
      },
      ...disconnected.slice(1),
    ]
    render(<ConnectModal connections={installed} onRefresh={async () => installed} onClose={() => undefined} />)

    expect(screen.getByText('Waiting for a real post-install Skill lifecycle event. Discovery does not count as verification.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Finish setup' })).toHaveProperty('disabled', true)
  })

  it('finishes only after a post-install lifecycle event is verified', () => {
    const verified = [
      {
        runtime: 'codex' as const,
        status: 'installed' as const,
        configurationStatus: 'installed' as const,
        connectionStage: 'verified' as const,
        eventCount: 2,
        verifiedEvidenceAt: '2026-07-25T12:00:00.000Z',
      },
      ...disconnected.slice(1),
    ]
    render(<ConnectModal connections={verified} onRefresh={async () => verified} onClose={() => undefined} />)

    expect(screen.getByText('Verified with real Skill lifecycle evidence.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Finish setup' })).toHaveProperty('disabled', false)
  })

  it('announces successful and failed clipboard writes', async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => healthyPreflight }))
    render(<ConnectModal connections={disconnected} onRefresh={async () => disconnected} onClose={() => undefined} />)

    fireEvent.click(await screen.findByRole('checkbox', { name: 'I reviewed the redacted dry-run preview.' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy preflight command' }))
    expect((await screen.findByRole('status')).textContent).toBe('Command copied.')
    expect(screen.getByRole('button', { name: 'Preflight command copied' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Copy install command' }))
    expect((await screen.findByRole('status')).textContent).toBe('Copy failed. Select the command and copy it manually.')
    expect(screen.getByRole('button', { name: 'Install command copy failed' })).toBeTruthy()
  })
})
