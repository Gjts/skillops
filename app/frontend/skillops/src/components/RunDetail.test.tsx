// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillEvent } from '../types'
import { correlatedRunEvents, RunDetail } from './RunDetail'

const events: SkillEvent[] = [
  { id: 'session', event: 'session.started', runtime: 'codex', timestamp: '2026-07-19T10:00:00.000Z', sessionId: 's1', project: 'console' },
  { id: 'started', event: 'skill.started', runtime: 'codex', timestamp: '2026-07-19T10:00:01.000Z', sessionId: 's1', skillId: 'frontend-builder', skillVersion: '2.0.0' },
  { id: 'other', event: 'skill.completed', runtime: 'claude-code', timestamp: '2026-07-19T10:00:02.000Z', sessionId: 's2', skillId: 'other' },
  { id: 'run-1', event: 'skill.completed', runtime: 'codex', timestamp: '2026-07-19T10:00:03.000Z', sessionId: 's1', skillId: 'frontend-builder', skillVersion: '2.0.0', outcome: 'success', durationMs: 2000, costUsd: 0.04, tokens: 500, project: 'console' },
]

afterEach(cleanup)

describe('run detail', () => {
  it('correlates and orders events from the selected session', () => {
    expect(correlatedRunEvents(events[3], events).map((event) => event.id)).toEqual(['session', 'started', 'run-1'])
  })

  it('matches session and turn scope without leaking the same turn across sessions', () => {
    const run = { ...events[3], id: 'turn-run', turnId: 'turn-1' }
    const turnOnlyRun = { ...run, id: 'turn-only-run', sessionId: undefined }
    const correlated: SkillEvent[] = [
      { ...events[0], id: 'session-scope' },
      { ...events[1], id: 'same-turn', turnId: 'turn-1' },
      { ...events[1], id: 'other-turn', turnId: 'turn-2' },
      { ...events[1], id: 'other-session', sessionId: 's2', turnId: 'turn-1' },
      { ...events[1], id: 'other-runtime', runtime: 'claude-code', turnId: 'turn-1' },
      run,
    ]
    expect(correlatedRunEvents(run, correlated).map((event) => event.id)).toEqual(['session-scope', 'same-turn', 'turn-run'])
    expect(correlatedRunEvents(turnOnlyRun, [
      { ...events[1], id: 'turn-only-event', sessionId: undefined, turnId: 'turn-1' },
      { ...events[1], id: 'turn-with-session', turnId: 'turn-1' },
      { ...events[1], id: 'turn-other-runtime', runtime: 'claude-code', sessionId: undefined, turnId: 'turn-1' },
      turnOnlyRun,
    ]).map((event) => event.id)).toEqual(['turn-only-event', 'turn-only-run'])
  })

  it('shows evidence and closes with Escape', () => {
    let closed = false
    render(<RunDetail run={events[3]} events={events} onClose={() => { closed = true }} />)

    expect(screen.getByRole('heading', { name: 'frontend-builder' })).toBeTruthy()
    expect(screen.getByText('3 events')).toBeTruthy()
    expect(screen.getByText('$0.04')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close run detail' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(closed).toBe(true)
  })

  it('labels a bounded timeline with its loaded and total event counts', () => {
    render(<RunDetail run={events[3]} events={events} totalEvents={4} truncated onClose={() => undefined} />)
    expect(screen.getByText('3 / 4 events')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Showing 3 of 4 correlated events.')
  })

  it('distinguishes a missing cost from an explicitly reported zero', () => {
    const missing = { ...events[3], id: 'missing-cost', costUsd: undefined }
    const { rerender } = render(<RunDetail run={missing} events={[missing]} onClose={() => undefined} />)
    expect(within(screen.getByText('Cost').closest('div') as HTMLElement).getByText('Not reported')).toBeTruthy()

    const zero = { ...events[3], id: 'zero-cost', costUsd: 0 }
    rerender(<RunDetail run={zero} events={[zero]} onClose={() => undefined} />)
    expect(screen.getByText('$0.00')).toBeTruthy()
  })
})
