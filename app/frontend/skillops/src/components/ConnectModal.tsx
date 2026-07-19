import { Bot, Box, Check, Clipboard, Code2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { runtimeLabel } from '../lib/analytics'
import type { Runtime, RuntimeConnection } from '../types'

const options: Array<{ runtime: Runtime; icon: typeof Code2; status: string; detail: string; command: string }> = [
  { runtime: 'codex', icon: Code2, status: 'Native adapter', detail: 'Session, Tool, Subagent and Skill detection hooks', command: 'npm run codex:install' },
  { runtime: 'claude-code', icon: Bot, status: 'Native adapter', detail: 'Session, Tool, Subagent, slash-command and Skill-tool hooks', command: 'npm run claude:install' },
  { runtime: 'cursor', icon: Box, status: 'Preview adapter', detail: 'Agent hooks + local event bridge', command: 'npm run emit -- skill.started --skill frontend-builder --runtime cursor' },
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
        <header><div><h2 id="connect-title">Connect a runtime</h2><p>Choose how SkillOps will receive lifecycle events.</p></div><button type="button" aria-label="Close" onClick={onClose}><X size={18} /></button></header>
        <div className="runtime-options">
          {options.map((option) => {
            const Icon = option.icon
            return (
              <button ref={option.runtime === initialRuntime ? initialOptionRef : undefined} className={selected === option.runtime ? 'runtime-option selected' : 'runtime-option'} key={option.runtime} type="button" onClick={() => { setSelected(option.runtime); setCopyState('idle') }}>
                <span className={`runtime-icon ${option.runtime}`}><Icon size={18} /></span>
                <span><strong>{runtimeLabel[option.runtime]}</strong><small>{option.detail}</small></span>
                {selected === option.runtime && <Check size={17} />}
              </button>
            )
          })}
        </div>
        <div className="connection-step">
          <span className="step-label">1 · Install adapter</span>
          <p>{current.status}. Run this command from the SkillOps project terminal:</p>
          <div className="command-box"><code>{current.command}</code><button type="button" onClick={copy} aria-label={copyState === 'copied' ? 'Command copied' : copyState === 'failed' ? 'Copy failed' : 'Copy command'}>{copyState === 'copied' ? <Check size={15} /> : <Clipboard size={15} />}</button></div>
          {copyState !== 'idle' && <span className={copyState === 'failed' ? 'copy-feedback failed-text' : 'copy-feedback success-text'} role="status" aria-live="polite">{copyState === 'copied' ? 'Command copied.' : 'Copy failed. Select the command and copy it manually.'}</span>}
        </div>
        <div className="connection-step verification-step">
          <span className="step-label">2 · Verify installation</span>
          <p className={connection.status === 'installed' ? 'success-text' : connection.status === 'broken' || connection.status === 'error' ? 'failed-text' : ''}>{connection.status === 'installed' ? 'Adapter installed' : connection.status === 'broken' ? 'Adapter configuration is broken' : connection.status === 'error' ? 'Adapter configuration could not be read' : connection.status === 'preview' ? 'Preview adapter is not installable yet' : connection.status === 'checking' ? 'Checking adapter…' : connection.status === 'unavailable' ? 'Connection service unavailable' : 'Adapter not installed'}</p>
          <button className="button secondary" type="button" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Checking…' : 'Check installation'}</button>
        </div>
        <div className="connection-step verification-step">
          <span className="step-label">3 · Confirm live activity</span>
          <p>{connection.eventCount ? `${connection.eventCount} runtime events recorded` : 'No runtime activity recorded'}</p>
          {connection.lastEventAt && <small>Last activity {new Date(connection.lastEventAt).toLocaleString()}</small>}
          {!connection.eventCount && connection.status === 'installed' && <small>Use a Skill in {runtimeLabel[selected]}, then refresh to confirm the complete connection.</small>}
          {connection.status === 'installed' && selected !== 'cursor' && <small>Remove this adapter later with <code>npm run {selected === 'codex' ? 'codex' : 'claude'}:uninstall</code>.</small>}
        </div>
        <footer><button className="button secondary" type="button" onClick={onClose}>Cancel</button><button className="button primary" type="button" disabled={connection.status !== 'installed'} onClick={onClose}>Finish setup</button></footer>
      </section>
    </div>
  )
}
