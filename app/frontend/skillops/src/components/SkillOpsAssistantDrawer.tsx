import { Bot, BrainCircuit, LoaderCircle, LockKeyhole, Send, Settings2, Sparkles, User, X } from 'lucide-react'
import { useEffect, useRef, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'

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

  return (
    <div className="modal-backdrop assistant-drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        ref={drawer}
        className="assistant-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`SkillOps assistant, ${contextLabel}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
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
