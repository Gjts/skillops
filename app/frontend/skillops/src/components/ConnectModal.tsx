import { Bot, Box, Check, Clipboard, Code2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/messages'
import { runtimeLabel } from '../lib/analytics'
import type { Runtime, RuntimeConnection } from '../types'

const options: Array<{ runtime: Runtime; icon: typeof Code2; status: MessageKey; detail: MessageKey; command: string }> = [
  { runtime: 'codex', icon: Code2, status: 'connect.nativeAdapter', detail: 'connect.codexDetail', command: 'npm run codex:install' },
  { runtime: 'claude-code', icon: Bot, status: 'connect.nativeAdapter', detail: 'connect.claudeDetail', command: 'npm run claude:install' },
  { runtime: 'cursor', icon: Box, status: 'connect.previewAdapter', detail: 'connect.cursorDetail', command: 'npm run emit -- skill.started --skill frontend-builder --runtime cursor' },
]

const fallbackConnections: RuntimeConnection[] = [
  { runtime: 'codex', status: 'checking', eventCount: 0 },
  { runtime: 'claude-code', status: 'checking', eventCount: 0 },
  { runtime: 'cursor', status: 'preview', eventCount: 0 },
]

type ConnectModalProps = {
  initialRuntime?: Runtime
  connections?: RuntimeConnection[]
  onRefresh?: () => Promise<RuntimeConnection[]>
  onClose: () => void
}

export function ConnectModal({ initialRuntime = 'codex', connections = fallbackConnections, onRefresh = async () => connections, onClose }: ConnectModalProps) {
  const { formatDateTime, formatNumber, t } = useI18n()
  const [selected, setSelected] = useState<Runtime>(initialRuntime)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [inspectedConnections, setInspectedConnections] = useState(connections)
  const [refreshing, setRefreshing] = useState(false)
  const dialogRef = useRef<HTMLElement>(null)
  const initialOptionRef = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const current = options.find((option) => option.runtime === selected)!
  const connection = inspectedConnections.find((item) => item.runtime === selected) ?? { runtime: selected, status: 'unavailable' as const, eventCount: 0 }

  useEffect(() => setInspectedConnections(connections), [connections])
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    initialOptionRef.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('keydown', closeOnEscape)
      previousFocus.current?.focus()
    }
  }, [onClose])

  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])]
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable.at(-1)!
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  const refresh = async () => {
    setRefreshing(true)
    try { setInspectedConnections(await onRefresh()) } finally { setRefreshing(false) }
  }
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable.')
      await navigator.clipboard.writeText(current.command)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="connect-title" onKeyDown={trapFocus} onMouseDown={(event) => event.stopPropagation()}>
        <header><div><h2 id="connect-title">{t('connect.title')}</h2><p>{t('connect.description')}</p></div><button type="button" aria-label={t('common.close')} onClick={onClose}><X size={18} /></button></header>
        <div className="runtime-options">
          {options.map((option) => {
            const Icon = option.icon
            return (
              <button ref={option.runtime === initialRuntime ? initialOptionRef : undefined} className={selected === option.runtime ? 'runtime-option selected' : 'runtime-option'} key={option.runtime} type="button" onClick={() => { setSelected(option.runtime); setCopyState('idle') }}>
                <span className={`runtime-icon ${option.runtime}`}><Icon size={18} /></span>
                <span><strong>{runtimeLabel[option.runtime]}</strong><small>{t(option.detail)}</small></span>
                {selected === option.runtime && <Check size={17} />}
              </button>
            )
          })}
        </div>
        <div className="connection-step">
          <span className="step-label">{t('connect.installStep')}</span>
          <p>{t('connect.installInstruction', { status: t(current.status) })}</p>
          <div className="command-box"><code>{current.command}</code><button type="button" onClick={copy} aria-label={copyState === 'copied' ? t('connect.commandCopiedLabel') : copyState === 'failed' ? t('connect.copyFailedLabel') : t('connect.copyCommand')}>{copyState === 'copied' ? <Check size={15} /> : <Clipboard size={15} />}</button></div>
          {copyState !== 'idle' && <span className={copyState === 'failed' ? 'copy-feedback failed-text' : 'copy-feedback success-text'} role="status" aria-live="polite">{copyState === 'copied' ? t('connect.commandCopied') : t('connect.copyFailed')}</span>}
        </div>
        <div className="connection-step verification-step">
          <span className="step-label">{t('connect.verifyStep')}</span>
          <p className={connection.status === 'installed' ? 'success-text' : connection.status === 'broken' || connection.status === 'error' ? 'failed-text' : ''}>{connection.status === 'installed' ? t('connect.adapterInstalled') : connection.status === 'broken' ? t('connect.adapterBroken') : connection.status === 'error' ? t('connect.adapterUnreadable') : connection.status === 'preview' ? t('connect.previewUnavailable') : connection.status === 'checking' ? t('connect.checkingAdapter') : connection.status === 'unavailable' ? t('connect.serviceUnavailable') : t('connect.adapterNotInstalled')}</p>
          <button className="button secondary" type="button" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? t('common.checking') : t('connect.checkInstallation')}</button>
        </div>
        <div className="connection-step verification-step">
          <span className="step-label">{t('connect.activityStep')}</span>
          <p>{connection.eventCount ? t('connect.eventsRecorded', { count: formatNumber(connection.eventCount) }) : t('connect.noActivity')}</p>
          {connection.lastEventAt && <small>{t('connect.lastActivity', { time: formatDateTime(connection.lastEventAt) })}</small>}
          {!connection.eventCount && connection.status === 'installed' && <small>{t('connect.useSkill', { runtime: runtimeLabel[selected] })}</small>}
          {connection.status === 'installed' && selected !== 'cursor' && <small>{t('connect.removeLater', { command: `npm run ${selected === 'codex' ? 'codex' : 'claude'}:uninstall` })}</small>}
        </div>
        <footer><button className="button secondary" type="button" onClick={onClose}>{t('common.cancel')}</button><button className="button primary" type="button" disabled={connection.status !== 'installed'} onClick={onClose}>{t('connect.finish')}</button></footer>
      </section>
    </div>
  )
}
