import { Bot, Box, Code2, ExternalLink } from 'lucide-react'
import { formatDuration, recentRuns, runtimeLabel } from '../lib/analytics'
import type { Runtime, SkillEvent } from '../types'

const icons: Record<Runtime, typeof Code2> = { codex: Code2, 'claude-code': Bot, cursor: Box }

export function ActivityRail({ events, expanded = false, onViewAll, onSelectRun, onConnect, refreshLabel = 'Refreshes every 3s' }: { events: SkillEvent[]; expanded?: boolean; onViewAll?: () => void; onSelectRun?: (run: SkillEvent) => void; onConnect?: () => void; refreshLabel?: string }) {
  const runs = recentRuns(events, expanded ? 20 : 7)
  return (
    <section className={expanded ? 'panel full-activity' : 'activity-rail'}>
      <header className="activity-header"><div><h2>Recent activity</h2>{expanded && <span>Latest terminal Skill events from every runtime</span>}</div>{!expanded && <button type="button" onClick={onViewAll}>View all <ExternalLink size={13} /></button>}</header>
      <div className="activity-list">
        {!runs.length && <div className="activity-empty"><strong>No Skill runs yet</strong><span>Connect Codex or Claude Code, or import an event file to start recording activity.</span>{onConnect && <button className="button secondary" type="button" onClick={onConnect}>Connect a runtime</button>}</div>}
        {runs.map((run) => {
          const Icon = icons[run.runtime]
          const unknown = run.event === 'skill.completed' && run.outcome !== 'success'
          const successful = run.event === 'skill.completed' && run.outcome === 'success'
          return (
            <button className="activity-item" key={run.id} type="button" onClick={() => onSelectRun?.(run)} aria-label={`View run ${run.id} for ${run.skillId ?? 'unidentified Skill'}`}>
              <span className={`event-node ${unknown ? 'observed' : successful ? 'success' : 'failed'}`} />
              <div className="activity-main">
                <div className="activity-title"><strong>{run.skillId}</strong><span>{run.skillVersion && run.skillVersion !== 'unversioned' ? `v${run.skillVersion}` : 'unversioned'}</span><time dateTime={run.timestamp}>{new Date(run.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })} · {new Date(run.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
                <div className="activity-runtime"><Icon size={14} /><span>{runtimeLabel[run.runtime]}</span><span className="mono">{run.project}</span></div>
                <div className="activity-meta"><span className="mono">{run.id}</span><span>{formatDuration(run.durationMs)}</span><strong className={unknown ? 'unknown-text' : successful ? 'success-text' : 'failed-text'}>{unknown ? 'Observed' : successful ? 'Success' : 'Failed'}</strong></div>
                {run.error && <p className="error-message">{run.error}</p>}
              </div>
            </button>
          )
        })}
      </div>
      {!expanded && <footer className="auto-refresh"><ActivityIcon /><span>{refreshLabel}</span></footer>}
    </section>
  )
}

function ActivityIcon() {
  return <span className="refresh-icon"><span /><span /></span>
}
