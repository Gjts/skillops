/// <reference types="node" />
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../components/Sidebar'
import { I18nProvider } from '../i18n/I18nProvider'
import { THEME_STORAGE_KEY } from './useTheme'

const styles = readFileSync('app/frontend/skillops/src/styles.css', 'utf8')

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
  it('uses an action name without exposing a conflicting pressed state', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    render(
      <I18nProvider>
        <Sidebar page="overview" open={false} onNavigate={vi.fn()} onToggle={vi.fn()} onClose={vi.fn()} />
      </I18nProvider>,
    )

    const switchToDark = screen.getByRole('button', { name: 'Switch to dark mode' })
    expect(switchToDark.hasAttribute('aria-pressed')).toBe(false)

    fireEvent.click(switchToDark)
    const switchToLight = screen.getByRole('button', { name: 'Switch to light mode' })
    expect(switchToLight.hasAttribute('aria-pressed')).toBe(false)
  })

  it.each([
    ['light', ':root {'],
    ['dark', ":root[data-theme='dark'] {"],
  ])('keeps %s subtle text above WCAG AA contrast on its theme surfaces', (_theme, selector) => {
    const palette = themeBlock(selector)
    const subtle = hexToken(palette, '--subtle')

    for (const backgroundToken of ['--bg', '--surface', '--control-bg']) {
      expect(contrastRatio(subtle, hexToken(palette, backgroundToken))).toBeGreaterThanOrEqual(4.5)
    }
  })
})
