import {
  Activity,
  Boxes,
  Braces,
  ChartNoAxesCombined,
  ChevronRight,
  CircleGauge,
  Languages,
  Menu,
  Moon,
  Settings,
  Sun,
  X,
} from 'lucide-react'
import { useI18n } from '../i18n/I18nProvider'
import { localeOptions, type MessageKey } from '../i18n/messages'
import { useTheme } from '../lib/useTheme'
import type { PageId } from '../types'

const navigation: Array<{ id: PageId; label: MessageKey; icon: typeof Activity }> = [
  { id: 'overview', label: 'nav.overview', icon: CircleGauge },
  { id: 'skills', label: 'nav.skills', icon: Braces },
  { id: 'runs', label: 'nav.runs', icon: Activity },
  { id: 'evaluations', label: 'nav.evaluations', icon: ChartNoAxesCombined },
  { id: 'registry', label: 'nav.registry', icon: Boxes },
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
  const { theme, toggleTheme } = useTheme()
  const nextThemeLabel = theme === 'dark' ? t('common.switchToLight') : t('common.switchToDark')
  return (
    <>
      <button className="mobile-menu" type="button" onClick={onToggle} aria-label={t('nav.toggle')}>
        {open ? <X size={19} /> : <Menu size={19} />}
      </button>
      {open && <button className="sidebar-scrim" type="button" aria-label={t('nav.close')} onClick={onClose} />}
      <aside className={`sidebar ${open ? 'is-open' : ''}`}>
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
                onClick={() => { onNavigate(item.id); onClose() }}
              >
                <Icon size={18} strokeWidth={1.7} />
                <span>{t(item.label)}</span>
              </button>
            )
          })}
        </nav>
        <div className="sidebar-bottom">
          <button className="theme-toggle" type="button" onClick={toggleTheme} aria-label={nextThemeLabel} title={nextThemeLabel}>
            <span className="theme-toggle-icon" aria-hidden="true">{theme === 'dark' ? <Moon size={15} /> : <Sun size={15} />}</span>
            <span className="theme-toggle-copy"><span>{t('common.appearance')}</span><strong>{theme === 'dark' ? t('common.darkMode') : t('common.lightMode')}</strong></span>
            <span className="theme-toggle-track" aria-hidden="true"><span /></span>
          </button>
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
