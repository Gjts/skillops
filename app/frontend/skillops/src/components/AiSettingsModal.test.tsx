// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n/I18nProvider'
import { createDefaultAiSettings } from '../lib/ai-settings'
import { AiSettingsModal } from './AiSettingsModal'

afterEach(cleanup)

function settingsWithKey() {
  const settings = createDefaultAiSettings()
  settings.activeProvider = 'openai'
  settings.providers.openai.apiKey = 'sk-private-value'
  return settings
}

describe('AiSettingsModal', () => {
  it('never renders a saved credential and preserves it when unchanged', () => {
    const onSave = vi.fn()
    render(<I18nProvider><AiSettingsModal open settings={settingsWithKey()} onClose={vi.fn()} onSave={onSave} /></I18nProvider>)

    const key = screen.getByLabelText('API key') as HTMLInputElement
    expect(key.value).toBe('••••••••')
    fireEvent.click(screen.getByRole('button', { name: 'Show API key' }))
    expect(key.value).toBe('••••••••')
    expect(document.body.textContent).not.toContain('sk-private-value')

    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(onSave.mock.calls[0][0].providers.openai.apiKey).toBe('sk-private-value')
  })

  it('saves an explicitly replaced credential', () => {
    const onSave = vi.fn()
    render(<I18nProvider><AiSettingsModal open settings={settingsWithKey()} onClose={vi.fn()} onSave={onSave} /></I18nProvider>)

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-replacement' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))

    expect(onSave.mock.calls[0][0].providers.openai.apiKey).toBe('sk-replacement')
  })
})
