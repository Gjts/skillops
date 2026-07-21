// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { KpiStrip } from '../components/KpiStrip'
import { I18nProvider, useI18n } from './I18nProvider'
import { localeOptions, messages } from './messages'

function LanguageProbe() {
  const { locale, setLocale, t } = useI18n()
  return (
    <label>
      {t('common.language')}
      <select aria-label={t('common.language')} value={locale} onChange={(event) => setLocale(event.target.value as typeof locale)}>
        {localeOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
      </select>
    </label>
  )
}

function DateTimeProbe() {
  const { formatDateTime } = useI18n()
  return <output data-testid="date-time">{formatDateTime('2026-07-19T12:34:00.000Z')}</output>
}

beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [], headers: new Headers() }))
})

afterEach(() => {
  cleanup()
  document.documentElement.lang = 'en'
  document.documentElement.dir = 'ltr'
  vi.unstubAllGlobals()
})

describe('SkillOps internationalization', () => {
  it('ships every message in all six supported languages', () => {
    expect(localeOptions.map((option) => option.code)).toEqual(['zh', 'en', 'fr', 'ru', 'es', 'ja'])
    expect(localeOptions.map((option) => option.label)).toEqual(['中文', 'English', 'Français', 'Русский', 'Español', '日本語'])
    for (const translations of Object.values(messages)) {
      expect(Object.keys(translations).sort()).toEqual(['en', 'es', 'fr', 'ja', 'ru', 'zh'])
      expect(Object.values(translations).every((message) => message.trim().length > 0)).toBe(true)
    }
  })

  it('keeps the English registry duplicate and conflict explanatory copy stable', () => {
    expect(messages['registry.conflictNote'].en).toBe('enabled definitions with the same runtime and name but different content hashes; historical rows without hashes use different exact versions')
    expect(messages['registry.duplicateNote'].en).toBe('enabled definitions with the same runtime, name, and content hash; historical rows without hashes use the same exact version')
  })

  it('restores the saved language and persists later changes', () => {
    window.localStorage.setItem('skillops.locale.v1', 'zh')
    render(<I18nProvider><LanguageProbe /></I18nProvider>)

    expect(screen.getByLabelText('语言')).toBeTruthy()
    expect(document.documentElement.lang).toBe('zh-Hans')
    expect(document.documentElement.dir).toBe('ltr')

    fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'fr' } })
    expect(screen.getByLabelText('Langue')).toBeTruthy()
    expect(window.localStorage.getItem('skillops.locale.v1')).toBe('fr')
    expect(document.documentElement.lang).toBe('fr')
    expect(document.documentElement.dir).toBe('ltr')
  })

  it('falls back to English when a removed language was saved', () => {
    window.localStorage.setItem('skillops.locale.v1', 'ar')
    render(<I18nProvider><LanguageProbe /></I18nProvider>)

    expect(screen.getByLabelText('Language')).toBeTruthy()
    expect(window.localStorage.getItem('skillops.locale.v1')).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(document.documentElement.dir).toBe('ltr')
  })

  it('formats a complete localized date and time', () => {
    window.localStorage.setItem('skillops.locale.v1', 'en')
    render(<I18nProvider><DateTimeProbe /></I18nProvider>)

    const expected = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })
      .format(new Date('2026-07-19T12:34:00.000Z'))
    expect(screen.getByTestId('date-time').textContent).toBe(expected)
  })

  it('translates the complete application shell immediately', async () => {
    window.localStorage.setItem('skillops.locale.v1', 'en')
    render(<I18nProvider><App /></I18nProvider>)

    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ja' } })
    expect(screen.getByRole('heading', { level: 1, name: '概要' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '設定' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'どのランタイムからの Skill 実行はありません' })).toBeTruthy()
    expect(document.documentElement.lang).toBe('ja')
  })

  it('retranslates import feedback and the live Skill Lab mode', async () => {
    window.localStorage.setItem('skillops.locale.v1', 'en')
    window.history.replaceState({}, '', '/runs')
    let stored: object[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === '/api/import' && init?.method === 'POST') {
        stored = JSON.parse(String(init.body))
        return Promise.resolve({ ok: true, json: async () => ({ importedCount: stored.length }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => input === '/api/events' ? stored : [], headers: new Headers() })
    }))
    const { container } = render(<I18nProvider><App /></I18nProvider>)
    const file = new File([JSON.stringify([{ id: 'translated-import', event: 'skill.completed', skillId: 'translated-skill', runtime: 'codex', timestamp: new Date().toISOString(), outcome: 'success' }])], 'events.json', { type: 'application/json' })
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } })

    expect((await screen.findByRole('status')).textContent).toBe('Imported 1 new event into the local event store.')
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ja' } })
    expect(screen.getByRole('status').textContent).toBe('新しいイベント1件をローカルイベントストアにインポートしました。')

    fireEvent.change(screen.getByLabelText('言語'), { target: { value: 'fr' } })
    fireEvent.click(screen.getByRole('button', { name: 'Skill Lab' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Skill Lab' })).toBeTruthy()
    expect(screen.getByText('Évaluation en direct')).toBeTruthy()
  })

  it('localizes validation errors, demo KPI values, and synthetic project providers', async () => {
    window.localStorage.setItem('skillops.locale.v1', 'zh')
    window.history.replaceState({}, '', '/runs')
    const scan = [{ skillId: 'project-fallback', skillVersion: '1.0.0', runtime: 'codex', source: 'project', sourcePath: '/repo/.codex/skills/project-fallback/SKILL.md', kind: 'skill', enabled: true }]
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => input === '/api/scan' ? scan : [],
      headers: new Headers(),
    })))
    const { container } = render(<I18nProvider><App /></I18nProvider>)
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File([], 'empty.json')] } })
    expect((await screen.findByRole('alert')).textContent).toBe('导入失败：所选事件文件为空。')

    fireEvent.click(screen.getByRole('button', { name: '注册表' }))
    const row = (await screen.findByText('project-fallback')).closest('tr') as HTMLElement
    expect(within(row).getAllByText('项目')).toHaveLength(2)
    expect(within(row).queryByText('Project')).toBeNull()

    cleanup()
    window.localStorage.setItem('skillops.locale.v1', 'fr')
    render(<I18nProvider><KpiStrip runs={10} successRate={90} lifecycleOnly={false} evaluatedRuns={9} outcomeCoverage={90} activeSkills={2} cost={1.25} costReportedRuns={10} mode="demo" /></I18nProvider>)
    expect(screen.getByText(/12,7%/)).toBeTruthy()
    expect(screen.getByText(/3,4 pt/)).toBeTruthy()
    expect(screen.getByText(/7,6%/)).toBeTruthy()
  })
})
