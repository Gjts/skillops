const TERMINAL_EVENTS = new Set(['skill.completed', 'skill.failed'])
const QUALIFYING_EVENTS = new Set(['skill.started', 'skill.completed', 'skill.failed'])

export function ratioMetric(numerator, denominator, label) {
  return { numerator, denominator, value: denominator ? numerator / denominator * 100 : null, label }
}

export function isQualifyingLifecycle(event) {
  return Boolean(event?.skillId) && QUALIFYING_EVENTS.has(event.event) && !Number.isNaN(Date.parse(event.timestamp))
}

export function runtimeMetrics(events) {
  const terminal = events.filter((event) => Boolean(event?.skillId) && TERMINAL_EVENTS.has(event.event))
  const known = terminal.filter((event) => event.outcome === 'success' || event.outcome === 'failed')
  const successes = known.filter((event) => event.outcome === 'success').length
  const costed = terminal.filter((event) => typeof event.costUsd === 'number' && Number.isFinite(event.costUsd))
  const observedAssets = new Set(events.filter(isQualifyingLifecycle).map((event) => `${event.runtime}:${event.kind || 'skill'}:${event.skillId}`)).size
  return {
    terminalRuns: terminal.length,
    knownOutcomes: known.length,
    successRate: ratioMetric(successes, known.length, 'Known outcomes'),
    runtimeOutcomeCoverage: ratioMetric(known.length, terminal.length, 'Runtime outcome coverage'),
    reportedCostUsd: costed.length ? costed.reduce((total, event) => total + event.costUsd, 0) : null,
    costCoverage: ratioMetric(costed.length, terminal.length, 'Cost coverage'),
    observedAssets,
  }
}

export function suiteCaseCoverage(evaluatedCases, eligibleCases) {
  return ratioMetric(evaluatedCases, eligibleCases, 'Suite case coverage')
}

export function connectionStage({ configurationStatus, detected = false, eventCount = 0, verifiedEvidenceAt }) {
  if (configurationStatus === 'preview') return 'preview-only'
  if (configurationStatus === 'broken' || configurationStatus === 'error') return 'degraded'
  if (configurationStatus !== 'installed') return detected ? 'detected' : 'not-detected'
  if (verifiedEvidenceAt) return 'verified'
  return eventCount ? 'awaiting-verification' : 'installed'
}

export function evidenceState({ definitionIssue = false, lastObservedAt, openStartAt, now = Date.now(), recentWindowMs = 15 * 60_000, telemetryGapMs = recentWindowMs }) {
  if (definitionIssue) return 'definition-issue'
  const lastObservedMs = Date.parse(lastObservedAt || '')
  if (Number.isFinite(lastObservedMs) && now - lastObservedMs <= recentWindowMs) return 'observed-recently'
  const openStartMs = Date.parse(openStartAt || '')
  if (Number.isFinite(openStartMs) && now - openStartMs > telemetryGapMs) return 'telemetry-gap'
  return Number.isFinite(lastObservedMs) ? 'idle' : 'unverified'
}
