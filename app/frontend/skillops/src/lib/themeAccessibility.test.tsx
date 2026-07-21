/// <reference types="node" />
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../components/Sidebar'
import { I18nProvider } from '../i18n/I18nProvider'
import { themeOptions } from './themeCatalog'
import { THEME_STORAGE_KEY } from './useTheme'

const styles = readFileSync('app/frontend/skillops/src/styles.css', 'utf8')
const themeCases = themeOptions.map(({ id }) => [id, `:root[data-theme='${id}'] {`] as const)

function themeBlock(selector: string) {
  const start = styles.indexOf(selector)
  const openingBrace = styles.indexOf('{', start)
  const closingBrace = styles.indexOf('}', openingBrace)
  return styles.slice(openingBrace + 1, closingBrace)
}

function hexToken(block: string, token: string) {
  const value = block.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1]
  if (!value) throw new Error(`Missing ${token} in theme palette`)
  return value
}

function relativeLuminance(hex: string) {
  const channels = hex.slice(1).match(/../g)?.map((value) => Number.parseInt(value, 16) / 255) ?? []
  const [red, green, blue] = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ))
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrastRatio(foreground: string, background: string) {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (light + 0.05) / (dark + 0.05)
}

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.style.colorScheme = ''
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('theme accessibility', () => {
  it('publishes 25 unique product-wide themes', () => {
    expect(themeOptions).toHaveLength(25)
    expect(new Set(themeOptions.map(({ id }) => id)).size).toBe(themeOptions.length)
  })

  it('opens the theme chooser and applies the selected palette across SkillOps', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'devtools')
    render(
      <I18nProvider>
        <Sidebar page="overview" open={false} onNavigate={vi.fn()} onToggle={vi.fn()} onClose={vi.fn()} />
      </I18nProvider>,
    )

    const chooser = screen.getByRole('button', { name: 'Choose a theme: DevTools system' })
    expect(chooser.hasAttribute('aria-pressed')).toBe(false)
    fireEvent.click(chooser)

    const dialog = screen.getByRole('dialog', { name: 'Choose a theme' })
    expect(dialog.querySelectorAll('button[aria-pressed]').length).toBe(themeOptions.length)

    const devtools = screen.getByRole('button', { name: 'DevTools system' })
    expect(document.activeElement).toBe(devtools)

    const close = screen.getByRole('button', { name: 'Close' })
    close.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Clay studio' }))
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(close)

    const blueprint = screen.getByRole('button', { name: 'Blueprint' })
    fireEvent.click(blueprint)
    expect(blueprint.getAttribute('aria-pressed')).toBe('true')
    expect(document.documentElement.dataset.theme).toBe('blueprint')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('blueprint')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Choose a theme' })).toBeNull()
    expect(document.activeElement).toBe(chooser)
  })

  it('restores focus to the chooser when the close button dismisses the dialog', () => {
    render(
      <I18nProvider>
        <Sidebar page="overview" open={false} onNavigate={vi.fn()} onToggle={vi.fn()} onClose={vi.fn()} />
      </I18nProvider>,
    )

    const chooser = screen.getByRole('button', { name: 'Choose a theme: DevTools system' })
    fireEvent.click(chooser)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(screen.queryByRole('dialog', { name: 'Choose a theme' })).toBeNull()
    expect(document.activeElement).toBe(chooser)
  })

  it.each(themeCases)('keeps %s subtle text above WCAG AA contrast on its theme surfaces', (_theme, selector) => {
    const palette = themeBlock(selector)
    const subtle = hexToken(palette, '--subtle')

    for (const backgroundToken of ['--bg', '--surface', '--control-bg']) {
      expect(contrastRatio(subtle, hexToken(palette, backgroundToken))).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(themeCases)('keeps %s sidebar copy and status colors readable', (_theme, selector) => {
    const palette = themeBlock(selector)
    const sidebar = hexToken(palette, '--sidebar-contrast-bg')

    for (const foregroundToken of ['--sidebar-text', '--sidebar-muted', '--sidebar-success']) {
      expect(contrastRatio(hexToken(palette, foregroundToken), sidebar)).toBeGreaterThanOrEqual(4.5)
    }
    for (const nonTextToken of ['--sidebar-accent', '--sidebar-focus']) {
      expect(contrastRatio(hexToken(palette, nonTextToken), sidebar)).toBeGreaterThanOrEqual(3)
    }
  })

  it('resets every themed sidebar width before positioning the chooser on narrow screens', () => {
    expect(styles).toMatch(/@media \(max-width: 920px\)\s*{\s*:root,\s*:root\[data-theme\]\s*{\s*--sidebar-width:\s*0px;/)
  })

  it('keeps keyboard focus visible, managed views responsive, and reduced motion bounded', () => {
    expect(styles).toMatch(/button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, tr:focus-visible\s*{[^}]*outline:\s*2px solid var\(--accent\)/)
    expect(styles).toMatch(/@media \(max-width: 900px\)\s*{[^}]*\.managed-suite-grid\s*{\s*grid-template-columns:\s*1fr;/s)
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*{\s*\*, \*::before, \*::after\s*{[^}]*animation-duration:\s*\.01ms !important;/s)
  })
})
