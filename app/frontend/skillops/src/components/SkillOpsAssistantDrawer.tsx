import { Bot, BrainCircuit, LoaderCircle, LockKeyhole, Send, Settings2, Sparkles, User, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useI18n } from '../i18n/I18nProvider'

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  localOnly?: boolean
}

interface SkillOpsAssistantDrawerProps {
  open: boolean
  configuredProvider: string | null
  contextLabel: string
  messages: AssistantMessage[]
  suggestions: string[]
  input: string
  chatting: boolean
  error: string | null
  onInputChange: (value: string) => void
  onSelectSuggestion: (suggestion: string) => void
  onSend: () => void
  onOpenSettings: () => void
  onClose: () => void
  onWidthChange?: (width: number) => void
}

const WIDTH_STORAGE_KEY = 'skillops.assistant-drawer.width.v1'
const DEFAULT_DRAWER_WIDTH = 420
const MIN_DRAWER_WIDTH = 320
const MAX_DRAWER_WIDTH = 720

function clampDrawerWidth(value: number) {
  const viewportCap = typeof window === 'undefined'
    ? MAX_DRAWER_WIDTH
    : Math.min(MAX_DRAWER_WIDTH, Math.max(MIN_DRAWER_WIDTH, Math.floor(window.innerWidth * 0.55)))
  return Math.min(viewportCap, Math.max(MIN_DRAWER_WIDTH, Math.round(value)))
}

function readStoredDrawerWidth() {
  try {
    const stored = Number(window.localStorage.getItem(WIDTH_STORAGE_KEY))
    if (Number.isFinite(stored)) return clampDrawerWidth(stored)
  } catch {
    // Storage can be disabled by browser policy.
  }
  return DEFAULT_DRAWER_WIDTH
}

export function SkillOpsAssistantDrawer({
  open,
  configuredProvider,
  contextLabel,
  messages,
  suggestions,
  input,
  chatting,
  error,
  onInputChange,
  onSelectSuggestion,
  onSend,
  onOpenSettings,
  onClose,
  onWidthChange,
}: SkillOpsAssistantDrawerProps) {
  const { t } = useI18n()
  const panel = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const widthRef = useRef(DEFAULT_DRAWER_WIDTH)
  const [width, setWidth] = useState(DEFAULT_DRAWER_WIDTH)
  const [resizing, setResizing] = useState(false)

  useEffect(() => {
    if (!open) return
    const next = readStoredDrawerWidth()
    widthRef.current = next
    setWidth(next)
    onWidthChange?.(next)
  }, [onWidthChange, open])

  useEffect(() => {
    if (!open) return
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButton.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      previousFocus.current?.focus()
    }
  }, [onClose, open])

  if (!open) return null

  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSend()
  }
  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSend()
    }
  }

  const applyWidth = (next: number) => {
    widthRef.current = next
    setWidth(next)
    onWidthChange?.(next)
  }

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (typeof event.button === 'number' && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = widthRef.current
    setResizing(true)

    const onMove = (moveEvent: PointerEvent) => {
      applyWidth(clampDrawerWidth(startWidth + (startX - moveEvent.clientX)))
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      setResizing(false)
      try {
        window.localStorage.setItem(WIDTH_STORAGE_KEY, String(widthRef.current))
      } catch {
        // Keep the in-memory width when storage is unavailable.
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  return (
    <aside
      ref={panel}
      className={`assistant-drawer${resizing ? ' resizing' : ''}`}
      role="complementary"
      aria-label={t('assistant.label', { context: contextLabel })}
      style={{ ['--assistant-drawer-width' as string]: `${width}px` }}
    >
      <button
        type="button"
        className="assistant-drawer-resize"
        aria-label={t('assistant.resize')}
        title={t('assistant.dragResize')}
        onPointerDown={startResize}
      />
      <header>
        <span className="assistant-avatar"><BrainCircuit size={18} /></span>
        <div><h2 id="skillops-assistant-title">{t('assistant.title')}</h2><span>{configuredProvider || t('assistant.providerNotConfigured')}</span></div>
        <button type="button" aria-label={t('assistant.openSettings')} onClick={onOpenSettings}><Settings2 size={16} /></button>
        <button ref={closeButton} type="button" aria-label={t('assistant.close')} onClick={onClose}><X size={17} /></button>
      </header>
      <div className="assistant-context"><Sparkles size={13} /><span>{contextLabel}</span></div>
      <div className="assistant-messages" aria-live="polite">
        {messages.map((message) => <div className={`chat-message ${message.role}`} key={message.id}><span>{message.role === 'assistant' ? <Bot size={14} /> : <User size={14} />}</span><p>{message.content}</p></div>)}
        {chatting && <div className="chat-message assistant pending"><span><Bot size={14} /></span><p><LoaderCircle className="spin" size={14} />{t('assistant.thinking')}</p></div>}
      </div>
      {error && <p className="chat-error" role="alert">{error}</p>}
      <div className="chat-suggestions">
        {suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => onSelectSuggestion(suggestion)}>{suggestion}</button>)}
      </div>
      <form className="assistant-composer" onSubmit={submit}>
        <textarea aria-label={t('quick.askSkillOps')} rows={3} placeholder={t('assistant.placeholder')} value={input} onChange={(event) => onInputChange(event.target.value)} onKeyDown={handleComposerKeyDown} />
        <div><span><LockKeyhole size={12} />{t('assistant.notStored')}</span><button type="submit" aria-label={t('assistant.send')} disabled={!input.trim() || chatting}>{chatting ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}</button></div>
      </form>
    </aside>
  )
}
