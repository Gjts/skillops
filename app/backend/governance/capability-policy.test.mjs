import { describe, expect, it } from 'vitest'
import { DEFAULT_GATE_POLICY, evaluateGatePolicy, evaluateRedteamGatePolicy, evidenceIsStale, gatePolicyHash, normalizeGatePolicy } from './capability-policy.mjs'

const metrics = {
  baselineScore: 80, candidateScore: 80, scoreDeltaPp: 0, casesPassed: 100, casesTotal: 100,
  passRatePct: 100, regressionRatePct: 0, baselineTokens: null, candidateTokens: null,
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

  it('accepts first versions and unchanged quality at zero score delta', () => {
    const sameVersion = evaluateGatePolicy({
      metrics: { ...metrics, baselineScore: 80, scoreDeltaPp: 0 },
      baseline: { sourceRef: 'git:same' },
      candidate: { sourceRef: 'git:same' },
    })
    expect(sameVersion.gateResult).toBe('passed')
    expect(sameVersion.gates.find((gate) => gate.id === 'score-delta')).toEqual({
      id: 'score-delta', status: 'passed', blocking: true,
    })
    const distinctVersion = evaluateGatePolicy({
      metrics: { ...metrics, baselineScore: 80, scoreDeltaPp: 0 },
      baseline: { sourceRef: 'git:base' },
      candidate: { sourceRef: 'git:candidate' },
    })
    expect(distinctVersion.gateResult).toBe('passed')
  })

  it('fails a missing required metric and can require separate red-team evidence', () => {
    const missingLatency = evaluateGatePolicy({ metrics: { ...metrics, latencyDeltaPct: null } })
    expect(missingLatency.gateResult).toBe('failed')
    expect(missingLatency.gates.find((gate) => gate.id === 'latency-increase').status).toBe('not-available')
    const redteam = evaluateGatePolicy({ metrics, redteamEvidenceHash: null }, { ...DEFAULT_GATE_POLICY, requireRedteam: true })
    expect(redteam.gateResult).toBe('failed')
    expect(redteam.gates.at(-1)).toEqual({ id: 'privacy-evidence', status: 'not-available', blocking: true })
  })

  it('rejects undersized samples and any failed case by default', () => {
    const result = evaluateGatePolicy({ metrics: { ...metrics, casesPassed: 0, casesTotal: 1 } })
    expect(result.gateResult).toBe('failed')
    expect(result.gates.slice(0, 2)).toEqual([
      { id: 'sample-size', status: 'failed', blocking: true },
      { id: 'failed-cases', status: 'failed', blocking: true },
    ])
  })

  it('fails values immediately outside every threshold', () => {
    const result = evaluateGatePolicy({ metrics: {
      ...metrics, casesPassed: 0, casesTotal: 1,
      candidateScore: 79.999, scoreDeltaPp: -0.001, passRatePct: 99.999,
      regressionRatePct: 0.001, costDeltaPct: 15.001, latencyDeltaPct: 20.001,
      criticalFindings: 1, highFindings: 1,
    } })
    expect(result.gates.filter((gate) => gate.status === 'failed').map((gate) => gate.id)).toEqual([
      'sample-size', 'failed-cases', 'candidate-score', 'score-delta', 'pass-rate',
      'regression-rate', 'cost-increase', 'latency-increase', 'critical-findings',
      'high-findings',
    ])
    expect(result.gateResult).toBe('failed')
  })

  it('hashes normalized policies and marks evidence stale when policy changes', () => {
    const hash = gatePolicyHash(DEFAULT_GATE_POLICY)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(evidenceIsStale({ policyHash: hash })).toBe(false)
    expect(evidenceIsStale({ policyHash: hash }, { ...DEFAULT_GATE_POLICY, minCandidateScore: 81 })).toBe(true)
  })

  it('validates the versioned Policy-as-Code schema and optional Runtime compatibility gate', () => {
    expect(normalizeGatePolicy()).toEqual(expect.objectContaining({ schemaVersion: 1, id: 'default-v1', requireCompatibility: false }))
    expect(() => normalizeGatePolicy({ ...DEFAULT_GATE_POLICY, unknownGate: true })).toThrow('unsupported field')
    const compatible = evaluateGatePolicy({
      metrics,
      candidate: { runtimeTargets: ['codex'], compatibility: { codex: 'supported' } },
    }, { ...DEFAULT_GATE_POLICY, requireCompatibility: true })
    expect(compatible.gates.find((gate) => gate.id === 'runtime-compatibility')).toEqual({
      id: 'runtime-compatibility', status: 'passed', blocking: true,
    })
    const incompatible = evaluateGatePolicy({
      metrics,
      candidate: { runtimeTargets: ['codex', 'claude-code'], compatibility: { codex: 'supported', 'claude-code': 'preview' } },
    }, { ...DEFAULT_GATE_POLICY, requireCompatibility: true })
    expect(incompatible.gateResult).toBe('failed')
  })

  it('evaluates Red Team findings independently from quality score gates', () => {
    const passed = evaluateRedteamGatePolicy({ metrics: { ...metrics, candidateScore: null, criticalFindings: 0, highFindings: 0 } })
    expect(passed.gateResult).toBe('passed')
    expect(passed.gates.map((gate) => gate.id)).toEqual(['critical-findings', 'high-findings'])
    expect(evaluateRedteamGatePolicy({ metrics: { ...metrics, criticalFindings: 1, highFindings: 0 } }).gateResult).toBe('failed')
  })
})
