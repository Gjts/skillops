import { useI18n } from '../i18n/I18nProvider'
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
  const { formatNumber, t } = useI18n()
  const decimal = (value: number) => formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  const items = [
    { label: t('kpi.skillRuns'), rawValue: runs, value: formatNumber(runs), status: t('kpi.recorded'), delta: `↑ ${decimal(12.7)}%`, note: t('kpi.priorPeriod'), localNote: t('kpi.terminalEvents'), values: [4, 9, 8, 13, 7, 18, 8, 16] },
    { label: t('kpi.evaluatedSuccess'), rawValue: successRate ?? '', value: lifecycleOnly ? t('kpi.notEvaluated') : successRate === null ? '—' : `${decimal(successRate)}%`, status: runs ? t('kpi.coverage', { value: formatNumber(outcomeCoverage, { maximumFractionDigits: 0 }) }) : t('kpi.noRuns'), delta: successRate === null ? t('kpi.noOutcome') : `↑ ${t('units.percentagePoints', { value: decimal(3.4) })}`, note: lifecycleOnly ? t('kpi.completionOnly') : successRate === null ? t('kpi.reportedByRuntime') : t('kpi.priorPeriod'), localNote: runs ? t('kpi.outcomesCount', { evaluated: formatNumber(evaluatedRuns), runs: formatNumber(runs) }) : t('kpi.noRunsPeriod'), values: [3, 8, 6, 9, 10, 8, 12, 13] },
    { label: t('kpi.activeSkills'), rawValue: activeSkills, value: formatNumber(activeSkills), status: t('kpi.observed'), delta: `↑ ${formatNumber(5)}`, note: t('kpi.newlyObserved'), localNote: t('kpi.uniqueSkills'), values: [2, 8, 8, 10, 6, 6, 9, 8] },
    { label: t('kpi.reportedCost'), rawValue: cost, value: `$${formatNumber(cost, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, status: costReportedRuns ? t('kpi.reported') : t('kpi.notReported'), delta: `↓ ${decimal(7.6)}%`, note: t('kpi.perSuccess'), localNote: costReportedRuns ? t('kpi.costCount', { reported: formatNumber(costReportedRuns), runs: formatNumber(runs) }) : t('kpi.noCost'), values: [2, 3, 5, 5, 8, 12, 10, 16] },
  ]
  return (
    <section className="kpi-strip" aria-label={t('kpi.label')}>
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
