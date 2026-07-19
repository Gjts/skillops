import { describe, expect, it } from 'vitest'
import { byDay, bySkill, filterEvents, summarize } from './analytics'
import type { SkillEvent } from '../types'

function event(overrides: Partial<SkillEvent>): SkillEvent {
  return {
    id: crypto.randomUUID(),
    event: 'skill.completed',
    skillId: 'historical-skill',
    skillVersion: '1.0.0',
    runtime: 'codex',
    timestamp: '2020-01-31T12:00:00.000Z',
    ...overrides,
  }
}

describe('historical event analytics', () => {
  it('uses the real current period for filters while allowing deterministic chart anchors', () => {
    const events = [
      event({ timestamp: '2020-01-29T12:00:00.000Z' }),
      event({ timestamp: '2020-01-31T12:00:00.000Z', outcome: 'success' }),
    ]

    expect(filterEvents(events, 'all', 7)).toHaveLength(0)
    const buckets = byDay(events, 7, new Date('2020-01-31T12:00:00.000Z').getTime())
    expect(buckets.at(-1)?.key).toBe('2020-01-31')
    expect(buckets.at(-1)?.success).toBe(1)
  })

  it('keeps empty datasets anchored to a valid current-date bucket', () => {
    const buckets = byDay([], 7)
    expect(buckets).toHaveLength(7)
    expect(Number.isNaN(new Date(buckets.at(-1)!.key).getTime())).toBe(false)
  })
})

describe('real event metadata', () => {
  it('does not replace local versions or runtimes with demo registry values', () => {
    const metrics = bySkill([
      event({ skillId: 'frontend-builder', skillVersion: '9.4.0', runtime: 'codex', timestamp: new Date().toISOString() }),
    ])
    expect(metrics[0]).toMatchObject({ skillId: 'frontend-builder', version: '9.4.0', runtime: 'codex' })
  })

  it('keeps the same Skill in different runtimes as separate activity rows', () => {
    const metrics = bySkill([
      event({ id: 'codex-run', skillId: 'shared-skill', runtime: 'codex', outcome: 'success' }),
      event({ id: 'claude-run', skillId: 'shared-skill', runtime: 'claude-code', outcome: 'success' }),
    ])

    expect(metrics).toHaveLength(2)
    expect(metrics.map((metric) => `${metric.runtime}:${metric.skillId}`)).toEqual([
      'claude-code:shared-skill',
      'codex:shared-skill',
    ])
  })
})

describe('lifecycle-only outcomes', () => {
  it('treats a completion without an explicit outcome as observed, never successful', () => {
    const events = [event({ outcome: undefined })]

    expect(summarize(events)).toMatchObject({ successRate: null, lifecycleOnly: true })
    expect(bySkill(events)[0]).toMatchObject({ successes: 0, knownOutcomes: 0 })
    expect(byDay(events, 7, new Date('2020-01-31T12:00:00.000Z').getTime()).at(-1)?.observed).toBe(1)
  })

  it('does not turn Claude lifecycle failures into a misleading 0% success rate', () => {
    const events = [
      event({ runtime: 'claude-code', outcome: 'unknown' }),
      event({ runtime: 'claude-code', event: 'skill.failed', outcome: 'failed' }),
    ]

    expect(summarize(events)).toMatchObject({ successRate: 0, lifecycleOnly: false, evaluatedRuns: 1, outcomeCoverage: 50 })
    expect(bySkill(events)[0]).toMatchObject({ successRate: 0, lifecycleOnly: false, knownOutcomes: 1 })
    expect(byDay(events, 7, new Date('2020-01-31T12:00:00.000Z').getTime()).at(-1)?.observed).toBe(1)
  })

  it('still computes evaluated success rates when a known completion exists', () => {
    const events = [
      event({ outcome: 'success' }),
      event({ event: 'skill.failed', outcome: 'failed' }),
    ]
    expect(summarize(events)).toMatchObject({ successRate: 50, lifecycleOnly: false, evaluatedRuns: 2, outcomeCoverage: 100 })
  })
})
