import {
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  Circle,
  FlaskConical,
  GitCompareArrows,
  GitFork,
  LoaderCircle,
  LockKeyhole,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { activeProviderRequest, AI_PROVIDERS, createDefaultAiSettings, providerIsConfigured, type AiSettings } from '../lib/ai-settings'
import { AiSettingsModal } from './AiSettingsModal'
import { SkillOpsAssistantDrawer, type AssistantMessage } from './SkillOpsAssistantDrawer'

interface CandidateRef {
  sourcePath: string
  sha?: string
  label: string
}

interface CandidateSummary {
  skillId: string
  skillVersion: string
  description?: string
  headings: string[]
  sourceUrl: string
  sourcePath: string
  sha?: string
  contentHash: string
}

interface SkillMatch {
  skillId: string
  skillVersion: string
  description?: string
  runtime: string
  source: string
  sourcePath: string
  provider: string
  similarity: number
  relationship: string
  sharedSignals: string[]
}

interface CandidateAnalysis {
  candidate: CandidateSummary
  candidates: CandidateRef[]
  matches: SkillMatch[]
  recommendation: string
}

interface EvaluationVariant {
  skillId: string
  skillVersion: string
  score: number
  durationMs: number
  tokens: number
  output: string
}

interface EvaluationResult {
  id: string
  createdAt: string
  mode: 'prompt-only' | 'agent'
  winner: 'baseline' | 'candidate' | 'tie'
  reason: string
  baseline: EvaluationVariant
  candidate: EvaluationVariant
  judge: { tokens: number; provider: string; model: string }
  privacy: string
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const result = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(result.error || `Local API returned ${response.status}.`)
  return result
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  return readJson<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function formatDuration(value: number) {
  if (value < 1_000) return `${value}ms`
  return `${(value / 1_000).toFixed(1)}s`
}

export function EvaluationWorkspace() {
  const [sourceUrl, setSourceUrl] = useState('')
  const [analysis, setAnalysis] = useState<CandidateAnalysis | null>(null)
  const [baselineSourcePath, setBaselineSourcePath] = useState('')
  const [task, setTask] = useState('')
  const [criteria, setCriteria] = useState('')
  const [evaluationMode, setEvaluationMode] = useState<'prompt-only' | 'agent'>('prompt-only')
  const [evaluation, setEvaluation] = useState<EvaluationResult | null>(null)
  const [settings, setSettings] = useState<AiSettings>(createDefaultAiSettings)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chatInput, setChatInput] = useState('')
  const [chatting, setChatting] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [messages, setMessages] = useState<AssistantMessage[]>([
    { id: 'welcome', role: 'assistant', localOnly: true, content: 'Paste a public GitHub Skill URL. I can help you interpret its nearest local match and the A/B result without changing any installed Skill.' },
  ])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const loaded = await readJson<AiSettings>('/api/ai-settings')
        if (!cancelled) setSettings(loaded)
      } catch {
        // Keep in-memory defaults when local settings are unavailable.
      }
    })()
    return () => { cancelled = true }
  }, [])

  const providerDefinition = AI_PROVIDERS.find((provider) => provider.id === settings.activeProvider)!
  const activeProvider = settings.providers[settings.activeProvider]
  const busy = analyzing || running
  const selectedMatch = useMemo(() => analysis?.matches.find((match) => match.sourcePath === baselineSourcePath), [analysis, baselineSourcePath])
  const readyForEvaluation = Boolean(analysis && selectedMatch && task.trim() && criteria.trim())
  const agentReasoningConflict = evaluationMode === 'agent'
    && /^gpt-5\.6(?:-|$)/i.test(activeProvider.model.trim())
    && activeProvider.reasoningEffort !== 'none'

  const inspectCandidate = async (candidatePath?: string) => {
    if (!sourceUrl.trim() || busy) return
    setAnalyzing(true)
    setError(null)
    setAnalysis(null)
    setBaselineSourcePath('')
    setEvaluation(null)
    try {
      const result = await postJson<CandidateAnalysis>('/api/evaluations/compare', { sourceUrl: sourceUrl.trim(), candidatePath })
      setAnalysis(result)
      setBaselineSourcePath('')
    } catch (problem) {
      setAnalysis(null)
      setBaselineSourcePath('')
      setError(problem instanceof Error ? problem.message : 'Candidate analysis failed.')
    } finally {
      setAnalyzing(false)
    }
  }

  const runEvaluation = async () => {
    if (!analysis || !selectedMatch || !readyForEvaluation || busy) return
    if (agentReasoningConflict) {
      setSettingsOpen(true)
      return
    }
    if (!providerIsConfigured(settings)) {
      setSettingsOpen(true)
      return
    }
    setRunning(true)
    setError(null)
    setEvaluation(null)
    try {
      const result = await postJson<EvaluationResult>('/api/evaluations/run', {
        sourceUrl: analysis.candidate.sourceUrl,
        candidatePath: analysis.candidate.sourcePath,
        candidateContentHash: analysis.candidate.contentHash,
        baselineSourcePath: selectedMatch.sourcePath,
        mode: evaluationMode,
        task: task.trim(),
        criteria: criteria.trim(),
        provider: activeProviderRequest(settings),
      })
      setEvaluation(result)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'A/B evaluation failed.')
    } finally {
      setRunning(false)
    }
  }

  const sendChat = async () => {
    const content = chatInput.trim()
    if (!content || chatting) return
    if (!providerIsConfigured(settings)) {
      setAssistantOpen(false)
      setSettingsOpen(true)
      return
    }
    const userMessage: AssistantMessage = { id: `user-${Date.now()}`, role: 'user', content }
    const conversation = [...messages.filter((message) => !message.localOnly), userMessage].slice(-24)
    setMessages((current) => [...current, userMessage])
    setChatInput('')
    setChatting(true)
    setChatError(null)
    try {
      const response = await postJson<{ message: string }>('/api/assistant/chat', {
        provider: activeProviderRequest(settings),
        messages: conversation.map(({ role, content: messageContent }) => ({ role, content: messageContent })),
        context: {
          task: task.trim() || undefined,
          criteria: criteria.trim() || undefined,
          candidate: analysis?.candidate,
          match: selectedMatch,
          evaluation: evaluation ? {
            winner: evaluation.winner,
            reason: evaluation.reason,
            baselineScore: evaluation.baseline.score,
            candidateScore: evaluation.candidate.score,
            baselineOutput: evaluation.baseline.output,
            candidateOutput: evaluation.candidate.output,
          } : undefined,
        },
      })
      setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: 'assistant', content: response.message }])
    } catch (problem) {
      setChatError(problem instanceof Error ? problem.message : 'Assistant request failed.')
    } finally {
      setChatting(false)
    }
  }

  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const closeAssistant = useCallback(() => setAssistantOpen(false), [])
  const openAssistant = useCallback((suggestion?: string) => {
    if (suggestion) setChatInput(suggestion)
    setAssistantOpen(true)
  }, [])
  const openSettingsFromAssistant = useCallback(() => {
    setAssistantOpen(false)
    setSettingsOpen(true)
  }, [])
  const saveSettings = useCallback(async (next: AiSettings) => {
    try {
      const saved = await readJson<AiSettings>('/api/ai-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      setSettings(saved)
      setError(null)
      setSettingsOpen(false)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Failed to save AI settings.')
      setSettingsOpen(true)
    }
  }, [])

  return (
    <div className={`evaluation-workspace-shell${assistantOpen ? ' assistant-open' : ''}`}>
      <div className="single-page evaluation-workspace">
      <div className="evaluation-intro">
        <div><h2>Compare a new open-source Skill</h2><p>Discover overlap with enabled local Skills, then run both definitions against the same task and blind judge.</p></div>
        <div className="evaluation-intro-actions">
          <button className="button ai-outline" type="button" onClick={() => openAssistant()}><MessageSquareText size={15} />Ask SkillOps</button>
          <button className="button ai-outline" type="button" disabled={busy} onClick={() => setSettingsOpen(true)}><BrainCircuit size={15} />{providerIsConfigured(settings) ? `${providerDefinition.label} · ${settings.providers[settings.activeProvider].model}` : 'Configure AI'}</button>
        </div>
      </div>

      <section className="panel candidate-source-panel" aria-labelledby="candidate-source-title">
        <header><span className="lab-step">01</span><div><h2 id="candidate-source-title">Inspect candidate</h2><p>Public GitHub repository, tree, blob, or raw SKILL.md URL.</p></div></header>
        <div className="candidate-source-controls">
          <label><GitFork size={16} /><input type="url" aria-label="Candidate GitHub URL" placeholder="https://github.com/owner/repo" value={sourceUrl} disabled={busy} onChange={(event) => { setSourceUrl(event.target.value); setAnalysis(null); setBaselineSourcePath(''); setEvaluation(null); setError(null) }} /></label>
          <button className="button primary" type="button" disabled={!sourceUrl.trim() || busy} onClick={() => void inspectCandidate()}>{analyzing ? <LoaderCircle className="spin" size={15} /> : <GitCompareArrows size={15} />}{analyzing ? 'Inspecting…' : 'Find matches'}</button>
        </div>
        <p className="source-privacy"><LockKeyhole size={13} />Only the requested public SKILL.md is downloaded; local Skill content is never returned to the browser.</p>
      </section>

      <div className="evaluation-grid">
        <div className="evaluation-main">

          {error && <div className="evaluation-error" role="alert">{error}</div>}

          {!analysis && (
            <section className="panel evaluation-onboarding" aria-labelledby="evaluation-workflow-title">
              <header className="panel-header">
                <div><h2 id="evaluation-workflow-title">Evaluation workflow</h2><span>One controlled path from discovery to decision.</span></div>
                <span className="workflow-readiness"><ShieldCheck size={13} />Read-only by default</span>
              </header>
              <div className="workflow-steps">
                <article>
                  <span className="workflow-icon"><GitFork size={17} /></span>
                  <div><small>Discover</small><strong>Load one public Skill</strong><p>Resolve and pin the requested SKILL.md before comparing anything locally.</p></div>
                </article>
                <article>
                  <span className="workflow-icon"><GitCompareArrows size={17} /></span>
                  <div><small>Compare</small><strong>Choose a local baseline</strong><p>Review overlap signals and select the enabled Skill that represents current behavior.</p></div>
                </article>
                <article>
                  <span className="workflow-icon"><FlaskConical size={17} /></span>
                  <div><small>Evaluate</small><strong>Run the same task twice</strong><p>Score both outputs with a blind judge. Nothing is installed or promoted automatically.</p></div>
                </article>
              </div>
            </section>
          )}

          {analysis && (
            <section className="panel candidate-analysis" aria-labelledby="candidate-analysis-title">
              <header>
                <span className="lab-step">02</span>
                <div><h2 id="candidate-analysis-title">Choose the baseline</h2><p>{analysis.recommendation}</p></div>
                <div className="stage-header-actions"><span className="analysis-state"><CheckCircle2 size={14} />Analyzed</span><button className="assistant-stage-action" type="button" onClick={() => openAssistant('Explain the overlap')}><MessageSquareText size={13} />Explain overlap</button></div>
              </header>
              <div className="candidate-summary">
                <span className="candidate-mark"><Sparkles size={18} /></span>
                <div><strong>{analysis.candidate.skillId}</strong><p>{analysis.candidate.description || 'No frontmatter description provided.'}</p><small className="mono">{analysis.candidate.sourcePath}</small></div>
                <span className="version-chip">{analysis.candidate.skillVersion}</span>
              </div>
              {analysis.candidates.length > 1 && <label className="candidate-picker"><span>Candidate in repository</span><span><select aria-label="Candidate Skill" value={analysis.candidate.sourcePath} disabled={busy} onChange={(event) => void inspectCandidate(event.target.value)}>{analysis.candidates.map((candidate) => <option key={candidate.sourcePath} value={candidate.sourcePath}>{candidate.sourcePath}</option>)}</select><ChevronDown size={14} /></span></label>}
              <div className="match-list" role="radiogroup" aria-label="Local baseline Skill">
                {analysis.matches.length ? analysis.matches.map((match) => (
                  <button key={`${match.runtime}:${match.sourcePath}`} className={baselineSourcePath === match.sourcePath ? 'match-row selected' : 'match-row'} type="button" role="radio" aria-checked={baselineSourcePath === match.sourcePath} disabled={busy} onClick={() => { setBaselineSourcePath(match.sourcePath); setEvaluation(null) }}>
                    <span className="radio-mark">{baselineSourcePath === match.sourcePath ? <CheckCircle2 size={16} /> : <Circle size={16} />}</span>
                    <span><strong>{match.skillId}</strong><small>{match.runtime} · {match.provider} · {match.skillVersion}</small><small className="mono">{match.source} · {match.sourcePath}</small></span>
                    <span className={`relationship ${match.similarity >= 65 ? 'update' : ''}`}>{match.relationship}</span>
                    <strong className="similarity-score">{match.similarity}%</strong>
                    <span className="shared-signals">{match.sharedSignals.length ? match.sharedSignals.join(' · ') : 'No strong shared terms'}</span>
                  </button>
                )) : <div className="no-baseline">No enabled local Skills were available. Run a Registry scan and try again.</div>}
              </div>
            </section>
          )}

          {analysis && selectedMatch && (
            <section className="panel ab-test-panel" aria-labelledby="ab-test-title">
              <header><span className="lab-step">03</span><div><h2 id="ab-test-title">Run a controlled A/B task</h2><p>Both Skills receive identical input; a third blinded model call scores the outputs.</p></div><button className="assistant-stage-action" type="button" onClick={() => openAssistant('Suggest an A/B task')}><MessageSquareText size={13} />Suggest task</button></header>
              <div className="ab-form">
                <label><span>Evaluation task</span><textarea aria-label="Evaluation task" rows={4} placeholder="Describe one representative task where these Skills should produce a useful result…" value={task} disabled={busy} onChange={(event) => { setTask(event.target.value); setEvaluation(null) }} /></label>
                <label><span>Acceptance criteria</span><textarea aria-label="Acceptance criteria" rows={3} placeholder="List concrete requirements the judge should score…" value={criteria} disabled={busy} onChange={(event) => { setCriteria(event.target.value); setEvaluation(null) }} /></label>
                <fieldset className="evaluation-mode">
                  <legend>Execution mode</legend>
                  <label><input type="radio" name="evaluation-mode" value="prompt-only" checked={evaluationMode === 'prompt-only'} disabled={busy} onChange={() => { setEvaluationMode('prompt-only'); setEvaluation(null) }} /><span><strong>Prompt-only comparison</strong><small>Runs each Skill as a single model prompt without workspace tools.</small></span></label>
                  <label><input type="radio" name="evaluation-mode" value="agent" checked={evaluationMode === 'agent'} disabled={busy} onChange={() => { setEvaluationMode('agent'); setEvaluation(null) }} /><span><strong>Read-only workspace agent</strong><small>May send requested allowed source excerpts to the provider. Common secret paths/lines, runtime data, build output, and writes are blocked; review allowed source before use.</small></span></label>
                </fieldset>
                {agentReasoningConflict && <div className="evaluation-compat-warning" role="alert"><BrainCircuit size={15} /><span>GPT-5.6 tool calls require reasoning effort <strong>None</strong> on Chat Completions.</span><button type="button" disabled={busy} onClick={() => setSettingsOpen(true)}>Adjust AI settings</button></div>}
                <div className="ab-run-row"><p><ShieldCheck size={14} />{evaluationMode === 'agent' ? 'Uses bounded read-only tools plus a blind judge; provider calls run sequentially.' : 'Runs 3 sequential provider calls with no workspace access.'} Prompts and outputs stay in page memory.</p><button className="button primary" type="button" disabled={!readyForEvaluation || busy || agentReasoningConflict} onClick={() => void runEvaluation()}>{running ? <LoaderCircle className="spin" size={15} /> : <FlaskConical size={15} />}{running ? 'Running A/B…' : 'Run A/B test'}</button></div>
              </div>
            </section>
          )}

          {evaluation && (
            <section className="panel evaluation-result" aria-labelledby="evaluation-result-title">
              <header><span className="lab-step complete"><CheckCircle2 size={15} /></span><div><h2 id="evaluation-result-title">Evaluation result</h2><p>{new Date(evaluation.createdAt).toLocaleString()} · {evaluation.judge.model} · {evaluation.mode === 'agent' ? 'read-only agent' : 'prompt-only'}</p></div><div className="stage-header-actions"><span className={`winner-badge ${evaluation.winner}`}>{evaluation.winner === 'candidate' ? 'Candidate wins' : evaluation.winner === 'baseline' ? 'Baseline wins' : 'Tie'}</span><button className="assistant-stage-action" type="button" onClick={() => openAssistant('Why did this version win?')}><MessageSquareText size={13} />Discuss result</button></div></header>
              <div className="score-comparison">
                {[{ label: 'Current', variant: evaluation.baseline }, { label: 'Candidate', variant: evaluation.candidate }].map(({ label, variant }) => (
                  <article key={label} className={evaluation.winner === label.toLowerCase() || (label === 'Current' && evaluation.winner === 'baseline') ? 'score-card winner' : 'score-card'}>
                    <span>{label}</span><strong>{variant.score}<small>/100</small></strong><h3>{variant.skillId}</h3><p>{formatDuration(variant.durationMs)} · {variant.tokens.toLocaleString()} tokens</p>
                    <details><summary>View session output</summary><pre>{variant.output}</pre></details>
                  </article>
                ))}
              </div>
              <div className="judge-reason"><MessageSquareText size={17} /><div><strong>Blind judge rationale</strong><p>{evaluation.reason}</p></div></div>
              <p className="result-boundary"><LockKeyhole size={13} />{evaluation.privacy} No Skill was installed or promoted.</p>
            </section>
          )}
        </div>
      </div>

      <AiSettingsModal open={settingsOpen} settings={settings} onClose={closeSettings} onSave={saveSettings} />
      </div>

      <SkillOpsAssistantDrawer
        open={assistantOpen}
        configuredProvider={providerIsConfigured(settings) ? `${providerDefinition.label} · session ready` : null}
        contextLabel={analysis ? `Context: ${analysis.candidate.skillId}${selectedMatch ? ` ↔ ${selectedMatch.skillId}` : ''}` : 'Waiting for a candidate'}
        messages={messages}
        suggestions={evaluation ? ['Why did this version win?', 'What should I test next?'] : analysis ? ['Explain the overlap', 'Suggest an A/B task'] : ['How does Skill comparison work?']}
        input={chatInput}
        chatting={chatting}
        error={chatError}
        onInputChange={setChatInput}
        onSelectSuggestion={setChatInput}
        onSend={() => void sendChat()}
        onOpenSettings={openSettingsFromAssistant}
        onClose={closeAssistant}
      />
    </div>
  )
}
