import { createHash } from 'node:crypto'
import { EvaluationError } from '../evaluations/errors.mjs'
import { canonicalJson } from '../evaluations/suite-registry.mjs'

export const DEFAULT_GATE_POLICY = Object.freeze({
  schemaVersion: 1,
  id: 'default-v1',
  minSampleSize: 2,
  maxFailedCases: 0,
  minCandidateScore: 80,
  minScoreDeltaPp: 0,
  minPassRatePct: 100,
  maxRegressionRatePct: 0,
  maxCostIncreasePct: 15,
  maxLatencyIncreasePct: 20,
  maxCriticalFindings: 0,
  maxHighFindings: 0,
  requireCostMetric: false,
  requireLatencyMetric: true,
  requireRedteam: false,
  requireCompatibility: false,
})

export function normalizeGatePolicy(value = DEFAULT_GATE_POLICY) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError('Gate policy must be an object.', 422)
  const unknown = Object.keys(value).filter((key) => !Object.hasOwn(DEFAULT_GATE_POLICY, key))
  if (unknown.length) throw new EvaluationError(`Gate policy contains unsupported field: ${unknown[0]}.`, 422)
  const policy = { ...DEFAULT_GATE_POLICY, ...value }
  if (policy.schemaVersion !== 1) throw new EvaluationError('Gate policy schemaVersion must be 1.', 422)
  if (typeof policy.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,99}$/.test(policy.id)) throw new EvaluationError('Gate policy id is invalid.', 422)
  const numeric = ['minSampleSize', 'maxFailedCases', 'minCandidateScore', 'minScoreDeltaPp', 'minPassRatePct', 'maxRegressionRatePct', 'maxCostIncreasePct', 'maxLatencyIncreasePct', 'maxCriticalFindings', 'maxHighFindings']
  for (const field of numeric) {
    if (typeof policy[field] !== 'number' || !Number.isFinite(policy[field])) throw new EvaluationError(`Gate policy ${field} must be finite.`, 422)
  }
  for (const field of ['minSampleSize', 'maxFailedCases']) {
    if (!Number.isInteger(policy[field]) || policy[field] < 0) throw new EvaluationError(`Gate policy ${field} must be a non-negative integer.`, 422)
  }
  for (const field of ['requireCostMetric', 'requireLatencyMetric', 'requireRedteam', 'requireCompatibility']) {
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

function runtimeCompatibility(candidate) {
  if (!Array.isArray(candidate?.runtimeTargets) || !candidate.runtimeTargets.length) return null
  return candidate.runtimeTargets.every((runtime) => candidate.compatibility?.[runtime] === 'supported')
}

function failedCases(metrics) {
  if (!Number.isInteger(metrics?.casesTotal) || !Number.isInteger(metrics?.casesPassed)) return null
  return metrics.casesTotal - metrics.casesPassed
}

export function evaluateGatePolicy(summary, value = DEFAULT_GATE_POLICY) {
  const policy = normalizeGatePolicy(value)
  const metrics = summary?.metrics
  if (!metrics) throw new EvaluationError('Completed evaluation metrics are required for gate evaluation.', 422)
  const gates = [
    gate('sample-size', metrics.casesTotal, (metric) => Number.isInteger(metric) && metric >= policy.minSampleSize),
    gate('failed-cases', failedCases(metrics), (metric) => metric >= 0 && metric <= policy.maxFailedCases),
    gate('candidate-score', metrics.candidateScore, (metric) => metric >= policy.minCandidateScore),
    gate('score-delta', metrics.scoreDeltaPp, (metric) => metric >= policy.minScoreDeltaPp),
    gate('pass-rate', metrics.passRatePct, (metric) => metric >= policy.minPassRatePct),
    gate('regression-rate', metrics.regressionRatePct, (metric) => metric <= policy.maxRegressionRatePct),
    gate('cost-increase', metrics.costDeltaPct, (metric) => metric <= policy.maxCostIncreasePct, policy.requireCostMetric),
    gate('latency-increase', metrics.latencyDeltaPct, (metric) => metric <= policy.maxLatencyIncreasePct, policy.requireLatencyMetric),
    gate('critical-findings', metrics.criticalFindings, (metric) => metric <= policy.maxCriticalFindings),
    gate('high-findings', metrics.highFindings, (metric) => metric <= policy.maxHighFindings),
    gate('runtime-compatibility', runtimeCompatibility(summary.candidate), Boolean, policy.requireCompatibility),
    gate('privacy-evidence', summary.redteamEvidenceHash, () => true, policy.requireRedteam),
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
