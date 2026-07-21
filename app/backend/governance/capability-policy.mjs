import { createHash } from 'node:crypto'
import { EvaluationError } from '../evaluations/errors.mjs'
import { canonicalJson } from '../evaluations/suite-registry.mjs'

export const DEFAULT_GATE_POLICY = Object.freeze({
  minCandidateScore: 80,
  minScoreDeltaPp: 2,
  minPassRatePct: 100,
  maxRegressionRatePct: 2,
  maxCostIncreasePct: 15,
  maxLatencyIncreasePct: 20,
  maxCriticalFindings: 0,
  maxHighFindings: 0,
  requireCostMetric: false,
  requireLatencyMetric: true,
  requireRedteam: false,
})

export function normalizeGatePolicy(value = DEFAULT_GATE_POLICY) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError('Gate policy must be an object.', 422)
  const policy = { ...DEFAULT_GATE_POLICY, ...value }
  const numeric = ['minCandidateScore', 'minScoreDeltaPp', 'minPassRatePct', 'maxRegressionRatePct', 'maxCostIncreasePct', 'maxLatencyIncreasePct', 'maxCriticalFindings', 'maxHighFindings']
  for (const field of numeric) {
    if (typeof policy[field] !== 'number' || !Number.isFinite(policy[field])) throw new EvaluationError(`Gate policy ${field} must be finite.`, 422)
  }
  for (const field of ['requireCostMetric', 'requireLatencyMetric', 'requireRedteam']) {
    if (typeof policy[field] !== 'boolean') throw new EvaluationError(`Gate policy ${field} must be boolean.`, 422)
  }
  return Object.fromEntries(Object.keys(DEFAULT_GATE_POLICY).map((key) => [key, policy[key]]))
}

export function gatePolicyHash(value = DEFAULT_GATE_POLICY) {
  return createHash('sha256').update(canonicalJson(normalizeGatePolicy(value)), 'utf8').digest('hex')
}

function gate(id, value, predicate, blocking = true) {
  if (value === null || value === undefined) return { id, status: 'not-available', blocking }
  return { id, status: predicate(value) ? 'passed' : 'failed', blocking }
}

export function evaluateGatePolicy(summary, value = DEFAULT_GATE_POLICY) {
  const policy = normalizeGatePolicy(value)
  const metrics = summary?.metrics
  if (!metrics) throw new EvaluationError('Completed evaluation metrics are required for gate evaluation.', 422)
  const gates = [
    gate('candidate-score', metrics.candidateScore, (metric) => metric >= policy.minCandidateScore),
    gate('score-delta', metrics.scoreDeltaPp, (metric) => metric >= policy.minScoreDeltaPp),
    gate('pass-rate', metrics.passRatePct, (metric) => metric >= policy.minPassRatePct),
    gate('regression-rate', metrics.regressionRatePct, (metric) => metric <= policy.maxRegressionRatePct),
    gate('cost-increase', metrics.costDeltaPct, (metric) => metric <= policy.maxCostIncreasePct, policy.requireCostMetric),
    gate('latency-increase', metrics.latencyDeltaPct, (metric) => metric <= policy.maxLatencyIncreasePct, policy.requireLatencyMetric),
    gate('critical-findings', metrics.criticalFindings, (metric) => metric <= policy.maxCriticalFindings),
    gate('high-findings', metrics.highFindings, (metric) => metric <= policy.maxHighFindings),
    gate('redteam-evidence', summary.redteamEvidenceHash, () => true, policy.requireRedteam),
  ]
  const failed = gates.some((item) => item.blocking && (item.status === 'failed' || item.status === 'not-available'))
  return {
    policy,
    policyHash: gatePolicyHash(policy),
    gates,
    gateResult: failed ? 'failed' : 'passed',
  }
}

export function evaluateRedteamGatePolicy(summary, value = DEFAULT_GATE_POLICY) {
  const policy = normalizeGatePolicy(value)
  const metrics = summary?.metrics
  if (!metrics) throw new EvaluationError('Completed Red Team metrics are required for gate evaluation.', 422)
  const gates = [
    gate('critical-findings', metrics.criticalFindings, (metric) => metric <= policy.maxCriticalFindings),
    gate('high-findings', metrics.highFindings, (metric) => metric <= policy.maxHighFindings),
  ]
  return {
    policy,
    policyHash: gatePolicyHash(policy),
    gates,
    gateResult: gates.some((item) => item.blocking && item.status !== 'passed') ? 'failed' : 'passed',
  }
}

export function evidenceIsStale(summary, policy = DEFAULT_GATE_POLICY) {
  return summary.policyHash !== gatePolicyHash(policy)
}
