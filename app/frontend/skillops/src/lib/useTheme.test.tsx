// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { THEME_STORAGE_KEY, useTheme } from './useTheme'

function ThemeProbe() {
  const { theme, setTheme } = useTheme()
  return <button type="button" onClick={() => setTheme('blueprint')}>{theme}</button>
}

function stubSystemTheme(dark: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.style.colorScheme = ''
  document.head.innerHTML = '<meta name="theme-color" content="#070b0e">'
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useTheme', () => {
  it('uses the operating-system preference until the user chooses a theme', () => {
    stubSystemTheme(true)
    render(<ThemeProbe />)

    expect(screen.getByRole('button', { name: 'synapse' })).toBeTruthy()
    expect(document.documentElement.dataset.theme).toBe('synapse')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
  })

  it('restores and persists a manual theme choice across the full catalog', () => {
    stubSystemTheme(true)
    window.localStorage.setItem(THEME_STORAGE_KEY, 'softly')
    render(<ThemeProbe />)

    const toggle = screen.getByRole('button', { name: 'softly' })
    expect(document.documentElement.dataset.theme).toBe('softly')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'blueprint' })).toBeTruthy()
    expect(document.documentElement.dataset.theme).toBe('blueprint')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('blueprint')
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('#003366')
  })

  it.each([
    ['light', 'devtools', true],
    ['dark', 'synapse', false],
  ])('migrates the legacy %s preference before applying the system default', (legacyTheme, expectedTheme, systemDark) => {
    stubSystemTheme(systemDark)
    window.localStorage.setItem('skillops.theme.v1', legacyTheme)

    render(<ThemeProbe />)

    expect(document.documentElement.dataset.theme).toBe(expectedTheme)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(expectedTheme)
    expect(window.localStorage.getItem('skillops.theme.v1')).toBeNull()
  })
})
