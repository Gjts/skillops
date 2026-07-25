// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectModal } from './ConnectModal'

const disconnected = [
  { runtime: 'codex' as const, status: 'not-installed' as const, configurationStatus: 'not-installed' as const, connectionStage: 'not-installed' as const, eventCount: 0 },
  { runtime: 'claude-code' as const, status: 'not-installed' as const, configurationStatus: 'not-installed' as const, connectionStage: 'not-installed' as const, eventCount: 0 },
  { runtime: 'cursor' as const, status: 'preview' as const, configurationStatus: 'preview' as const, connectionStage: 'preview-only' as const, eventCount: 0 },
]

afterEach(() => {
  cleanup()
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
    render(<ConnectModal connections={disconnected} onRefresh={async () => disconnected} onClose={() => undefined} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy preflight command' }))
    expect((await screen.findByRole('status')).textContent).toBe('Command copied.')
    expect(screen.getByRole('button', { name: 'Preflight command copied' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Copy install command' }))
    expect((await screen.findByRole('status')).textContent).toBe('Copy failed. Select the command and copy it manually.')
    expect(screen.getByRole('button', { name: 'Install command copy failed' })).toBeTruthy()
  })
})
