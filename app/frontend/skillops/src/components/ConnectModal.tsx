import { Bot, Box, Check, Clipboard, Code2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/messages'
import { runtimeLabel } from '../lib/analytics'
import type { Runtime, RuntimeConnection } from '../types'

const options: Array<{ runtime: Runtime; icon: typeof Code2; detail: MessageKey; preflight?: string; install?: string; uninstall?: string }> = [
  { runtime: 'codex', icon: Code2, detail: 'connect.codexDetail', preflight: 'npm run codex:dry-run', install: 'npm run codex:install', uninstall: 'npm run codex:uninstall' },
  { runtime: 'claude-code', icon: Bot, detail: 'connect.claudeDetail', preflight: 'npm run claude:dry-run', install: 'npm run claude:install', uninstall: 'npm run claude:uninstall' },
  { runtime: 'cursor', icon: Box, detail: 'connect.cursorDetail' },
]

const fallbackConnections: RuntimeConnection[] = [
  { runtime: 'codex', status: 'checking', configurationStatus: 'checking', eventCount: 0 },
  { runtime: 'claude-code', status: 'checking', configurationStatus: 'checking', eventCount: 0 },
  { runtime: 'cursor', status: 'preview', configurationStatus: 'preview', connectionStage: 'preview-only', eventCount: 0 },
]

const PREFLIGHT_TIMEOUT_MS = 8_000

type ConnectModalProps = {
  initialRuntime?: Runtime
  connections?: RuntimeConnection[]
  onRefresh?: () => Promise<RuntimeConnection[]>
  onClose: () => void
}

type SetupPreflight = {
  node: { version: string; supported: boolean }
  git: { available: boolean }
  localApi: { available: boolean }
  dataDirectory: { available: boolean; writable: boolean }
  runtimes: {
    available: boolean
    items: Array<{ runtime: Runtime; adapterReferenceHealth: 'healthy' | 'not-configured' | 'unhealthy' | 'unknown' | 'unsupported' }>
  }
}

function isSetupPreflight(value: unknown): value is SetupPreflight {
  const result = value as SetupPreflight
  return Boolean(result
    && typeof result.node?.version === 'string'
    && typeof result.node.supported === 'boolean'
    && typeof result.git?.available === 'boolean'
    && typeof result.localApi?.available === 'boolean'
    && typeof result.dataDirectory?.available === 'boolean'
    && typeof result.dataDirectory.writable === 'boolean'
    && typeof result.runtimes?.available === 'boolean'
    && Array.isArray(result.runtimes.items)
    && result.runtimes.items.every((item) => item
      && ['codex', 'claude-code', 'cursor'].includes(item.runtime)
      && ['healthy', 'not-configured', 'unhealthy', 'unknown', 'unsupported'].includes(item.adapterReferenceHealth)))
}

export function ConnectModal({ initialRuntime = 'codex', connections = fallbackConnections, onRefresh = async () => connections, onClose }: ConnectModalProps) {
  const { formatDateTime, formatNumber, t } = useI18n()
  const [selected, setSelected] = useState<Runtime>(initialRuntime)
  const [copyState, setCopyState] = useState<{ target: 'preflight' | 'install'; status: 'copied' | 'failed' } | null>(null)
  const [inspectedConnections, setInspectedConnections] = useState(connections)
  const [refreshing, setRefreshing] = useState(false)
  const [inspectionFailed, setInspectionFailed] = useState(false)
  const [preflight, setPreflight] = useState<SetupPreflight | null>(null)
  const [preflightError, setPreflightError] = useState(false)
  const [preflightAttempt, setPreflightAttempt] = useState(0)
  const [reviewConfirmed, setReviewConfirmed] = useState(false)
  const dialogRef = useRef<HTMLElement>(null)
  const initialOptionRef = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const current = options.find((option) => option.runtime === selected)!
  const connection: RuntimeConnection = inspectedConnections.find((item) => item.runtime === selected)
    ?? { runtime: selected, status: 'unavailable', eventCount: 0 }
  const configurationStatus = connection.configurationStatus ?? connection.status
  const stage = connection.connectionStage ?? (
    configurationStatus === 'preview' ? 'preview-only'
      : configurationStatus === 'broken' || configurationStatus === 'error' ? 'degraded'
        : configurationStatus === 'installed' ? 'awaiting-verification'
            : connection.detected ? 'detected' : 'not-detected'
  )
  const staleEvidence = stage === 'awaiting-verification' && connection.lastActivityAt && connection.verificationBoundaryAt
  const selectedAdapterHealth = preflight?.runtimes.items.find((item) => item.runtime === selected)?.adapterReferenceHealth
  const adapterReady = selectedAdapterHealth === 'healthy' || selectedAdapterHealth === 'not-configured'
  const adapterInstallable = adapterReady || selectedAdapterHealth === 'unhealthy'
  const preflightCanInstall = Boolean(preflight?.node.supported
    && preflight.git.available
    && preflight.localApi.available
    && preflight.dataDirectory.available
    && preflight.dataDirectory.writable
    && preflight.runtimes.available
    && adapterInstallable)

  useEffect(() => setInspectedConnections(connections), [connections])
  useEffect(() => {
    const controller = new AbortController()
    let mounted = true
    const timeout = window.setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS)
    setPreflight(null)
    setPreflightError(false)
    setReviewConfirmed(false)
    void fetch('/api/setup/preflight', { signal: controller.signal })
      .then(async (response) => {
        const body: unknown = await response.json()
        if (controller.signal.aborted || !response.ok || !isSetupPreflight(body)) throw new Error('Preflight unavailable.')
        setPreflight(body)
      })
      .catch(() => { if (mounted) setPreflightError(true) })
      .finally(() => window.clearTimeout(timeout))
    return () => {
      mounted = false
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [preflightAttempt])
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
    setInspectionFailed(false)
    try {
      setInspectedConnections(await onRefresh())
      setPreflightAttempt((value) => value + 1)
    } catch {
      setInspectionFailed(true)
    } finally {
      setRefreshing(false)
    }
  }
  const copy = async (target: 'preflight' | 'install', command: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable.')
      await navigator.clipboard.writeText(command)
      setCopyState({ target, status: 'copied' })
    } catch {
      setCopyState({ target, status: 'failed' })
    }
  }
  const copyLabel = (target: 'preflight' | 'install') => {
    if (copyState?.target !== target) return t(target === 'preflight' ? 'connect.copyPreflight' : 'connect.copyInstall')
    if (copyState.status === 'copied') return t(target === 'preflight' ? 'connect.preflightCopied' : 'connect.installCopied')
    return t(target === 'preflight' ? 'connect.preflightCopyFailed' : 'connect.installCopyFailed')
  }
  const configurationMessage = configurationStatus === 'installed'
    ? t('connect.adapterInstalled')
    : configurationStatus === 'broken'
      ? t('connect.adapterBroken')
      : configurationStatus === 'error'
        ? t('connect.adapterUnreadable')
        : configurationStatus === 'checking'
          ? t('connect.checkingAdapter')
          : configurationStatus === 'unavailable'
            ? t('connect.serviceUnavailable')
            : t('connect.adapterNotInstalled')

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} className="modal connection-modal" role="dialog" aria-modal="true" aria-labelledby="connect-title" onKeyDown={trapFocus} onMouseDown={(event) => event.stopPropagation()}>
        <header><div><h2 id="connect-title">{t('connect.title')}</h2><p>{t('connect.description')}</p></div><button type="button" aria-label={t('common.close')} onClick={onClose}><X size={18} /></button></header>
        <div className="runtime-options">
          {options.map((option) => {
            const Icon = option.icon
            return (
              <button ref={option.runtime === initialRuntime ? initialOptionRef : undefined} className={selected === option.runtime ? 'runtime-option selected' : 'runtime-option'} key={option.runtime} type="button" onClick={() => { setSelected(option.runtime); setCopyState(null); setInspectionFailed(false); setReviewConfirmed(false) }}>
                <span className={`runtime-icon ${option.runtime}`}><Icon size={18} /></span>
                <span><strong>{runtimeLabel[option.runtime]}</strong><small>{t(option.detail)}</small></span>
                {selected === option.runtime && <Check size={17} />}
              </button>
            )
          })}
        </div>
        {selected === 'cursor' ? (
          <div className="connection-step"><p>{t('connect.previewUnavailable')}</p></div>
        ) : (
          <ol className="connection-workflow">
            <li>
              <span className="step-label">{t('connect.preflightStep')}</span>
              <p>{t('connect.preflightInstruction')}</p>
              {!preflight && !preflightError && <small aria-live="polite">{t('common.checking')}</small>}
              {preflightError && <div role="alert"><span>{t('connect.preflightUnavailable')}</span><button className="text-button" type="button" onClick={() => setPreflightAttempt((value) => value + 1)}>{t('cc.retry')}</button></div>}
              {preflight && <ul className="preflight-results" aria-label={t('connect.preflightResults')}>
                {[
                  { label: `Node.js ${preflight.node.version}`, ready: preflight.node.supported, status: t(preflight.node.supported ? 'connect.preflightReady' : 'connect.preflightAttention') },
                  { label: 'Git', ready: preflight.git.available, status: t(preflight.git.available ? 'connect.preflightReady' : 'connect.preflightAttention') },
                  { label: 'Local API', ready: preflight.localApi.available, status: t(preflight.localApi.available ? 'connect.preflightReady' : 'connect.preflightAttention') },
                  {
                    label: t('connect.preflightDataDirectory'),
                    ready: preflight.dataDirectory.available && preflight.dataDirectory.writable,
                    status: t(!preflight.dataDirectory.available ? 'common.unavailable' : preflight.dataDirectory.writable ? 'connect.preflightReady' : 'connect.preflightReadOnly'),
                  },
                  { label: t('connect.preflightAdapter', { runtime: runtimeLabel[selected] }), ready: adapterReady, status: t(adapterReady ? 'connect.preflightReady' : 'connect.preflightAttention') },
                ].map(({ label, ready, status }) => <li key={label}><span>{label}</span><strong className={ready ? 'success-text' : 'failed-text'}>{status}</strong></li>)}
              </ul>}
              <div className="command-box"><code>{current.preflight}</code><button type="button" onClick={() => void copy('preflight', current.preflight!)} aria-label={copyLabel('preflight')}>{copyState?.target === 'preflight' && copyState.status === 'copied' ? <Check size={15} /> : <Clipboard size={15} />}</button></div>
            </li>
            <li>
              <span className="step-label">{t('connect.reviewStep')}</span>
              <p>{t('connect.previewSafe')}</p>
              <label className="review-confirmation">
                <input type="checkbox" checked={reviewConfirmed} disabled={!preflightCanInstall} onChange={(event) => setReviewConfirmed(event.target.checked)} />
                {t('connect.reviewConfirmed')}
              </label>
              {!preflightCanInstall && <small className="failed-text">{t('connect.installLocked')}</small>}
            </li>
            <li>
              <span className="step-label">{t('connect.confirmWriteStep')}</span>
              <p>{t('connect.confirmWrite')}</p>
              {reviewConfirmed && preflightCanInstall && <div className="command-box"><code>{current.install}</code><button type="button" onClick={() => void copy('install', current.install!)} aria-label={copyLabel('install')}>{copyState?.target === 'install' && copyState.status === 'copied' ? <Check size={15} /> : <Clipboard size={15} />}</button></div>}
              {copyState && <span className={copyState.status === 'failed' ? 'copy-feedback failed-text' : 'copy-feedback success-text'} role="status" aria-live="polite">{copyState.status === 'copied' ? t('connect.commandCopied') : t('connect.copyFailed')}</span>}
            </li>
            <li>
              <span className="step-label">{t('connect.restartStep')}</span>
              <p>{t('connect.restartRuntime', { runtime: runtimeLabel[selected] })}</p>
            </li>
            <li>
              <span className="step-label">{t('connect.inspectStep')}</span>
              <p className={configurationStatus === 'installed' ? 'success-text' : stage === 'degraded' ? 'failed-text' : ''}>{inspectionFailed ? t('connect.serviceUnavailable') : configurationMessage}</p>
              {stage === 'degraded' && <small className="failed-text">{t('connect.repair')}</small>}
              <button className="button secondary" type="button" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? t('common.checking') : t('connect.checkInstallation')}</button>
            </li>
            <li>
              <span className="step-label">{t('connect.triggerStep')}</span>
              <p>{t('connect.useSkill', { runtime: runtimeLabel[selected] })}</p>
            </li>
            <li>
              <span className="step-label">{t('connect.waitStep')}</span>
              <p className={stage === 'verified' ? 'success-text' : ''}>{stage === 'verified' ? t('connect.eventsRecorded', { count: formatNumber(connection.eventCount ?? 1) }) : staleEvidence ? t('connect.staleEvidence') : t('connect.waitingEvidence')}</p>
              {stage !== 'verified' && connection.eventCount ? <small>{t('connect.eventsRecorded', { count: formatNumber(connection.eventCount) })}</small> : null}
              {connection.lastActivityAt && <small>{t('connect.lastActivity', { time: formatDateTime(connection.lastActivityAt) })}</small>}
            </li>
            <li>
              <span className="step-label">{t('connect.verifiedStep')}</span>
              <p className={stage === 'verified' ? 'success-text' : ''}>{stage === 'verified' ? t('connect.verifiedEvidence') : t('connect.notVerified')}</p>
              {current.uninstall && <small>{t('connect.removeLater', { command: current.uninstall })}</small>}
            </li>
          </ol>
        )}
        <footer><button className="button secondary" type="button" onClick={onClose}>{t('common.cancel')}</button><button className="button primary" type="button" disabled={stage !== 'verified'} onClick={onClose}>{t('connect.finish')}</button></footer>
      </section>
    </div>
  )
}
