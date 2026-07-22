import { BrainCircuit, ExternalLink, Eye, EyeOff, KeyRound, LockKeyhole, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { AI_PROVIDERS, type AiProviderConfig, type AiSettings } from '../lib/ai-settings'

interface AiSettingsModalProps {
  open: boolean
  settings: AiSettings
  onClose: () => void
  onSave: (settings: AiSettings) => void
}

export function AiSettingsModal({ open, settings, onClose, onSave }: AiSettingsModalProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(settings)
  const [showKey, setShowKey] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previousFocus.current = document.activeElement as HTMLElement | null
    setDraft(settings)
    setShowKey(false)
    const timer = window.setTimeout(() => dialog.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus(), 0)
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialog.current) return
      const controls = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled)')]
      if (!controls.length) return
      const first = controls[0]
      const last = controls.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', handleKey)
      previousFocus.current?.focus()
    }
  }, [open, onClose, settings])

  const provider = AI_PROVIDERS.find((item) => item.id === draft.activeProvider)!
  const config = draft.providers[draft.activeProvider]
  const canSave = Boolean(config.model.trim() && config.baseUrl.trim() && (!provider.requiresKey || config.apiKey.trim()))

  const updateConfig = (updates: Partial<AiProviderConfig>) => {
    setDraft((current) => ({
      ...current,
      providers: {
        ...current.providers,
        [current.activeProvider]: { ...current.providers[current.activeProvider], ...updates },
      },
    }))
  }

  const helper = useMemo(() => provider.id === 'ollama' ? t('ai.ollamaHelper') : t('ai.providerHelper'), [provider.id, t])

  if (!open) return null

  return (
    <div className="ai-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="ai-settings-modal" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title" ref={dialog}>
        <header>
          <span className="ai-modal-icon"><BrainCircuit size={21} /></span>
          <div><h2 id="ai-settings-title">{t('ai.settingsTitle')}</h2><p>{t('ai.settingsDescription')}</p></div>
          <button type="button" aria-label={t('ai.closeSettings')} onClick={onClose}><X size={19} /></button>
        </header>

        <div className="ai-settings-body">
          <div className="ai-provider-column">
            <section className="ai-provider-section" aria-labelledby="provider-heading">
              <h3 id="provider-heading">{t('common.provider')}</h3>
              <div className="ai-provider-grid">
                {AI_PROVIDERS.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    className={draft.activeProvider === item.id ? 'ai-provider selected' : 'ai-provider'}
                    aria-pressed={draft.activeProvider === item.id}
                    data-autofocus={index === 0 ? '' : undefined}
                    onClick={() => { setDraft((current) => ({ ...current, activeProvider: item.id })); setShowKey(false) }}
                  >
                    <span aria-hidden="true">{item.icon}</span><strong>{item.label}</strong>
                  </button>
                ))}
              </div>
            </section>

            <div className="session-key-note"><LockKeyhole size={15} /><span>{t('ai.savedKeyNote')}</span></div>
          </div>

          <div className="ai-config-column">
            <section className="ai-provider-config" aria-labelledby="provider-config-title">
              <div><h3 id="provider-config-title">{provider.label}</h3><p>{helper}</p></div>
              {provider.requiresKey && (
                <label className="ai-field">
                  <span><KeyRound size={14} /> {t('ai.apiKey')}</span>
                  <span className="secret-input">
                    <input type={showKey ? 'text' : 'password'} value={config.apiKey} autoComplete="off" placeholder={t('ai.enterApiKey', { provider: provider.label })} onChange={(event) => updateConfig({ apiKey: event.target.value })} />
                    <button type="button" aria-label={showKey ? t('ai.hideApiKey') : t('ai.showApiKey')} onClick={() => setShowKey((visible) => !visible)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                  </span>
                  {provider.keyUrl && <small><a href={provider.keyUrl} target="_blank" rel="noreferrer">{t('ai.getApiKey', { provider: provider.label })}<ExternalLink size={11} /></a></small>}
                </label>
              )}
              <label className="ai-field">
                <span>{provider.id === 'azure-openai' ? t('ai.modelDeployment') : t('common.model')}</span>
                <input className="mono" type="text" value={config.model} placeholder={provider.defaultModel || t('ai.enterDeployment')} onChange={(event) => updateConfig({ model: event.target.value })} />
              </label>
              {provider.transport !== 'anthropic' && (
                <label className="ai-field">
                  <span>{t('ai.reasoningEffort')}</span>
                  <select aria-label={t('ai.reasoningEffort')} value={config.reasoningEffort} onChange={(event) => updateConfig({ reasoningEffort: event.target.value as AiProviderConfig['reasoningEffort'] })}>
                    <option value="">{t('ai.providerDefault')}</option>
                    <option value="none">{t('ai.reasoningNone')}</option>
                    <option value="low">{t('ai.reasoningLow')}</option>
                    <option value="medium">{t('ai.reasoningMedium')}</option>
                    <option value="high">{t('ai.reasoningHigh')}</option>
                    <option value="xhigh">{t('ai.reasoningXHigh')}</option>
                    <option value="max">{t('ai.reasoningMax')}</option>
                  </select>
                  <small>{t('ai.reasoningHelp')}</small>
                </label>
              )}
              <label className="ai-field">
                <span>{provider.id === 'azure-openai' ? t('ai.azureEndpoint') : t('ai.baseUrl')}</span>
                <input type="url" value={config.baseUrl} placeholder={provider.defaultBaseUrl || 'https://your-resource.openai.azure.com'} onChange={(event) => updateConfig({ baseUrl: event.target.value })} />
                <small>{t('ai.endpointHelp')}</small>
              </label>
              {provider.id === 'azure-openai' && <label className="ai-field"><span>{t('ai.apiVersion')}</span><input className="mono" value={config.apiVersion || 'v1'} onChange={(event) => updateConfig({ apiVersion: event.target.value })} /></label>}
            </section>

            <div className="ai-privacy-note"><LockKeyhole size={17} /><p><strong>{t('ai.privacy')}</strong> {t('ai.privacyDescription')}</p></div>
          </div>
        </div>

        <footer><button className="button secondary" type="button" onClick={onClose}>{t('common.cancel')}</button><button className="button ai-primary" type="button" disabled={!canSave} onClick={() => onSave(draft)}>{t('ai.saveSettings')}</button></footer>
      </div>
    </div>
  )
}
