import { Bot, Box, CheckCircle2, Circle, Code2, X, XCircle } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { formatDuration, runtimeLabel } from '../lib/analytics'
import type { Runtime, SkillEvent } from '../types'

const runtimeIcon: Record<Runtime, typeof Code2> = { codex: Code2, 'claude-code': Bot, cursor: Box }

function eventLabel(event: SkillEvent) {
  return event.event.split('.').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ')
}

export function correlatedRunEvents(run: SkillEvent, events: SkillEvent[]) {
  return events
    .filter((event) => event.id === run.id || Boolean(run.sessionId && event.sessionId === run.sessionId))
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
}

export function RunDetail({ run, events, onClose }: { run: SkillEvent; events: SkillEvent[]; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const timeline = useMemo(() => correlatedRunEvents(run, events), [events, run])
  const Icon = runtimeIcon[run.runtime]
  const succeeded = run.event === 'skill.completed' && run.outcome === 'success'
  const observed = run.event === 'skill.completed' && run.outcome !== 'success'

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('keydown', escape); previousFocus.current?.focus() }
  }, [onClose])

  return (
    <div className="modal-backdrop run-detail-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="run-detail" role="dialog" aria-modal="true" aria-labelledby="run-detail-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span className="eyebrow">Run detail</span><h2 id="run-detail-title">{run.skillId ?? 'Unidentified Skill'}</h2><p className="mono">{run.id}</p></div>
          <button ref={closeRef} type="button" aria-label="Close run detail" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="run-detail-body">
          <section className="run-outcome" aria-label="Run outcome">
            <span className={observed ? 'observed' : succeeded ? 'success' : 'failed'}>{observed ? <Circle size={18} /> : succeeded ? <CheckCircle2 size={18} /> : <XCircle size={18} />}{observed ? 'Observed' : succeeded ? 'Success' : 'Failed'}</span>
            <time dateTime={run.timestamp}>{new Date(run.timestamp).toLocaleString()}</time>
          </section>
          <dl className="run-facts">
            <div><dt>Runtime</dt><dd><Icon size={15} />{runtimeLabel[run.runtime]}</dd></div>
            <div><dt>Version</dt><dd>{run.skillVersion && run.skillVersion !== 'unversioned' ? `v${run.skillVersion}` : 'Not reported'}</dd></div>
            <div><dt>Project</dt><dd>{run.project || 'Not reported'}</dd></div>
            <div><dt>Duration</dt><dd>{formatDuration(run.durationMs)}</dd></div>
            <div><dt>Cost</dt><dd>{run.costUsd === undefined ? 'Not reported' : `$${run.costUsd.toFixed(4)}`}</dd></div>
            <div><dt>Tokens</dt><dd>{run.tokens === undefined ? 'Not reported' : run.tokens.toLocaleString()}</dd></div>
            <div><dt>Session</dt><dd className="mono">{run.sessionId || 'Not reported'}</dd></div>
            <div><dt>Detection</dt><dd>{run.detectionMethod?.replaceAll('_', ' ') || 'Not reported'}</dd></div>
          </dl>
          {run.error && <section className="run-error"><h3>Error</h3><p>{run.error}</p></section>}
          <section className="run-timeline" aria-labelledby="run-timeline-title">
            <div><h3 id="run-timeline-title">Correlated timeline</h3><span>{timeline.length} {timeline.length === 1 ? 'event' : 'events'}</span></div>
            <ol>{timeline.map((event) => <li key={event.id}><span className="timeline-node" /><div><strong>{eventLabel(event)}</strong><time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString()}</time><small>{event.toolName || event.subagentType || event.reason || event.startSource || event.detectionMethod?.replaceAll('_', ' ') || 'Normalized runtime event'}</small></div></li>)}</ol>
          </section>
        </div>
      </aside>
    </div>
  )
}
