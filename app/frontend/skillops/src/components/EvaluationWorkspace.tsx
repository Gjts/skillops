import { BrainCircuit, MessageSquareText } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { activeProviderRequest, AI_PROVIDERS, createDefaultAiSettings, providerIsConfigured, type AiSettings } from '../lib/ai-settings'
import { evaluationApi } from '../lib/evaluation-api'
import type { CandidateAnalysis, QuickEvaluationResult } from '../types'
import { AiSettingsModal } from './AiSettingsModal'
import { ManagedEvaluations } from './ManagedEvaluations'
import { QuickBaselineStage, QuickCandidateSource, QuickEvaluationOnboarding, QuickResultStage, QuickRunStage } from './QuickEvaluationStages'
import { SkillOpsAssistantDrawer, type AssistantMessage } from './SkillOpsAssistantDrawer'

function QuickEvaluationWorkspace() {
  const [sourceUrl, setSourceUrl] = useState('')
  const [analysis, setAnalysis] = useState<CandidateAnalysis | null>(null)
  const [baselineSourcePath, setBaselineSourcePath] = useState('')
  const [task, setTask] = useState('')
  const [criteria, setCriteria] = useState('')
  const [evaluationMode, setEvaluationMode] = useState<'prompt-only' | 'agent'>('prompt-only')
  const [evaluation, setEvaluation] = useState<QuickEvaluationResult | null>(null)
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
      const result = await evaluationApi.compare({ sourceUrl: sourceUrl.trim(), candidatePath })
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
      const result = await evaluationApi.run({
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
      const response = await evaluationApi.chat({
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
  const saveSettings = useCallback((next: AiSettings) => {
    setSettings(next)
    setEvaluation(null)
    setSettingsOpen(false)
  }, [])

  return (
    <div className="single-page evaluation-workspace">
      <div className="evaluation-intro">
        <div><h2>Compare a new open-source Skill</h2><p>Discover overlap with enabled local Skills, then run both definitions against the same task and blind judge.</p></div>
        <div className="evaluation-intro-actions">
          <button className="button ai-outline" type="button" onClick={() => openAssistant()}><MessageSquareText size={15} />Ask SkillOps</button>
          <button className="button ai-outline" type="button" disabled={busy} onClick={() => setSettingsOpen(true)}><BrainCircuit size={15} />{providerIsConfigured(settings) ? `${providerDefinition.label} · ${settings.providers[settings.activeProvider].model}` : 'Configure AI'}</button>
        </div>
      </div>

      <QuickCandidateSource
        sourceUrl={sourceUrl}
        busy={busy}
        analyzing={analyzing}
        onSourceChange={(value) => { setSourceUrl(value); setAnalysis(null); setBaselineSourcePath(''); setEvaluation(null); setError(null) }}
        onInspect={() => void inspectCandidate()}
      />

      <div className="evaluation-grid">
        <div className="evaluation-main">

          {error && <div className="evaluation-error" role="alert">{error}</div>}

          {!analysis && <QuickEvaluationOnboarding />}

          {analysis && <QuickBaselineStage
            analysis={analysis}
            selectedPath={baselineSourcePath}
            busy={busy}
            onInspectCandidate={(value) => void inspectCandidate(value)}
            onSelect={(value) => { setBaselineSourcePath(value); setEvaluation(null) }}
            onExplain={() => openAssistant('Explain the overlap')}
          />}

          {analysis && selectedMatch && <QuickRunStage
            task={task}
            criteria={criteria}
            mode={evaluationMode}
            busy={busy}
            running={running}
            ready={readyForEvaluation}
            agentReasoningConflict={agentReasoningConflict}
            onTaskChange={(value) => { setTask(value); setEvaluation(null) }}
            onCriteriaChange={(value) => { setCriteria(value); setEvaluation(null) }}
            onModeChange={(value) => { setEvaluationMode(value); setEvaluation(null) }}
            onSuggest={() => openAssistant('Suggest an A/B task')}
            onSettings={() => setSettingsOpen(true)}
            onRun={() => void runEvaluation()}
          />}

          {evaluation && <QuickResultStage evaluation={evaluation} onDiscuss={() => openAssistant('Why did this version win?')} />}
        </div>

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

      <AiSettingsModal open={settingsOpen} settings={settings} onClose={closeSettings} onSave={saveSettings} />
    </div>
  )
}

export function EvaluationWorkspace() {
  const { t } = useI18n()
  const [tab, setTab] = useState<'quick' | 'suites' | 'history'>('quick')
  return (
    <div className="single-page evaluation-workspace evaluation-hub">
      <div className="evaluation-tabs" role="tablist" aria-label={t('evaluations.workspaceTabs')}>
        {(['quick', 'suites', 'history'] as const).map((item) => (
          <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>{t(item === 'quick' ? 'evaluations.quickTab' : item === 'suites' ? 'evaluations.suitesTab' : 'evaluations.historyTab')}</button>
        ))}
      </div>
      <div role="tabpanel" hidden={tab !== 'quick'}><QuickEvaluationWorkspace /></div>
      <div role="tabpanel" hidden={tab === 'quick'}><ManagedEvaluations tab={tab === 'history' ? 'history' : 'suites'} /></div>
    </div>
  )
}
