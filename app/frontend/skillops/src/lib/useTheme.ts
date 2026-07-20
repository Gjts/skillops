import { useCallback, useEffect, useState } from 'react'
import {
  getThemeOption,
  LEGACY_THEME_STORAGE_KEY,
  legacyThemeMap,
  SYSTEM_DARK_THEME,
  SYSTEM_LIGHT_THEME,
  THEME_STORAGE_KEY,
  themeIds,
  type Theme,
} from './themeCatalog'

export type { Theme } from './themeCatalog'
export { THEME_STORAGE_KEY } from './themeCatalog'

function isTheme(value: string | null | undefined): value is Theme {
  return Boolean(value && (themeIds as readonly string[]).includes(value))
}

function readStoredTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (isTheme(stored)) return stored

    const legacy = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)
    const migrated = legacy === 'light' || legacy === 'dark' ? legacyThemeMap[legacy] : null
    if (!migrated) return null

    window.localStorage.setItem(THEME_STORAGE_KEY, migrated)
    window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY)
    return migrated
  } catch {
    return null
  }
}

function preferredTheme(): Theme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return SYSTEM_LIGHT_THEME
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? SYSTEM_DARK_THEME : SYSTEM_LIGHT_THEME
}

function initialThemeState(): { theme: Theme; source: 'system' | 'user' } {
  if (typeof window === 'undefined') return { theme: SYSTEM_LIGHT_THEME, source: 'system' }
  const stored = readStoredTheme()
  if (stored) return { theme: stored, source: 'user' }
  const bootstrapped = document.documentElement.dataset.theme
  return { theme: isTheme(bootstrapped) ? bootstrapped : preferredTheme(), source: 'system' }
}

function applyTheme(theme: Theme) {
  const option = getThemeOption(theme)
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = option.scheme
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', option.metaColor)
}

export function useTheme() {
  const [state, setState] = useState(initialThemeState)

  useEffect(() => {
    applyTheme(state.theme)
    if (state.source === 'user') {
      try { window.localStorage.setItem(THEME_STORAGE_KEY, state.theme) } catch { /* Keep the in-memory theme when storage is unavailable. */ }
    }
  }, [state.source, state.theme])

  useEffect(() => {
    if (state.source !== 'system' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const syncWithSystem = (event: MediaQueryListEvent) => {
      setState({ theme: event.matches ? SYSTEM_DARK_THEME : SYSTEM_LIGHT_THEME, source: 'system' })
    }
    media.addEventListener?.('change', syncWithSystem)
    return () => media.removeEventListener?.('change', syncWithSystem)
  }, [state.source])

  const setTheme = useCallback((theme: Theme) => {
    setState({ theme, source: 'user' })
  }, [])

  return { theme: state.theme, setTheme }
}
