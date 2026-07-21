// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultAiSettings } from '../lib/ai-settings'
import { EvaluationWorkspace } from './EvaluationWorkspace'

const analysis = {
  candidate: {
    skillId: 'security-review',
    skillVersion: '2.0.0',
    description: 'Review code for security vulnerabilities.',
    headings: ['Security review'],
    sourceUrl: 'https://github.com/example/security-review',
    sourcePath: 'skills/security-review/SKILL.md',
    sha: 'abc123',
    contentHash: 'a'.repeat(64),
  },
  candidates: [
    { sourcePath: 'skills/security-review/SKILL.md', label: 'security-review', sha: 'abc123' },
    { sourcePath: 'skills/privacy-review/SKILL.md', label: 'privacy-review', sha: 'def456' },
  ],
  matches: [{
    skillId: 'security-scan',
    skillVersion: '1.0.0',
    description: 'Scan code for security vulnerabilities.',
    runtime: 'codex',
    source: 'global',
    sourcePath: 'C:\\skills\\security-scan\\SKILL.md',
    provider: 'Codex',
    similarity: 78,
    relationship: 'Likely update',
    sharedSignals: ['security', 'vulnerabilities'],
  }],
  recommendation: 'Treat security-scan as the baseline and run an A/B evaluation before replacing it.',
}

const evaluation = {
  id: 'eval-1',
  createdAt: '2026-07-20T12:00:00.000Z',
  mode: 'agent',
  winner: 'candidate',
  reason: 'The candidate found the higher-risk path and gave a concrete mitigation.',
  baseline: { skillId: 'security-scan', skillVersion: '1.0.0', score: 64, durationMs: 900, tokens: 120, output: 'Baseline output' },
  candidate: { skillId: 'security-review', skillVersion: '2.0.0', score: 91, durationMs: 1_100, tokens: 140, output: 'Candidate output' },
  judge: { tokens: 80, provider: 'gemini', model: 'gemini-3.5-flash' },
  privacy: 'Task text and generated answers were not written to disk by SkillOps.',
}

function mockApi(handlers: Record<string, (init?: RequestInit) => Promise<unknown> | unknown> = {}) {
  return vi.fn().mockImplementation((input: string, init?: RequestInit) => {
    if (input === '/api/ai-settings') {
      if (handlers['PUT /api/ai-settings'] && init?.method === 'PUT') {
        return Promise.resolve(handlers['PUT /api/ai-settings'](init))
      }
      if (handlers['GET /api/ai-settings']) return Promise.resolve(handlers['GET /api/ai-settings'](init))
      if (init?.method === 'PUT') {
        return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(String(init.body)) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => createDefaultAiSettings() })
    }
    if (input === '/api/evaluations/compare') {
      if (handlers['/api/evaluations/compare']) return Promise.resolve(handlers['/api/evaluations/compare'](init))
      return Promise.resolve({ ok: true, status: 200, json: async () => analysis })
    }
    if (input === '/api/evaluations/run') {
      if (handlers['/api/evaluations/run']) return Promise.resolve(handlers['/api/evaluations/run'](init))
      return Promise.resolve({ ok: true, status: 200, json: async () => evaluation })
    }
    if (input === '/api/assistant/chat') {
      if (handlers['/api/assistant/chat']) return Promise.resolve(handlers['/api/assistant/chat'](init))
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ message: 'Add a second task that stresses false-positive handling.' }) })
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) })
  })
}

