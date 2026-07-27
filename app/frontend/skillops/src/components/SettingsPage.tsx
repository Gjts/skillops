import { Bot, Box, BrainCircuit, Code2, Download, ShieldCheck, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { AI_PROVIDERS, createDefaultAiSettings, providerIsConfigured, type AiSettings } from '../lib/ai-settings'
import type { PageId, Runtime, RuntimeConnection } from '../types'
import { AiSettingsModal } from './AiSettingsModal'
import { ThemeChooser } from './ThemeChooser'

type DataFeedback =
  | { kind: 'exported'; count: number }
  | { kind: 'cleared'; count: number; backupFile?: string }
  | { kind: 'clear-failed'; error?: string }

type SettingsPageProps = {
  connections: RuntimeConnection[]
  onConnect: (runtime: Runtime) => void
  onRefresh: () => void
  onClear: () => Promise<{ removed: number; backupFile?: string }>
  onNavigate: (page: PageId, href?: string) => void
}

const advancedPages: Array<{ page: PageId; label: 'nav.team' | 'nav.policies' | 'nav.templates' | 'nav.promptHub' | 'nav.audit' | 'nav.diagnostics'; href: string }> = [
  { page: 'team', label: 'nav.team', href: '/settings?section=advanced-team' },
  { page: 'team', label: 'nav.policies', href: '/settings?section=advanced-team&view=policies' },
  { page: 'team', label: 'nav.templates', href: '/settings?section=advanced-team&view=templates' },
  { page: 'assets', label: 'nav.promptHub', href: '/assets?artifactKind=prompt&artifactSource=prompthub' },
  { page: 'releases', label: 'nav.audit', href: '/releases' },
  { page: 'assets', label: 'nav.diagnostics', href: '/assets?view=diagnostics' },
]

export function SettingsPage({ connections, onConnect, onRefresh, onClear, onNavigate }: SettingsPageProps) {
  const { t, formatDateTime, formatNumber } = useI18n()
  const [summary, setSummary] = useState<{ generatedAt: string; count: number; lastRuntimeEventAt: string | null; sourceStatus: 'ok' | 'partial' } | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [feedback, setFeedback] = useState<DataFeedback | null>(null)
  const [aiSettings, setAiSettings] = useState<AiSettings>(createDefaultAiSettings)
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false)
  const [aiSettingsError, setAiSettingsError] = useState<string | null>(null)
  const confirmRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const connectionsRef = useRef<HTMLElement>(null)
  const providerRef = useRef<HTMLElement>(null)
  const dataRef = useRef<HTMLElement>(null)

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true)
    try {
      const response = await fetch('/api/events?summary=1')
      if (!response.ok) throw new Error(t('errors.eventStatus', { status: response.status }))
      const result = await response.json() as { generatedAt?: string; count?: number; lastRuntimeEventAt?: string | null; sourceStatus?: 'ok' | 'partial' }
      setSummary({ generatedAt: result.generatedAt ?? new Date().toISOString(), count: result.count ?? 0, lastRuntimeEventAt: result.lastRuntimeEventAt ?? null, sourceStatus: result.sourceStatus === 'partial' ? 'partial' : 'ok' })
      setSummaryError(null)
    } catch (error) {
      setSummaryError(error instanceof Error ? error.message : t('common.unknown'))
    } finally {
      setSummaryLoading(false)
    }
  }, [t])

  const loadAiSettings = useCallback(async () => {
    try {
      const response = await fetch('/api/ai-settings')
      if (!response.ok) throw new Error(t('settings.aiSettingsStatus', { status: response.status }))
      const result = await response.json() as AiSettings
      if (!result?.activeProvider || !result.providers?.[result.activeProvider]) throw new Error(t('settings.aiSettingsInvalid'))
      setAiSettings(result)
      setAiSettingsError(null)
    } catch (error) {
      setAiSettingsError(error instanceof Error ? error.message : t('settings.aiSettingsUnavailable'))
    }
  }, [t])

  useEffect(() => {
    void loadSummary()
    void loadAiSettings()
  }, [loadAiSettings, loadSummary])

  useEffect(() => {
    const section = new URLSearchParams(window.location.search).get('section')
    const target = section === 'connections' ? connectionsRef.current : section === 'provider' ? providerRef.current : section === 'data' ? dataRef.current : null
    if (!target) return
    target.scrollIntoView?.({ block: 'start' })
    target.focus()
  }, [])

  useEffect(() => {
    if (!confirmClear) return
    previousFocus.current = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    return () => previousFocus.current?.focus()
  }, [confirmClear])

  const statusFor = (runtime: Runtime) => {
    const connection = connections.find((item) => item.runtime === runtime)
    if (!connection || connection.status === 'checking') return t('common.checking')
    if (connection.status === 'installed') return t('common.installed')
    if (connection.status === 'broken') return t('common.configError')
    if (connection.status === 'error' || connection.status === 'unavailable') return t('common.unavailable')
    if (connection.status === 'preview') return t('common.preview')
    return t('common.notInstalled')
  }

  const stageFor = (runtime: Runtime) => {
    const connection = connections.find((item) => item.runtime === runtime)
    if (connection?.connectionStage === 'verified') return t('connect.verifiedEvidence')
    if (connection?.connectionStage === 'awaiting-verification') return t('connect.waitingEvidence')
    if (connection?.connectionStage === 'degraded') return t('connect.repair')
    if (connection?.connectionStage === 'preview-only') return t('connect.previewUnavailable')
    return t('connect.notVerified')
  }

  const activityFor = (runtime: Runtime) => {
    const connection = connections.find((item) => item.runtime === runtime)
    return connection?.eventCount
      ? t('settings.activityCount', { count: formatNumber(connection.eventCount), time: connection.lastActivityAt ? formatDateTime(connection.lastActivityAt) : t('settings.timeUnavailable') })
      : t('connect.noActivity')
  }

  const rows = [
    { runtime: 'codex' as const, name: 'Codex', detail: t('settings.codexDetail'), icon: Code2 },
    { runtime: 'claude-code' as const, name: 'Claude Code', detail: t('settings.claudeDetail'), icon: Bot },
    { runtime: 'cursor' as const, name: 'Cursor', detail: t('settings.cursorDetail'), icon: Box },
  ]

  const exportEvents = () => {
    window.location.assign('/api/events?download=1')
    setFeedback({ kind: 'exported', count: summary?.count ?? 0 })
  }

  const clear = async () => {
    setClearing(true)
    try {
      const result = await onClear()
      setFeedback({ kind: 'cleared', count: result.removed, backupFile: result.backupFile })
      setConfirmClear(false)
      await loadSummary()
    } catch (error) {
      setFeedback({ kind: 'clear-failed', error: error instanceof Error ? error.message : t('common.unknown') })
      setConfirmClear(false)
    } finally {
      setClearing(false)
    }
  }

  const saveAiSettings = async (next: AiSettings) => {
    try {
      const response = await fetch('/api/ai-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      const result = await response.json() as AiSettings & { error?: string }
      if (!response.ok) throw new Error(result.error || t('settings.aiSettingsStatus', { status: response.status }))
      setAiSettings(result)
      setAiSettingsError(null)
      setAiSettingsOpen(false)
    } catch (error) {
      setAiSettingsError(error instanceof Error ? error.message : t('settings.aiSettingsUnavailable'))
    }
  }

  const trapConfirmFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setConfirmClear(false)
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...(confirmRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])]
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  const provider = AI_PROVIDERS.find((item) => item.id === aiSettings.activeProvider)!
  const providerConfig = aiSettings.providers[aiSettings.activeProvider]
  const dataStatus = feedback?.kind === 'exported' ? t('settings.exported', { count: formatNumber(feedback.count) })
    : feedback?.kind === 'cleared' ? t('settings.cleared', { count: formatNumber(feedback.count), path: feedback.backupFile ? t('settings.backupPath', { path: feedback.backupFile }) : '' })
      : feedback?.kind === 'clear-failed' ? t('settings.clearFailed', { error: feedback.error ?? t('common.unknown') }) : null

  return (
    <div className="settings-page">
      <section ref={connectionsRef} tabIndex={-1} data-settings-section="connections" className="panel settings-section"><header><div><h2>{t('settings.runtimeConnections')}</h2><p>{t('settings.description')}</p></div><button className="button secondary" type="button" onClick={onRefresh}>{t('settings.refresh')}</button></header><div className="connection-list">{rows.map((row) => { const Icon = row.icon; const connection = connections.find((item) => item.runtime === row.runtime); return <article className="connection-row" key={row.runtime}><div className="connection-icon"><Icon size={19} /></div><div><strong>{row.name}</strong><span>{row.detail}</span><><small>{activityFor(row.runtime)}</small><small>{stageFor(row.runtime)}</small></>{connection?.verifiedEvidenceAt && <small>{t('agents.lastVerified')}: {formatDateTime(connection.verifiedEvidenceAt)}</small>}</div><span className={`connection-status ${connection?.status === 'broken' ? 'broken' : ''}`}>{statusFor(row.runtime)}</span><button className="button secondary" type="button" onClick={() => onConnect(row.runtime)}>{t(row.runtime === 'cursor' ? 'settings.view' : 'settings.configureRuntime', { runtime: row.name })}</button></article> })}</div></section>

      <section ref={providerRef} tabIndex={-1} data-settings-section="provider" className="panel settings-section settings-provider"><header><div><h2>{t('settings.aiProviders')}</h2><p>{t('settings.aiProviderDescription')}</p></div><button className="button secondary" type="button" onClick={() => setAiSettingsOpen(true)}><BrainCircuit size={15} />{t('evaluations.configureAi')}</button></header><dl><div><dt>{t('common.provider')}</dt><dd>{provider.label}</dd></div><div><dt>{t('common.model')}</dt><dd className="mono">{providerConfig.model || t('common.unavailable')}</dd></div><div><dt>{t('ai.baseUrl')}</dt><dd className="mono">{providerConfig.baseUrl || t('common.unavailable')}</dd></div><div><dt>{t('settings.credentialStatus')}</dt><dd>{provider.requiresKey ? (providerIsConfigured(aiSettings) ? t('settings.configured') : t('settings.notConfigured')) : t('settings.notRequired')}</dd></div></dl>{aiSettingsError && <p className="data-control-note" role="alert">{aiSettingsError}</p>}</section>

      <section className="panel settings-section settings-appearance"><header><div><h2>{t('common.appearance')}</h2><p>{t('settings.appearanceDescription')}</p></div></header><ThemeChooser /></section>

      <section ref={dataRef} tabIndex={-1} data-settings-section="data" className="panel settings-section data-controls"><header><div><h2>{t('settings.localData')}</h2><p>{t('settings.localDataDescription')}</p></div><strong>{t('settings.eventCount', { count: formatNumber(summary?.count ?? 0) })}</strong></header><dl><div><dt>{t('settings.storage')}</dt><dd className="mono">data/events.jsonl</dd></div><div><dt>{t('settings.lastRuntimeEvent')}</dt><dd>{summary?.lastRuntimeEventAt ? formatDateTime(summary.lastRuntimeEventAt) : t('connect.noActivity')}</dd></div><div><dt>{t('settings.contentBoundary')}</dt><dd>{t('settings.noRawContent')}</dd></div><div><dt>{t('settings.retention')}</dt><dd>{t('settings.noAutomaticRetention')}</dd></div><div><dt>{t('settings.encryption')}</dt><dd>{t('settings.filesystemEncryption')}</dd></div></dl><footer><button className="button secondary" type="button" disabled={!summary?.count} onClick={exportEvents}><Download size={15} />{t('settings.export')}</button><button className="button danger" type="button" disabled={!summary?.count || clearing} onClick={() => setConfirmClear(true)}><Trash2 size={15} />{t('settings.clear')}</button></footer>{summaryLoading && !summary && <p className="data-control-note" role="status">{t('mode.loadingEvents')}</p>}{summary?.sourceStatus === 'partial' && <p className="data-control-note" role="alert">{t('cc.partial')}</p>}{summaryError && <p className="data-control-note" role="alert">{summaryError} <button className="text-button" type="button" onClick={() => void loadSummary()}>{t('cc.retry')}</button></p>}{dataStatus && <p className="data-control-note" role="status">{dataStatus}</p>}</section>

      <section className="panel settings-section settings-advanced"><header><div><h2>{t('settings.advanced')}</h2><p>{t('settings.advancedDescription')}</p></div></header><div className="settings-link-list">{advancedPages.map((item) => <button className="button secondary" type="button" key={item.label} onClick={() => onNavigate(item.page, item.href)}>{t(item.label)}</button>)}</div></section>

      {confirmClear && <div ref={confirmRef} className="confirm-clear" role="alertdialog" aria-modal="true" aria-labelledby="confirm-clear-title" onKeyDown={trapConfirmFocus}><div><h2 id="confirm-clear-title">{t('settings.confirmTitle', { count: formatNumber(summary?.count ?? 0) })}</h2><p>{t('settings.confirmDescription')}</p></div><div><button ref={cancelRef} className="button secondary" type="button" onClick={() => setConfirmClear(false)}>{t('common.cancel')}</button><button className="button danger" type="button" disabled={clearing} onClick={() => void clear()}>{clearing ? t('settings.clearing') : t('settings.clearBackup')}</button></div></div>}
      <section className="privacy-note"><ShieldCheck size={20} /><div><strong>{t('settings.localFirst')}</strong><p>{t('settings.privacy')}</p></div></section>
      <AiSettingsModal open={aiSettingsOpen} settings={aiSettings} onClose={() => setAiSettingsOpen(false)} onSave={(next) => void saveAiSettings(next)} />
    </div>
  )
}
