import {
  Activity,
  Boxes,
  Braces,
  ChartNoAxesCombined,
  ChevronRight,
  CircleGauge,
  Menu,
  Settings,
  X,
} from 'lucide-react'
import type { PageId } from '../types'

const navigation: Array<{ id: PageId; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: 'Overview', icon: CircleGauge },
  { id: 'skills', label: 'Skills', icon: Braces },
  { id: 'runs', label: 'Runs', icon: Activity },
  { id: 'evaluations', label: 'Evaluation preview', icon: ChartNoAxesCombined },
  { id: 'registry', label: 'Registry', icon: Boxes },
  { id: 'settings', label: 'Settings', icon: Settings },
]

interface SidebarProps {
  page: PageId
  open: boolean
  onNavigate: (page: PageId) => void
  onToggle: () => void
  onClose: () => void
}

export function Sidebar({ page, open, onNavigate, onToggle, onClose }: SidebarProps) {
  return (
    <>
      <button className="mobile-menu" type="button" onClick={onToggle} aria-label="Toggle navigation">
        {open ? <X size={19} /> : <Menu size={19} />}
      </button>
      {open && <button className="sidebar-scrim" type="button" aria-label="Close navigation" onClick={onClose} />}
      <aside className={`sidebar ${open ? 'is-open' : ''}`}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><ChevronRight size={21} /><span /></span>
          <span>SkillOps</span>
        </div>
        <nav className="navigation" aria-label="Main navigation">
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
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-status">
            <span className="status-dot" />
            <div><strong>Local mode</strong><span>Data stays on this machine</span></div>
          </div>
          <div className="profile local-workspace"><span className="avatar">LW</span><div><strong>Local workspace</strong><span>No account required</span></div></div>
        </div>
      </aside>
    </>
  )
}
