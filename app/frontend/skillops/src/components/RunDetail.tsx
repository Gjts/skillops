import { Bot, Box, CheckCircle2, Circle, Code2, X, XCircle } from 'lucide-react'
import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useI18n, type I18nContextValue } from '../i18n/I18nProvider'
import { demoErrorKeys } from '../i18n/demo'
import type { MessageKey } from '../i18n/messages'
import { runtimeLabel } from '../lib/analytics'
import type { DetectionMethod, EventName, Runtime, SkillEvent } from '../types'

const runtimeIcon: Record<Runtime, typeof Code2> = { codex: Code2, 'claude-code': Bot, cursor: Box }

const eventKeys: Record<EventName, MessageKey> = {
  'skill.discovered': 'event.skillDiscovered',
  'skill.matched': 'event.skillMatched',
  'skill.started': 'event.skillStarted',
  'skill.completed': 'event.skillCompleted',
  'skill.failed': 'event.skillFailed',
  'skill.skipped': 'event.skillSkipped',
  'session.started': 'event.sessionStarted',
  'session.completed': 'event.sessionCompleted',
  'turn.completed': 'event.turnCompleted',
  'prompt.submitted': 'event.promptSubmitted',
  'tool.started': 'event.toolStarted',
  'tool.completed': 'event.toolCompleted',
  'subagent.started': 'event.subagentStarted',
  'subagent.completed': 'event.subagentCompleted',
}

const detectionKeys: Record<DetectionMethod, MessageKey> = {
  explicit_prompt: 'detection.explicitPrompt',
  slash_command: 'detection.slashCommand',
  skill_tool: 'detection.skillTool',
  skill_path: 'detection.skillPath',
  manual: 'detection.manual',
  hook: 'detection.hook',
}

function eventLabel(event: SkillEvent, t: I18nContextValue['t']) {
  return t(eventKeys[event.event])
}

export function correlatedRunEvents(run: SkillEvent, events: SkillEvent[]) {
  return events
    .filter((event) => {
      if (event.id === run.id) return true
      if (event.runtime !== run.runtime) return false
      if (!run.turnId) return Boolean(run.sessionId && event.sessionId === run.sessionId)
      if (run.sessionId) return event.sessionId === run.sessionId && (event.turnId === run.turnId || !event.turnId)
      return event.turnId === run.turnId && !event.sessionId
    })
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.id.localeCompare(right.id))
}

export function RunDetail({ run, events, totalEvents = events.length, truncated = false, onClose }: { run: SkillEvent; events: SkillEvent[]; totalEvents?: number; truncated?: boolean; onClose: () => void }) {
  const { formatDateTime, formatDuration, formatNumber, formatTime, formatUsd, t } = useI18n()
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const timeline = useMemo(() => correlatedRunEvents(run, events), [events, run])
  const Icon = runtimeIcon[run.runtime]
  const succeeded = run.event === 'skill.completed' && run.outcome === 'success'
  const observed = run.event === 'skill.completed' && run.outcome !== 'success'
  const demoErrorKey = run.error ? demoErrorKeys[run.error] : undefined

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('keydown', escape); previousFocus.current?.focus() }
  }, [onClose])

  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return
    const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])]
    if (!controls.length) return
    const first = controls[0]
    const last = controls.at(-1)!
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  return (
    <div className="modal-backdrop run-detail-backdrop" role="presentation" onMouseDown={onClose}>
      <aside ref={dialogRef} className="run-detail" role="dialog" aria-modal="true" aria-labelledby="run-detail-title" onKeyDown={trapFocus} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span className="eyebrow">{t('detail.title')}</span><h2 id="run-detail-title">{run.skillId ?? t('detail.unidentified')}</h2><p className="mono">{run.id}</p></div>
          <button ref={closeRef} type="button" aria-label={t('detail.close')} onClick={onClose}><X size={18} /></button>
        </header>
        <div className="run-detail-body">
          <section className="run-outcome" aria-label={t('detail.outcome')}>
            <span className={observed ? 'observed' : succeeded ? 'success' : 'failed'}>{observed ? <Circle size={18} /> : succeeded ? <CheckCircle2 size={18} /> : <XCircle size={18} />}{observed ? t('activity.observed') : succeeded ? t('activity.success') : t('activity.failed')}</span>
            <time dateTime={run.timestamp}>{formatDateTime(run.timestamp)}</time>
          </section>
          <dl className="run-facts">
            <div><dt>{t('common.runtime')}</dt><dd><Icon size={15} />{runtimeLabel[run.runtime]}</dd></div>
            <div><dt>{t('common.version')}</dt><dd>{run.skillVersion && run.skillVersion !== 'unversioned' ? `v${run.skillVersion}` : t('common.notReported')}</dd></div>
            <div><dt>{t('common.project')}</dt><dd>{run.project || t('common.notReported')}</dd></div>
            <div><dt>{t('common.duration')}</dt><dd>{formatDuration(run.durationMs)}</dd></div>
            <div><dt>{t('common.cost')}</dt><dd>{typeof run.costUsd === 'number' && Number.isFinite(run.costUsd) ? formatUsd(run.costUsd) : t('common.notReported')}</dd></div>
            <div><dt>{t('common.tokens')}</dt><dd>{run.tokens === undefined ? t('common.notReported') : formatNumber(run.tokens)}</dd></div>
            <div><dt>{t('common.session')}</dt><dd className="mono">{run.sessionId || t('common.notReported')}</dd></div>
            <div><dt>{t('common.detection')}</dt><dd>{run.detectionMethod ? t(detectionKeys[run.detectionMethod]) : t('common.notReported')}</dd></div>
          </dl>
          {run.error && <section className="run-error"><h3>{t('common.error')}</h3><p>{demoErrorKey ? t(demoErrorKey) : run.error}</p></section>}
          <section className="run-timeline" aria-labelledby="run-timeline-title">
            <div><h3 id="run-timeline-title">{t('detail.timeline')}</h3><span>{truncated ? `${formatNumber(timeline.length)} / ${formatNumber(totalEvents)}` : formatNumber(timeline.length)} {t(totalEvents === 1 ? 'common.event' : 'common.events')}</span></div>
            <p className="timeline-truncation">{t('detail.timelineBoundary')}</p>
            {truncated && <p className="timeline-truncation" role="status">{t('detail.timelineTruncated', { shown: formatNumber(timeline.length), total: formatNumber(totalEvents) })}</p>}
            <ol>{timeline.map((event) => <li key={event.id}><span className="timeline-node" /><div><strong>{eventLabel(event, t)}</strong><time dateTime={event.timestamp}>{formatTime(event.timestamp)}</time><small>{event.toolName || event.subagentType || event.reason || event.startSource || (event.detectionMethod ? t(detectionKeys[event.detectionMethod]) : undefined) || t('common.normalizedRuntimeEvent')}</small></div></li>)}</ol>
          </section>
        </div>
      </aside>
    </div>
  )
}
