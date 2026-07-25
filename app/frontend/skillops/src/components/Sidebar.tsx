import {
  Activity,
  Bot,
  Boxes,
  ChartNoAxesCombined,
  ChevronRight,
  CircleGauge,
  Languages,
  Menu,
  Settings,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { localeOptions, type MessageKey } from '../i18n/messages'
import type { PageId } from '../types'
import { ThemeChooser } from './ThemeChooser'

const navigation: Array<{ id: PageId; label: MessageKey; icon: typeof Activity }> = [
  { id: 'command-center', label: 'nav.commandCenter', icon: CircleGauge },
  { id: 'agents', label: 'nav.agents', icon: Bot },
  { id: 'activity', label: 'nav.activity', icon: Activity },
  { id: 'assets', label: 'nav.assets', icon: Boxes },
  { id: 'benchmarks', label: 'nav.benchmarks', icon: ChartNoAxesCombined },
  { id: 'releases', label: 'nav.releases', icon: ShieldCheck },
  { id: 'settings', label: 'nav.settings', icon: Settings },
]

interface SidebarProps {
  page: PageId
  open: boolean
  onNavigate: (page: PageId) => void
  onToggle: () => void
  onClose: () => void
}

export function Sidebar({ page, open, onNavigate, onToggle, onClose }: SidebarProps) {
  const { locale, setLocale, t } = useI18n()
  const menuButton = useRef<HTMLButtonElement>(null)
  const sidebar = useRef<HTMLElement>(null)

  const close = () => {
    onClose()
    if (open) menuButton.current?.focus()
  }

  useEffect(() => {
    if (open) sidebar.current?.querySelector<HTMLElement>('button:not(:disabled), summary, select')?.focus()
  }, [open])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const controls = [...(sidebar.current?.querySelectorAll<HTMLElement>('button:not(:disabled), summary, select, input:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])]
    if (!controls.length) return
    const first = controls[0]
    const last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  return (
    <>
      <button ref={menuButton} className="mobile-menu" type="button" onClick={onToggle} aria-label={t('nav.toggle')} aria-expanded={open} aria-controls="primary-navigation">
        {open ? <X size={19} /> : <Menu size={19} />}
      </button>
      {open && <button className="sidebar-scrim" type="button" aria-label={t('nav.close')} onClick={close} />}
      <aside id="primary-navigation" ref={sidebar} className={`sidebar ${open ? 'is-open' : ''}`} role={open ? 'dialog' : undefined} aria-modal={open || undefined} aria-label={open ? t('nav.main') : undefined} onKeyDown={handleKeyDown}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><ChevronRight size={21} /><span /></span>
          <span>SkillOps</span>
        </div>
        <nav className="navigation" aria-label={t('nav.main')}>
          {navigation.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={page === item.id ? 'nav-item is-active' : 'nav-item'}
                type="button"
                onClick={() => { onNavigate(item.id); close() }}
              >
                <Icon size={18} strokeWidth={1.7} />
                <span>{t(item.label)}</span>
              </button>
            )
          })}
        </nav>
        <details className="advanced-navigation">
          <summary>{t('nav.advanced')}</summary>
          <button type="button" onClick={() => { onNavigate('team'); close() }}><Users size={16} />{t('nav.team')}</button>
          <button type="button" onClick={() => { onNavigate('team'); close() }}><ShieldCheck size={16} />{t('nav.policies')}</button>
          <button type="button" onClick={() => { onNavigate('team'); close() }}><Boxes size={16} />{t('nav.templates')}</button>
          <button type="button" onClick={() => { onNavigate('assets'); close() }}><Bot size={16} />{t('nav.promptHub')}</button>
          <button type="button" onClick={() => { onNavigate('team'); close() }}><Activity size={16} />{t('nav.audit')}</button>
        </details>
        <div className="sidebar-bottom">
          <ThemeChooser />
          <label className="language-picker">
            <Languages size={15} aria-hidden="true" />
            <span>{t('common.language')}</span>
            <select aria-label={t('common.language')} value={locale} onChange={(event) => setLocale(event.target.value as typeof locale)}>
              {localeOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
            </select>
          </label>
          <div className="local-status">
            <span className="status-dot" />
            <div><strong>{t('nav.localMode')}</strong><span>{t('nav.dataStaysLocal')}</span></div>
          </div>
          <div className="profile local-workspace"><span className="avatar">LW</span><div><strong>{t('nav.localWorkspace')}</strong><span>{t('nav.noAccount')}</span></div></div>
        </div>
      </aside>
    </>
  )
}
