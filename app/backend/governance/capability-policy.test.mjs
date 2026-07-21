import { describe, expect, it } from 'vitest'
import { DEFAULT_GATE_POLICY, evaluateGatePolicy, evaluateRedteamGatePolicy, evidenceIsStale, gatePolicyHash } from './capability-policy.mjs'

const metrics = {
  baselineScore: 78, candidateScore: 80, scoreDeltaPp: 2, casesPassed: 100, casesTotal: 100,
  passRatePct: 100, regressionRatePct: 2, baselineTokens: null, candidateTokens: null,
  baselineCostUsd: null, candidateCostUsd: null, costDeltaPct: null,
  baselineP95LatencyMs: 100, candidateP95LatencyMs: 120, latencyDeltaPct: 20,
  criticalFindings: 0, highFindings: 0,
}

describe('capability gate policy', () => {
  it('passes exact boundary values and treats optional missing cost as not available', () => {
    const result = evaluateGatePolicy({ metrics, redteamEvidenceHash: null })
    expect(result.gateResult).toBe('passed')
    expect(result.gates.find((gate) => gate.id === 'cost-increase')).toEqual({
      id: 'cost-increase', status: 'not-available', blocking: false,
    })
  })

  it('fails a missing required metric and can require separate red-team evidence', () => {
    const missingLatency = evaluateGatePolicy({ metrics: { ...metrics, latencyDeltaPct: null } })
    expect(missingLatency.gateResult).toBe('failed')
    expect(missingLatency.gates.find((gate) => gate.id === 'latency-increase').status).toBe('not-available')
    const redteam = evaluateGatePolicy({ metrics, redteamEvidenceHash: null }, { ...DEFAULT_GATE_POLICY, requireRedteam: true })
    expect(redteam.gateResult).toBe('failed')
    expect(redteam.gates.at(-1)).toEqual({ id: 'redteam-evidence', status: 'not-available', blocking: true })
  })

  it('fails values immediately outside every threshold', () => {
    const result = evaluateGatePolicy({ metrics: {
      ...metrics, candidateScore: 79.999, scoreDeltaPp: 1.999, passRatePct: 99.999,
      regressionRatePct: 2.001, costDeltaPct: 15.001, latencyDeltaPct: 20.001,
      criticalFindings: 1, highFindings: 1,
    } })
    expect(result.gates.filter((gate) => gate.status === 'failed').map((gate) => gate.id)).toEqual([
      'candidate-score', 'score-delta', 'pass-rate', 'regression-rate', 'cost-increase',
      'latency-increase', 'critical-findings', 'high-findings',
    ])
    expect(result.gateResult).toBe('failed')
  })

  it('hashes normalized policies and marks evidence stale when policy changes', () => {
    const hash = gatePolicyHash(DEFAULT_GATE_POLICY)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(evidenceIsStale({ policyHash: hash })).toBe(false)
    expect(evidenceIsStale({ policyHash: hash }, { ...DEFAULT_GATE_POLICY, minCandidateScore: 81 })).toBe(true)
  })

  it('evaluates Red Team findings independently from quality score gates', () => {
    const passed = evaluateRedteamGatePolicy({ metrics: { ...metrics, candidateScore: null, criticalFindings: 0, highFindings: 0 } })
    expect(passed.gateResult).toBe('passed')
    expect(passed.gates.map((gate) => gate.id)).toEqual(['critical-findings', 'high-findings'])
    expect(evaluateRedteamGatePolicy({ metrics: { ...metrics, criticalFindings: 1, highFindings: 0 } }).gateResult).toBe('failed')
  })
})
