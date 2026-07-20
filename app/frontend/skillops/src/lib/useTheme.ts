import { useCallback, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'skillops.theme.v1'

const themeColor: Record<Theme, string> = {
  light: '#f3f6f7',
  dark: '#070b0e',
}

function isTheme(value: string | null | undefined): value is Theme {
  return value === 'light' || value === 'dark'
}

function readStoredTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isTheme(stored) ? stored : null
  } catch {
    return null
  }
}

function preferredTheme(): Theme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function initialThemeState(): { theme: Theme; source: 'system' | 'user' } {
  if (typeof window === 'undefined') return { theme: 'light', source: 'system' }
  const stored = readStoredTheme()
  if (stored) return { theme: stored, source: 'user' }
  const bootstrapped = document.documentElement.dataset.theme
  return { theme: isTheme(bootstrapped) ? bootstrapped : preferredTheme(), source: 'system' }
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', themeColor[theme])
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
      setState({ theme: event.matches ? 'dark' : 'light', source: 'system' })
    }
    media.addEventListener?.('change', syncWithSystem)
    return () => media.removeEventListener?.('change', syncWithSystem)
  }, [state.source])

  const toggleTheme = useCallback(() => {
    setState((current) => ({ theme: current.theme === 'dark' ? 'light' : 'dark', source: 'user' }))
  }, [])

  return { theme: state.theme, toggleTheme }
}
