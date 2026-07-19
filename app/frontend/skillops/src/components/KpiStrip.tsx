import { Sparkline } from './Charts'

interface KpiStripProps {
  runs: number
  successRate: number | null
  lifecycleOnly: boolean
  evaluatedRuns: number
  outcomeCoverage: number
  activeSkills: number
  cost: number
  costReportedRuns: number
  mode: 'demo' | 'local'
}

export function KpiStrip({ runs, successRate, lifecycleOnly, evaluatedRuns, outcomeCoverage, activeSkills, cost, costReportedRuns, mode }: KpiStripProps) {
  const items = [
    { label: 'Skill runs', rawValue: runs, value: runs.toLocaleString(), status: 'Recorded', delta: '↑ 12.7%', note: 'vs prior period', localNote: 'terminal events in the filtered period', values: [4, 9, 8, 13, 7, 18, 8, 16] },
    { label: 'Evaluated success', rawValue: successRate ?? '', value: lifecycleOnly ? 'Not evaluated' : successRate === null ? '—' : `${successRate.toFixed(1)}%`, status: runs ? `${outcomeCoverage.toFixed(0)}% coverage` : 'No runs', delta: successRate === null ? 'No evaluated outcome' : '↑ 3.4pp', note: lifecycleOnly ? 'completion observed, quality not evaluated' : successRate === null ? 'reported by runtime' : 'vs prior period', localNote: runs ? `${evaluatedRuns.toLocaleString()} of ${runs.toLocaleString()} runs have an evaluated outcome` : 'no runs in this period', values: [3, 8, 6, 9, 10, 8, 12, 13] },
    { label: 'Active skills', rawValue: activeSkills, value: activeSkills.toString(), status: 'Observed', delta: '↑ 5', note: 'newly observed', localNote: 'unique Skill names observed', values: [2, 8, 8, 10, 6, 6, 9, 8] },
    { label: 'Reported cost', rawValue: cost, value: `$${cost.toFixed(2)}`, status: costReportedRuns ? 'Reported' : 'Not reported', delta: '↓ 7.6%', note: 'per successful run', localNote: costReportedRuns ? `${costReportedRuns.toLocaleString()} of ${runs.toLocaleString()} runs include cost metadata` : 'no runtime cost metadata received', values: [2, 3, 5, 5, 8, 12, 10, 16] },
  ]
  return (
    <section className="kpi-strip" aria-label="Key performance indicators">
      {items.map((item) => (
        <div className="kpi" data-metric={item.label} key={item.label}>
          <div><span className="kpi-label">{item.label}</span><strong data-value={String(item.rawValue)}>{item.value}</strong></div>
          {mode === 'demo' ? <Sparkline values={item.values} /> : <span className="local-kpi-note">{item.status}</span>}
          <p>{mode === 'demo' ? <><span>{item.delta}</span> {item.note}</> : item.localNote}</p>
        </div>
      ))}
    </section>
  )
}
