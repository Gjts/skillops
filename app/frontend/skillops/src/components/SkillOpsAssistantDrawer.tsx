import { Bot, BrainCircuit, LoaderCircle, LockKeyhole, Send, Settings2, Sparkles, User, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'

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
}

const focusableSelector = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
const WIDTH_STORAGE_KEY = 'skillops.assistant-drawer.width.v1'
const DEFAULT_DRAWER_WIDTH = 420
const MIN_DRAWER_WIDTH = 320
const MAX_DRAWER_WIDTH = 720

function clampDrawerWidth(value: number) {
  const viewportCap = typeof window === 'undefined' ? MAX_DRAWER_WIDTH : Math.min(MAX_DRAWER_WIDTH, Math.max(MIN_DRAWER_WIDTH, window.innerWidth - 48))
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
}: SkillOpsAssistantDrawerProps) {
  const drawer = useRef<HTMLElement>(null)
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
  }, [open])

  useEffect(() => {
    if (!open) return
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButton.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(drawer.current?.querySelectorAll<HTMLElement>(focusableSelector) || [])
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
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

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (typeof event.button === 'number' && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = widthRef.current
    setResizing(true)

    const onMove = (moveEvent: PointerEvent) => {
      const next = clampDrawerWidth(startWidth + (startX - moveEvent.clientX))
      widthRef.current = next
      setWidth(next)
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
    <div className={`modal-backdrop assistant-drawer-backdrop${resizing ? ' resizing' : ''}`} role="presentation" onMouseDown={onClose}>
      <aside
        ref={drawer}
        className="assistant-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`SkillOps assistant, ${contextLabel}`}
        style={{ ['--assistant-drawer-width' as string]: `${width}px` }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="assistant-drawer-resize"
          aria-label="Resize SkillOps assistant"
          title="Drag to resize"
          onPointerDown={startResize}
        />
        <header>
          <span className="assistant-avatar"><BrainCircuit size={18} /></span>
          <div><h2>SkillOps assistant</h2><span>{configuredProvider || 'AI provider not configured'}</span></div>
          <button type="button" aria-label="Open AI settings" onClick={onOpenSettings}><Settings2 size={16} /></button>
          <button ref={closeButton} type="button" aria-label="Close SkillOps assistant" onClick={onClose}><X size={17} /></button>
        </header>
        <div className="assistant-context"><Sparkles size={13} /><span>{contextLabel}</span></div>
        <div className="assistant-messages" aria-live="polite">
          {messages.map((message) => <div className={`chat-message ${message.role}`} key={message.id}><span>{message.role === 'assistant' ? <Bot size={14} /> : <User size={14} />}</span><p>{message.content}</p></div>)}
          {chatting && <div className="chat-message assistant pending"><span><Bot size={14} /></span><p><LoaderCircle className="spin" size={14} />Thinking with current Skill metadata…</p></div>}
        </div>
        {error && <p className="chat-error" role="alert">{error}</p>}
        <div className="chat-suggestions">
          {suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => onSelectSuggestion(suggestion)}>{suggestion}</button>)}
        </div>
        <form className="assistant-composer" onSubmit={submit}>
          <textarea aria-label="Ask SkillOps" rows={3} placeholder="Ask about the candidate, baseline, or result…" value={input} onChange={(event) => onInputChange(event.target.value)} onKeyDown={handleComposerKeyDown} />
          <div><span><LockKeyhole size={12} />Not stored</span><button type="submit" aria-label="Send message" disabled={!input.trim() || chatting}>{chatting ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}</button></div>
        </form>
      </aside>
    </div>
  )
}