beforeEach(() => {
  window.sessionStorage.clear()
  window.localStorage.clear()
  vi.stubGlobal('fetch', mockApi())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('EvaluationWorkspace', () => {
  it('replaces the empty workflow guide with the analyzed evaluation stages', async () => {
    render(<EvaluationWorkspace />)

    expect(screen.getByRole('region', { name: 'Evaluation workflow' })).toBeTruthy()
    expect(screen.getByText('Load one public Skill')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: /SkillOps assistant/ })).toBeNull()

    fireEvent.change(screen.getByRole('textbox', { name: 'Candidate GitHub URL' }), { target: { value: analysis.candidate.sourceUrl } })
    fireEvent.click(screen.getByRole('button', { name: 'Find matches' }))

    expect(await screen.findByRole('region', { name: 'Choose the baseline' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Evaluation workflow' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Run a controlled A/B task' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Explain overlap' }))

    const assistant = screen.getByRole('complementary', { name: /SkillOps assistant, Context: security-review/ })
    expect((within(assistant).getByRole('textbox', { name: 'Ask SkillOps' }) as HTMLTextAreaElement).value).toBe('Explain the overlap')
    fireEvent.click(within(assistant).getByRole('button', { name: 'Close SkillOps assistant' }))
    expect(screen.queryByRole('complementary', { name: /SkillOps assistant/ })).toBeNull()
  })

  it('keeps the baseline unselected until the user chooses it and labels its source path', async () => {
    render(<EvaluationWorkspace />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Candidate GitHub URL' }), { target: { value: analysis.candidate.sourceUrl } })
    fireEvent.click(screen.getByRole('button', { name: 'Find matches' }))

    expect(await screen.findByRole('region', { name: 'Choose the baseline' })).toBeTruthy()
    const baseline = screen.getByRole('radio', { name: /security-scan/ })
    expect(baseline.getAttribute('aria-checked')).toBe('false')
    expect(baseline.textContent).toContain('global')
    expect(baseline.textContent).toContain('C:\\skills\\security-scan\\SKILL.md')
    expect(screen.queryByRole('region', { name: 'Run a controlled A/B task' })).toBeNull()

    fireEvent.click(baseline)

    expect(baseline.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('region', { name: 'Run a controlled A/B task' })).toBeTruthy()
  })

  it('clears stale analysis and locks source controls while a new inspection is pending', async () => {
    const response = { ok: true, status: 200, json: async () => analysis }
    let compareCalls = 0
    let resolveCompare: (value: typeof response) => void = () => undefined
    const pendingCompare = new Promise<typeof response>((resolve) => { resolveCompare = resolve })
    vi.stubGlobal('fetch', mockApi({
      '/api/evaluations/compare': () => {
        compareCalls += 1
        return compareCalls === 1 ? response : pendingCompare
      },
    }))
    render(<EvaluationWorkspace />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Candidate GitHub URL' }), { target: { value: analysis.candidate.sourceUrl } })
    fireEvent.click(screen.getByRole('button', { name: 'Find matches' }))
    expect(await screen.findByRole('region', { name: 'Choose the baseline' })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /security-scan/ }))
    expect(screen.getByRole('region', { name: 'Run a controlled A/B task' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Find matches' }))

    expect(await screen.findByRole('button', { name: 'Inspecting…' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Candidate GitHub URL' }) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Inspecting…' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('region', { name: 'Choose the baseline' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Run a controlled A/B task' })).toBeNull()

    resolveCompare(response)
    expect(await screen.findByRole('region', { name: 'Choose the baseline' })).toBeTruthy()
  })

  it('locks semantic controls and clears stale results while an A/B request is pending', async () => {
    const runResponse = { ok: true, status: 200, json: async () => evaluation }
    let runCalls = 0
    let resolveRun: (value: typeof runResponse) => void = () => undefined
    const pendingRun = new Promise<typeof runResponse>((resolve) => { resolveRun = resolve })
    vi.stubGlobal('fetch', mockApi({
      '/api/evaluations/run': () => {
        runCalls += 1
        return runCalls === 1 ? runResponse : pendingRun
      },
    }))
    render(<EvaluationWorkspace />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Candidate GitHub URL' }), { target: { value: analysis.candidate.sourceUrl } })
    fireEvent.click(screen.getByRole('button', { name: 'Find matches' }))
    expect(await screen.findByRole('region', { name: 'Choose the baseline' })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /security-scan/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Evaluation task' }), { target: { value: 'Review the authentication flow.' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Acceptance criteria' }), { target: { value: 'Find the highest-risk path and give a concrete mitigation.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Configure AI' }))
    const dialog = screen.getByRole('dialog', { name: 'AI settings' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'OpenAI' }))
    fireEvent.change(within(dialog).getByPlaceholderText('Enter OpenAI API key'), { target: { value: 'session-secret' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Model' }), { target: { value: 'gpt-5.6-sol' } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Reasoning effort' }), { target: { value: 'none' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save settings' }))
    expect(await screen.findByRole('button', { name: /OpenAI · gpt-5\.6-sol/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Run A/B test' }))
    expect(await screen.findByText('Candidate wins')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Run A/B test' }))

    expect(await screen.findByRole('button', { name: 'Running A/B…' })).toBeTruthy()
    expect(screen.queryByText('Candidate wins')).toBeNull()
    expect((screen.getByRole('textbox', { name: 'Candidate GitHub URL' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('combobox', { name: 'Candidate Skill' }) as HTMLSelectElement).disabled).toBe(true)
    expect(screen.getByRole('radio', { name: /security-scan/ }).hasAttribute('disabled')).toBe(true)
    expect((screen.getByRole('textbox', { name: 'Evaluation task' }) as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByRole('textbox', { name: 'Acceptance criteria' }) as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.getByRole('radio', { name: /Prompt-only comparison/ }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: /OpenAI · gpt-5\.6-sol/ }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Running A/B…' }).hasAttribute('disabled')).toBe(true)

    resolveRun(runResponse)
    expect(await screen.findByText('Candidate wins')).toBeTruthy()
  })

  it('opens chat on demand and restores focus when Escape closes the drawer', () => {
    render(<EvaluationWorkspace />)
    const trigger = screen.getByRole('button', { name: 'Ask SkillOps' })

    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByRole('complementary', { name: 'SkillOps assistant, Waiting for a candidate' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close SkillOps assistant' }))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: /SkillOps assistant/ })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('docks the assistant beside the workspace and resizes both panes together', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
    const { container } = render(<EvaluationWorkspace />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask SkillOps' }))

    const shell = container.querySelector('.evaluation-workspace-shell')
    const panel = screen.getByRole('complementary', { name: 'SkillOps assistant, Waiting for a candidate' })
    expect(shell?.className).toContain('assistant-open')
    expect(panel.parentElement).toBe(shell)

    const before = Number.parseInt(panel.style.getPropertyValue('--assistant-drawer-width') || '420', 10)
    const handle = screen.getByRole('button', { name: 'Resize SkillOps assistant' })
    fireEvent.pointerDown(handle, { button: 0, clientX: 1000, pointerId: 1 })
    fireEvent(window, new PointerEvent('pointermove', { clientX: 700, bubbles: true }))
    fireEvent(window, new PointerEvent('pointerup', { clientX: 700, bubbles: true }))

    const after = Number.parseInt(panel.style.getPropertyValue('--assistant-drawer-width') || '0', 10)
    expect(after).toBeGreaterThan(before)
    expect(window.localStorage.getItem('skillops.assistant-drawer.width.v1')).toBe(String(after))
  })

  it('analyzes a candidate, configures a session provider, runs A/B, and chats about the result', async () => {
    render(<EvaluationWorkspace />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Candidate GitHub URL' }), { target: { value: analysis.candidate.sourceUrl } })
    fireEvent.click(screen.getByRole('button', { name: 'Find matches' }))

    expect(await screen.findByText('security-review')).toBeTruthy()
    const baseline = screen.getByRole('radio', { name: /security-scan/ })
    expect(baseline.getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('region', { name: 'Run a controlled A/B task' })).toBeNull()
    fireEvent.click(baseline)
    expect(baseline.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('region', { name: 'Run a controlled A/B task' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Evaluation task' }), { target: { value: 'Review the authentication flow.' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Acceptance criteria' }), { target: { value: 'Find the highest-risk path and give a concrete mitigation.' } })
    fireEvent.click(screen.getByRole('radio', { name: /Read-only workspace agent/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Run A/B test' }))

    const dialog = screen.getByRole('dialog', { name: 'AI settings' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'OpenAI' }))
    fireEvent.change(within(dialog).getByPlaceholderText('Enter OpenAI API key'), { target: { value: 'session-secret' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Model' }), { target: { value: 'gpt-5.6-sol' } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Reasoning effort' }), { target: { value: 'none' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save settings' }))
    expect(await screen.findByRole('button', { name: /OpenAI · gpt-5\.6-sol/ })).toBeTruthy()

    const fetchMock = vi.mocked(fetch)
    expect(fetchMock).toHaveBeenCalledWith('/api/ai-settings', expect.objectContaining({ method: 'PUT' }))
    const putRequest = fetchMock.mock.calls.find(([url, init]) => url === '/api/ai-settings' && init?.method === 'PUT')?.[1]
    expect(JSON.parse(String(putRequest?.body))).toEqual(expect.objectContaining({
      activeProvider: 'openai',
      providers: expect.objectContaining({
        openai: expect.objectContaining({ apiKey: 'session-secret', model: 'gpt-5.6-sol', reasoningEffort: 'none' }),
      }),
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Run A/B test' }))
    expect(await screen.findByText('Candidate wins')).toBeTruthy()
    expect(screen.getByText('91')).toBeTruthy()
    expect(screen.getByText(/higher-risk path/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Discuss result' }))
    const assistant = screen.getByRole('complementary', { name: /SkillOps assistant, Context: security-review/ })
    fireEvent.click(within(assistant).getByRole('button', { name: 'What should I test next?' }))
    fireEvent.click(within(assistant).getByRole('button', { name: 'Send message' }))
    expect(await screen.findByText(/false-positive handling/)).toBeTruthy()

    expect(fetchMock).toHaveBeenCalledWith('/api/evaluations/run', expect.objectContaining({ method: 'POST' }))
    const runRequest = fetchMock.mock.calls.find(([input]) => input === '/api/evaluations/run')?.[1]
    expect(JSON.parse(String(runRequest?.body))).toEqual(expect.objectContaining({
      candidateContentHash: 'a'.repeat(64),
      mode: 'agent',
      provider: expect.objectContaining({ model: 'gpt-5.6-sol', reasoningEffort: 'none' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/assistant/chat', expect.objectContaining({ method: 'POST' }))
  })

  it('blocks GPT-5.6 agent runs until reasoning effort is None', async () => {
    render(<EvaluationWorkspace />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Candidate GitHub URL' }), { target: { value: analysis.candidate.sourceUrl } })
    fireEvent.click(screen.getByRole('button', { name: 'Find matches' }))

    expect(await screen.findByText('security-review')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /security-scan/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Evaluation task' }), { target: { value: 'Review the authentication flow.' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Acceptance criteria' }), { target: { value: 'Give a concrete mitigation.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Configure AI' }))

    const dialog = screen.getByRole('dialog', { name: 'AI settings' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'OpenAI' }))
    fireEvent.change(within(dialog).getByPlaceholderText('Enter OpenAI API key'), { target: { value: 'session-secret' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Model' }), { target: { value: 'gpt-5.6-sol' } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Reasoning effort' }), { target: { value: 'medium' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save settings' }))
    expect(await screen.findByRole('button', { name: /OpenAI · gpt-5\.6-sol/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /Read-only workspace agent/ }))

    expect(screen.getByRole('alert').textContent).toContain('reasoning effort None')
    expect(screen.getByRole('button', { name: 'Run A/B test' }).hasAttribute('disabled')).toBe(true)
  })

  it('restores saved AI settings from the local API on mount', async () => {
    const restored = createDefaultAiSettings()
    restored.activeProvider = 'openai'
    restored.providers.openai = {
      apiKey: 'restored-secret',
      model: 'gpt-restored',
      baseUrl: 'https://api.openai.com/v1',
      reasoningEffort: 'none',
    }
    vi.stubGlobal('fetch', mockApi({
      'GET /api/ai-settings': () => ({ ok: true, status: 200, json: async () => restored }),
    }))

    render(<EvaluationWorkspace />)
    expect(await screen.findByRole('button', { name: /OpenAI · gpt-restored/ })).toBeTruthy()
  })

  it('keeps the settings dialog open when persistence fails', async () => {
    vi.stubGlobal('fetch', mockApi({
      'PUT /api/ai-settings': () => ({ ok: false, status: 500, json: async () => ({ error: 'Disk unavailable' }) }),
    }))

    render(<EvaluationWorkspace />)
    fireEvent.click(await screen.findByRole('button', { name: 'Configure AI' }))
    const dialog = screen.getByRole('dialog', { name: 'AI settings' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'OpenAI' }))
    fireEvent.change(within(dialog).getByPlaceholderText('Enter OpenAI API key'), { target: { value: 'new-secret' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save settings' }))

    expect(await screen.findByText(/Disk unavailable/)).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'AI settings' })).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Configure AI' }).textContent).not.toContain('OpenAI')
    })
  })
})
