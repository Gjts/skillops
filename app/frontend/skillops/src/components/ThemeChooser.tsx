import {
  AlignLeft,
  Apple,
  AppWindow,
  Blocks,
  Box,
  Check,
  CircleDotDashed,
  CloudSun,
  DraftingCompass,
  Gauge,
  Gem,
  Grid3x3,
  Hammer,
  KeyRound,
  Layers,
  Leaf,
  MountainSnow,
  Network,
  Newspaper,
  Palette,
  PanelsTopLeft,
  Shapes,
  ShoppingBag,
  SquareTerminal,
  SunMedium,
  Terminal,
  Waves,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { getThemeOption, themeOptions, type Theme } from '../lib/themeCatalog'
import { useTheme } from '../lib/useTheme'

const themeIcons: Record<Theme, LucideIcon> = {
  synapse: Network,
  zenix: PanelsTopLeft,
  swiss: AlignLeft,
  lumina: Hammer,
  mosaic: Grid3x3,
  softly: CloudSun,
  nature: Leaf,
  blueprint: DraftingCompass,
  neumorphism: Layers,
  devtools: SquareTerminal,
  material: Shapes,
  apple: Apple,
  tesla: Gauge,
  carbon: Blocks,
  fluent: AppWindow,
  primer: KeyRound,
  polaris: ShoppingBag,
  bauhaus: CircleDotDashed,
  editorial: Newspaper,
  solarized: SunMedium,
  terminal: Terminal,
  vaporwave: Waves,
  cypherpunk: Gem,
  nordic: MountainSnow,
  clay: Box,
}

export function ThemeChooser() {
  const { t } = useI18n()
  const { theme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selectedThemeRef = useRef<HTMLButtonElement>(null)
  const currentTheme = getThemeOption(theme)
  const CurrentIcon = themeIcons[theme]

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return

    selectedThemeRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeAndRestoreFocus()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [closeAndRestoreFocus, open])

  return (
    <div className="theme-picker" ref={pickerRef}>
      <button
        ref={triggerRef}
        className="theme-toggle"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t('theme.choose')}: ${t(currentTheme.label)}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="theme-toggle-icon" aria-hidden="true"><CurrentIcon size={15} /></span>
        <span className="theme-toggle-copy"><span>{t('common.appearance')}</span><strong>{t(currentTheme.label)}</strong></span>
        <Palette size={15} aria-hidden="true" />
      </button>

      {open ? (
        <div ref={dialogRef} className="theme-popover" role="dialog" aria-modal="true" aria-label={t('theme.choose')}>
          <div className="theme-popover-header">
            <span className="theme-popover-heading"><Palette size={16} aria-hidden="true" /><span><strong>{t('theme.choose')}</strong><small>{t('theme.applies')}</small></span></span>
            <button className="theme-popover-close" type="button" aria-label={t('common.close')} onClick={closeAndRestoreFocus}><X size={15} /></button>
          </div>
          <div className="theme-grid">
            {themeOptions.map((option) => {
              const Icon = themeIcons[option.id]
              const selected = theme === option.id
              const previewStyle = {
                '--preview-bg': option.preview.background,
                '--preview-sidebar': option.preview.sidebar,
                '--preview-surface': option.preview.surface,
                '--preview-accent': option.preview.accent,
                '--preview-ink': option.preview.ink,
              } as CSSProperties
              return (
                <button
                  key={option.id}
                  ref={selected ? selectedThemeRef : undefined}
                  className={selected ? 'theme-option is-selected' : 'theme-option'}
                  style={previewStyle}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setTheme(option.id)}
                >
                  <span className={`theme-option-preview theme-option-preview--${option.id}`} aria-hidden="true">
                    <span className="theme-option-mini-rail" />
                    <span className="theme-option-mini-main">
                      <span className="theme-option-mini-header" />
                      <span className="theme-option-mini-panels"><i /><i /><i /></span>
                      <span className="theme-option-mini-table"><i /><i /><i /></span>
                    </span>
                    {selected ? <span className="theme-option-check"><Check size={9} strokeWidth={3} /></span> : null}
                  </span>
                  <span className="theme-option-label"><Icon size={13} strokeWidth={1.8} />{t(option.label)}</span>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}
