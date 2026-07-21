import { BrainCircuit, ExternalLink, Eye, EyeOff, KeyRound, LockKeyhole, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AI_PROVIDERS, type AiProviderConfig, type AiSettings } from '../lib/ai-settings'

interface AiSettingsModalProps {
  open: boolean
  settings: AiSettings
  onClose: () => void
  onSave: (settings: AiSettings) => void
}

export function AiSettingsModal({ open, settings, onClose, onSave }: AiSettingsModalProps) {
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

  const helper = useMemo(() => provider.id === 'ollama'
    ? 'No API key is required. SkillOps connects through the loopback Ollama endpoint.'
    : 'The key is sent only through the loopback SkillOps API to the selected provider.', [provider.id])

  if (!open) return null

  return (
    <div className="ai-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="ai-settings-modal" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title" ref={dialog}>
        <header>
          <span className="ai-modal-icon"><BrainCircuit size={21} /></span>
          <div><h2 id="ai-settings-title">AI settings</h2><p>Configure the model used for chat and A/B evaluation.</p></div>
          <button type="button" aria-label="Close AI settings" onClick={onClose}><X size={19} /></button>
        </header>

        <div className="ai-settings-body">
          <div className="ai-provider-column">
            <section className="ai-provider-section" aria-labelledby="provider-heading">
              <h3 id="provider-heading">Provider</h3>
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

            <div className="session-key-note"><LockKeyhole size={15} /><span>API keys stay only in this page's memory. Reloading or closing the page clears them.</span></div>
          </div>

          <div className="ai-config-column">
            <section className="ai-provider-config" aria-labelledby="provider-config-title">
              <div><h3 id="provider-config-title">{provider.label}</h3><p>{helper}</p></div>
              {provider.requiresKey && (
                <label className="ai-field">
                  <span><KeyRound size={14} /> API key</span>
                  <span className="secret-input">
                    <input type={showKey ? 'text' : 'password'} value={config.apiKey} autoComplete="off" placeholder={`Enter ${provider.label} API key`} onChange={(event) => updateConfig({ apiKey: event.target.value })} />
                    <button type="button" aria-label={showKey ? 'Hide API key' : 'Show API key'} onClick={() => setShowKey((visible) => !visible)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                  </span>
                  {provider.keyUrl && <small>Get an API key from <a href={provider.keyUrl} target="_blank" rel="noreferrer">{provider.label}<ExternalLink size={11} /></a></small>}
                </label>
              )}
              <label className="ai-field">
                <span>Model{provider.id === 'azure-openai' ? ' / deployment' : ''}</span>
                <input className="mono" type="text" value={config.model} placeholder={provider.defaultModel || 'Enter deployment name'} onChange={(event) => updateConfig({ model: event.target.value })} />
              </label>
              {provider.transport !== 'anthropic' && (
                <label className="ai-field">
                  <span>Reasoning effort</span>
                  <select aria-label="Reasoning effort" value={config.reasoningEffort} onChange={(event) => updateConfig({ reasoningEffort: event.target.value as AiProviderConfig['reasoningEffort'] })}>
                    <option value="">Provider default</option>
                    <option value="none">None</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="xhigh">XHigh</option>
                    <option value="max">Max</option>
                  </select>
                  <small>Sent as <span className="mono">reasoning_effort</span> when selected. GPT-5.6 defaults to Medium; its Chat Completions tool mode requires None.</small>
                </label>
              )}
              <label className="ai-field">
                <span>{provider.baseUrlLabel || 'Base URL'}</span>
                <input type="url" value={config.baseUrl} placeholder={provider.defaultBaseUrl || 'https://your-resource.openai.azure.com'} onChange={(event) => updateConfig({ baseUrl: event.target.value })} />
                <small>Credentialed providers require HTTPS. Ollama may use HTTP only on a loopback address. A custom endpoint receives the API key above.</small>
              </label>
              {provider.id === 'azure-openai' && <label className="ai-field"><span>API version</span><input className="mono" value={config.apiVersion || 'v1'} onChange={(event) => updateConfig({ apiVersion: event.target.value })} /></label>}
            </section>

            <div className="ai-privacy-note"><LockKeyhole size={17} /><p><strong>Privacy</strong> Saving stores provider settings, including API keys, in the local SkillOps data directory (`data/ai-settings.json`). Evaluation prompts, chat messages, and model output are still not written to disk. Read-only agent mode can send requested allowed workspace excerpts to the provider; review source for embedded sensitive data. Provider requests follow that provider's data policy.</p></div>
          </div>
        </div>

        <footer><button className="button secondary" type="button" onClick={onClose}>Cancel</button><button className="button ai-primary" type="button" disabled={!canSave} onClick={() => onSave(draft)}>Save settings</button></footer>
      </div>
    </div>
  )
}
