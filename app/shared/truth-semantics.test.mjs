import { describe, expect, it } from 'vitest'
import {
  connectionStage,
  ratioMetric,
  runtimeMetrics,
  suiteCaseCoverage,
} from './truth-semantics.mjs'

const timestamp = '2026-07-25T12:00:00.000Z'

describe('truth semantics', () => {
  it('keeps unknown outcomes, discovery, and missing cost out of success and cost numerators', () => {
    const metrics = runtimeMetrics([
      { id: 'discovery', event: 'skill.discovered', runtime: 'codex', skillId: 'alpha', timestamp, costUsd: 99 },
      { id: 'success', event: 'skill.completed', runtime: 'codex', skillId: 'alpha', timestamp, outcome: 'success', costUsd: 0 },
      { id: 'unknown', event: 'skill.completed', runtime: 'codex', skillId: 'beta', timestamp, outcome: 'unknown' },
      { id: 'failed', event: 'skill.failed', runtime: 'codex', skillId: 'gamma', timestamp, outcome: 'failed', costUsd: 0.25 },
      { id: 'started', event: 'skill.started', runtime: 'codex', skillId: 'delta', timestamp },
    ])

    expect(metrics.terminalRuns).toBe(3)
    expect(metrics.successRate).toEqual(expect.objectContaining({ numerator: 1, denominator: 2, value: 50 }))
    expect(metrics.runtimeOutcomeCoverage).toEqual(expect.objectContaining({ numerator: 2, denominator: 3, value: 2 / 3 * 100 }))
    expect(metrics.reportedCostUsd).toBe(0.25)
    expect(metrics.costCoverage).toEqual(expect.objectContaining({ numerator: 2, denominator: 3 }))
    expect(metrics.observedAssets).toBe(4)
  })

  it('uses null ratios when the denominator is zero and separates suite coverage', () => {
    expect(ratioMetric(0, 0, 'Known outcomes')).toEqual({ numerator: 0, denominator: 0, value: null, label: 'Known outcomes' })
    expect(suiteCaseCoverage(3, 4)).toEqual(expect.objectContaining({ numerator: 3, denominator: 4, value: 75 }))
  })

  it.each([
    [{ configurationStatus: 'not-installed', detected: false, eventCount: 0 }, 'not-detected'],
    [{ configurationStatus: 'not-installed', detected: true, eventCount: 0 }, 'detected'],
    [{ configurationStatus: 'installed', eventCount: 0 }, 'awaiting-verification'],
    [{ configurationStatus: 'installed', eventCount: 1 }, 'awaiting-verification'],
    [{ configurationStatus: 'installed', eventCount: 1, verifiedEvidenceAt: timestamp }, 'verified'],
    [{ configurationStatus: 'broken', eventCount: 0 }, 'degraded'],
    [{ configurationStatus: 'error', eventCount: 0 }, 'degraded'],
    [{ configurationStatus: 'preview', eventCount: 0 }, 'preview-only'],
  ])('derives connection stage from authoritative facts', (input, expected) => {
    expect(connectionStage(input)).toBe(expected)
  })
})
