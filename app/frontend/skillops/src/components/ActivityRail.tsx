import { Bot, Box, Code2, ExternalLink } from 'lucide-react'
import { useI18n } from '../i18n/I18nProvider'
import { demoErrorKeys } from '../i18n/demo'
import { recentRuns, runtimeLabel } from '../lib/analytics'
import type { Runtime, SkillEvent } from '../types'

const icons: Record<Runtime, typeof Code2> = { codex: Code2, 'claude-code': Bot, cursor: Box }

export function ActivityRail({ events, expanded = false, onViewAll, onSelectRun, onConnect, refreshLabel }: { events: SkillEvent[]; expanded?: boolean; onViewAll?: () => void; onSelectRun?: (run: SkillEvent) => void; onConnect?: () => void; refreshLabel?: string }) {
  const { formatDate, formatDuration, formatTime, t } = useI18n()
  const runs = recentRuns(events, expanded ? 20 : 7)
  return (
    <section className={expanded ? 'panel full-activity' : 'activity-rail'}>
      <header className="activity-header"><div><h2>{t('activity.title')}</h2>{expanded && <span>{t('activity.latest')}</span>}</div>{!expanded && <button type="button" onClick={onViewAll}>{t('activity.viewAll')} <ExternalLink size={13} /></button>}</header>
      <div className="activity-list">
        {!runs.length && <div className="activity-empty"><strong>{t('activity.emptyTitle')}</strong><span>{t('activity.emptyDescription')}</span>{onConnect && <button className="button secondary" type="button" onClick={onConnect}>{t('activity.connect')}</button>}</div>}
        {runs.map((run) => {
          const Icon = icons[run.runtime]
          const unknown = run.event === 'skill.completed' && run.outcome !== 'success'
          const successful = run.event === 'skill.completed' && run.outcome === 'success'
          const demoErrorKey = run.error ? demoErrorKeys[run.error] : undefined
          return (
            <button className="activity-item" key={run.id} type="button" onClick={() => onSelectRun?.(run)} aria-label={t('activity.viewRun', { id: run.id, skill: run.skillId ?? t('activity.unidentified') })}>
              <span className={`event-node ${unknown ? 'observed' : successful ? 'success' : 'failed'}`} />
              <div className="activity-main">
                <div className="activity-title"><strong>{run.skillId}</strong><span>{run.skillVersion && run.skillVersion !== 'unversioned' ? `v${run.skillVersion}` : t('common.unversioned')}</span><time dateTime={run.timestamp}>{formatDate(run.timestamp)} · {formatTime(run.timestamp)}</time></div>
                <div className="activity-runtime"><Icon size={14} /><span>{runtimeLabel[run.runtime]}</span><span className="mono">{run.project}</span></div>
                <div className="activity-meta"><span className="mono">{run.id}</span><span>{formatDuration(run.durationMs)}</span><strong className={unknown ? 'unknown-text' : successful ? 'success-text' : 'failed-text'}>{unknown ? t('activity.observed') : successful ? t('activity.success') : t('activity.failed')}</strong></div>
                {run.error && <p className="error-message">{demoErrorKey ? t(demoErrorKey) : run.error}</p>}
              </div>
            </button>
          )
        })}
      </div>
      {!expanded && <footer className="auto-refresh"><ActivityIcon /><span>{refreshLabel ?? t('activity.refresh')}</span></footer>}
    </section>
  )
}

function ActivityIcon() {
  return <span className="refresh-icon"><span /><span /></span>
}
