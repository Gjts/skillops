// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { THEME_STORAGE_KEY, useTheme } from './useTheme'

function ThemeProbe() {
  const { theme, toggleTheme } = useTheme()
  return <button type="button" onClick={toggleTheme}>{theme}</button>
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

    expect(screen.getByRole('button', { name: 'dark' })).toBeTruthy()
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
  })

  it('restores and persists the manual theme choice', () => {
    stubSystemTheme(true)
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    render(<ThemeProbe />)

    const toggle = screen.getByRole('button', { name: 'light' })
    expect(document.documentElement.dataset.theme).toBe('light')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'dark' })).toBeTruthy()
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('#070b0e')
  })
})
