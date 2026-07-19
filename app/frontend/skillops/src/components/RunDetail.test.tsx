// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

  it('shows evidence and closes with Escape', () => {
    let closed = false
    render(<RunDetail run={events[3]} events={events} onClose={() => { closed = true }} />)

    expect(screen.getByRole('heading', { name: 'frontend-builder' })).toBeTruthy()
    expect(screen.getByText('3 events')).toBeTruthy()
    expect(screen.getByText('$0.0400')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close run detail' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(closed).toBe(true)
  })
})
