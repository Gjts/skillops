import { describe, expect, it } from 'vitest'
import { normalizePromptfooEvaluation } from './evaluation-normalizer.mjs'
import { DEFAULT_GATE_POLICY, evaluateGatePolicy } from '../governance/capability-policy.mjs'

const artifact = (id, hash) => ({
  kind: 'skill', artifactId: id, version: '1.0.0', source: 'github', sourceRef: `github:https://github.com/acme/${id}/blob/${hash.repeat(40)}/SKILL.md#SKILL.md`, contentHash: hash.repeat(64), gitCommit: hash.repeat(40),
})

const suite = {
  id: 'normalizer-suite',
  version: '1.0.0',
  repeats: 1,
  suiteHash: 'c'.repeat(64),
  datasetHash: 'd'.repeat(64),
  cases: [
    { id: 'case-a', weight: 1, assertions: [{ type: 'contains', label: 'required', blocking: true }] },
    { id: 'case-b', weight: 1, assertions: [{ type: 'contains', label: 'required', blocking: true }] },
  ],
}

function rawResult(caseId, provider, { pass, tokens = 5, cost, latency = 10, score = pass ? 1 : 0 }) {
  return {
    provider: { id: `skillops:${provider}` },
    vars: { __skillopsCaseId: caseId, __skillopsRepeat: 0 },
    score,
    latencyMs: latency,
    cost: cost ?? 0,
    response: {
      tokenUsage: tokens === null ? undefined : { total: tokens },
      metadata: { skillopsTokenUsageReported: tokens !== null, skillopsCostReported: cost !== undefined },
    },
    gradingResult: { componentResults: [{ pass, score: pass ? 1 : 0 }] },
  }
}

function context() {
  return {
    runId: 'run-normalizer', suite,
    baseline: artifact('baseline', 'a'), candidate: artifact('candidate', 'b'),
    provider: { id: 'openai', model: 'gpt-test' }, engineVersion: '0.121.19', requestedBy: 'qa',
  }
}

describe('Promptfoo result normalizer', () => {
  it('computes pass, regression, token, null-cost, and P95 metrics', () => {
    const result = normalizePromptfooEvaluation({ results: [
      rawResult('case-a', 'baseline', { pass: true, latency: 10, tokens: 2 }),
      rawResult('case-a', 'candidate', { pass: false, latency: 30, tokens: 3 }),
      rawResult('case-b', 'baseline', { pass: true, latency: 20, tokens: 4 }),
      rawResult('case-b', 'candidate', { pass: true, latency: 40, tokens: 5 }),
    ] }, context())
    expect(result.summary.metrics).toEqual(expect.objectContaining({
      baselineScore: 100,
      candidateScore: 50,
      scoreDeltaPp: -50,
      casesPassed: 1,
      casesTotal: 2,
      passRatePct: 50,
      regressionRatePct: 50,
      baselineTokens: 6,
      candidateTokens: 8,
      baselineCostUsd: null,
      candidateCostUsd: null,
      costDeltaPct: null,
      baselineP95LatencyMs: 20,
      candidateP95LatencyMs: 40,
      latencyDeltaPct: 100,
    }))
  })

  it('counts failed blocking assertions while tolerating failed nonblocking assertions', () => {
    const mixedSuite = {
      ...suite,
      cases: [
        suite.cases[0],
        { ...suite.cases[1], assertions: [{ ...suite.cases[1].assertions[0], blocking: false }] },
      ],
    }
    const normalized = normalizePromptfooEvaluation({ results: [
      rawResult('case-a', 'baseline', { pass: true }),
      rawResult('case-a', 'candidate', { pass: false }),
      rawResult('case-b', 'baseline', { pass: true }),
      rawResult('case-b', 'candidate', { pass: false }),
    ] }, { ...context(), suite: mixedSuite })
    expect(normalized.summary.metrics).toEqual(expect.objectContaining({ casesPassed: 1, criticalFindings: 1 }))
    expect(normalized.cases[1].candidate).toEqual(expect.objectContaining({
      pass: true,
      assertions: [expect.objectContaining({ blocking: false, pass: false })],
    }))
    const tolerantPolicy = {
      ...DEFAULT_GATE_POLICY,
      maxFailedCases: 1,
      minCandidateScore: 0,
      minScoreDeltaPp: -100,
      minPassRatePct: 0,
      maxRegressionRatePct: 100,
    }
    expect(evaluateGatePolicy(normalized.summary, tolerantPolicy).gates
      .filter((gate) => gate.status === 'failed').map((gate) => gate.id)).toEqual(['critical-findings'])

    const nonblockingOnly = normalizePromptfooEvaluation({ results: [
      rawResult('case-a', 'baseline', { pass: true }),
      rawResult('case-a', 'candidate', { pass: true }),
      rawResult('case-b', 'baseline', { pass: true }),
      rawResult('case-b', 'candidate', { pass: false }),
    ] }, { ...context(), suite: mixedSuite })
    expect(nonblockingOnly.summary.metrics.criticalFindings).toBe(0)
    expect(evaluateGatePolicy(nonblockingOnly.summary, tolerantPolicy).gateResult).toBe('passed')
  })

  it('uses null when any provider metric is missing', () => {
    const raw = [
      rawResult('case-a', 'baseline', { pass: true, tokens: null }),
      rawResult('case-a', 'candidate', { pass: true }),
      rawResult('case-b', 'baseline', { pass: true }),
      rawResult('case-b', 'candidate', { pass: true }),
    ]
    expect(normalizePromptfooEvaluation({ results: raw }, context()).summary.metrics.baselineTokens).toBeNull()
  })

  it('rejects NaN, duplicate cases, and mismatched baseline/candidate cases', () => {
    const valid = rawResult('case-a', 'baseline', { pass: true })
    expect(() => normalizePromptfooEvaluation({ results: [{ ...valid, score: Number.NaN }] }, context())).toThrow('Case score')
    expect(() => normalizePromptfooEvaluation({ results: [valid, valid] }, context())).toThrow('duplicate case')
    expect(() => normalizePromptfooEvaluation({ results: [
      valid,
      rawResult('case-a', 'candidate', { pass: true }),
    ] }, context())).toThrow('do not match')
  })
})
