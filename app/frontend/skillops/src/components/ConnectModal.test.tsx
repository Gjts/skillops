// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectModal } from './ConnectModal'

const disconnected = [
  { runtime: 'codex' as const, status: 'not-installed' as const, eventCount: 0 },
  { runtime: 'claude-code' as const, status: 'not-installed' as const, eventCount: 0 },
  { runtime: 'cursor' as const, status: 'preview' as const, eventCount: 0 },
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

  it('moves focus into the dialog and exposes an honest three-step verification flow', () => {
    render(<ConnectModal connections={disconnected} onRefresh={async () => disconnected} onClose={() => undefined} />)

    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Codex/ }))
    expect(screen.getByText('1 · Install adapter')).toBeTruthy()
    expect(screen.getByText('2 · Verify installation')).toBeTruthy()
    expect(screen.getByText('3 · Confirm live activity')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Finish setup' })).toHaveProperty('disabled', true)
  })

  it('shows inspected installation and live event evidence', () => {
    const connected = [
      { runtime: 'codex' as const, status: 'installed' as const, eventCount: 2, lastEventAt: '2026-07-19T12:00:00.000Z' },
      ...disconnected.slice(1),
    ]
    render(<ConnectModal connections={connected} onRefresh={async () => connected} onClose={() => undefined} />)

    expect(screen.getByText('Adapter installed')).toBeTruthy()
    expect(screen.getByText('2 runtime events recorded')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Finish setup' })).toHaveProperty('disabled', false)
  })

  it('announces successful and failed clipboard writes', async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<ConnectModal connections={disconnected} onRefresh={async () => disconnected} onClose={() => undefined} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }))
    expect((await screen.findByRole('status')).textContent).toBe('Command copied.')
    expect(screen.getByRole('button', { name: 'Command copied' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Command copied' }))
    expect((await screen.findByRole('status')).textContent).toBe('Copy failed. Select the command and copy it manually.')
    expect(screen.getByRole('button', { name: 'Copy failed' })).toBeTruthy()
  })
})
