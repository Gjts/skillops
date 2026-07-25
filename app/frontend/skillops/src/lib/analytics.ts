// @ts-expect-error Plain JavaScript truth contract is shared with the backend.
import { runtimeMetrics } from '../../../../shared/truth-semantics.mjs'
import type { Runtime, SkillEvent, SkillMetric } from '../types'

export const runtimeLabel: Record<Runtime, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
}

function localDayKey(value: string | number | Date) {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function terminalRuns(events: SkillEvent[]) {
  return events.filter((event) =>
    Boolean(event.skillId) && (event.event === 'skill.completed' || event.event === 'skill.failed'))
}

export function filterEvents(events: SkillEvent[], runtime: Runtime | 'all', days: number, now = Date.now()) {
  const cutoff = now - days * 86_400_000
  return events.filter((event) => {
    const matchesRuntime = runtime === 'all' || event.runtime === runtime
    return matchesRuntime && new Date(event.timestamp).getTime() >= cutoff
  })
}

function outcomeMetrics(runs: SkillEvent[]) {
  const metrics = runtimeMetrics(runs)
  return {
    successes: metrics.successRate.numerator,
    knownOutcomes: metrics.knownOutcomes,
    reportedOutcomeRuns: metrics.knownOutcomes,
    outcomeCoverage: metrics.runtimeOutcomeCoverage.value ?? 0,
    lifecycleOnly: runs.length > 0 && metrics.knownOutcomes === 0,
    successRate: metrics.successRate.value,
  }
}

export function summarize(events: SkillEvent[]) {
  const metrics = runtimeMetrics(events)
  return {
    runs: metrics.terminalRuns,
    successRate: metrics.successRate.value,
    lifecycleOnly: metrics.terminalRuns > 0 && metrics.knownOutcomes === 0,
    reportedOutcomeRuns: metrics.knownOutcomes,
    outcomeCoverage: metrics.runtimeOutcomeCoverage.value ?? 0,
    activeSkills: metrics.observedAssets,
    cost: metrics.reportedCostUsd ?? 0,
    costReportedRuns: metrics.costCoverage.numerator,
  }
}

export function byDay(events: SkillEvent[], days: number, now = Date.now()) {
  const runs = terminalRuns(events)
  const latest = new Date(now)
  const buckets = Array.from({ length: days }, (_, index) => {
    const date = new Date(latest)
    date.setDate(date.getDate() - (days - index - 1))
    return {
      key: localDayKey(date),
      label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      success: 0,
      failed: 0,
      observed: 0,
    }
  })
  const lookup = new Map(buckets.map((bucket) => [bucket.key, bucket]))
  runs.forEach((event) => {
    const bucket = lookup.get(localDayKey(event.timestamp))
    if (!bucket) return
    if (event.event === 'skill.failed') bucket.failed += 1
    else if (event.outcome !== 'success') bucket.observed += 1
    else bucket.success += 1
  })
  return buckets
}

export function byRuntime(events: SkillEvent[]) {
  const runs = terminalRuns(events)
  return (Object.keys(runtimeLabel) as Runtime[]).map((runtime) => ({
    runtime,
    label: runtimeLabel[runtime],
    runs: runs.filter((event) => event.runtime === runtime).length,
  }))
}

export function bySkill(events: SkillEvent[], days = 7): SkillMetric[] {
  const runs = terminalRuns(events)
  const grouped = new Map<string, SkillEvent[]>()
  runs.forEach((event) => {
    if (!event.skillId) return
    const key = `${event.runtime}:${event.skillId}`
    grouped.set(key, [...(grouped.get(key) ?? []), event])
  })
  return [...grouped.entries()].map(([key, skillRuns]) => {
    const outcomes = outcomeMetrics(skillRuns)
    const daily = byDay(skillRuns, days)
    const latestRun = skillRuns.reduce((latest, event) =>
      new Date(event.timestamp).getTime() > new Date(latest.timestamp).getTime() ? event : latest)
    let cost = 0
    let costReportedRuns = 0
    skillRuns.forEach((event) => {
      if (typeof event.costUsd !== 'number' || !Number.isFinite(event.costUsd)) return
      cost += event.costUsd
      costReportedRuns += 1
    })
    return {
      key,
      skillId: latestRun.skillId!,
      version: latestRun.skillVersion ?? 'unversioned',
      runtime: latestRun.runtime,
      runs: skillRuns.length,
      successes: outcomes.successes,
      knownOutcomes: outcomes.knownOutcomes,
      successRate: outcomes.successRate,
      lifecycleOnly: outcomes.lifecycleOnly,
      cost,
      costReportedRuns,
      avgDuration: skillRuns.reduce((sum, event) => sum + (event.durationMs ?? 0), 0) / skillRuns.length,
      trend: daily.map((day) => day.success + day.failed + day.observed),
      latestRunId: latestRun.id,
      latestRunAt: latestRun.timestamp,
    }
  }).sort((left, right) => right.runs - left.runs || left.skillId.localeCompare(right.skillId) || left.runtime.localeCompare(right.runtime))
}

export function recentRuns(events: SkillEvent[], limit = 8) {
  return terminalRuns(events)
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
    .slice(0, limit)
}

export function formatDuration(milliseconds = 0) {
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
