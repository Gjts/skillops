import {
  BrainCircuit, CheckCircle2, ChevronDown, Circle, FlaskConical, GitCompareArrows,
  GitFork, LoaderCircle, LockKeyhole, MessageSquareText, ShieldCheck, Sparkles,
} from 'lucide-react'
import type { CandidateAnalysis, QuickEvaluationMode, QuickEvaluationResult } from '../types'
import { useI18n } from '../i18n/I18nProvider'

export function QuickCandidateSource({ sourceUrl, busy, analyzing, onSourceChange, onInspect }: {
  sourceUrl: string
  busy: boolean
  analyzing: boolean
  onSourceChange: (value: string) => void
  onInspect: () => void
}) {
  const { t } = useI18n()
  return <section className="panel candidate-source-panel" aria-labelledby="candidate-source-title">
    <header><span className="lab-step">01</span><div><h2 id="candidate-source-title">{t('quick.inspectTitle')}</h2><p>{t('quick.sourceDescription')}</p></div></header>
    <div className="candidate-source-controls">
      <label><GitFork size={16} /><input type="url" aria-label={t('quick.candidateUrl')} placeholder="https://github.com/owner/repo" value={sourceUrl} disabled={busy} onChange={(event) => onSourceChange(event.target.value)} /></label>
      <button className="button primary" type="button" disabled={!sourceUrl.trim() || busy} onClick={onInspect}>{analyzing ? <LoaderCircle className="spin" size={15} /> : <GitCompareArrows size={15} />}{analyzing ? t('quick.inspecting') : t('quick.findMatches')}</button>
    </div>
    <p className="source-privacy"><LockKeyhole size={13} />{t('quick.sourcePrivacy')}</p>
  </section>
}

export function QuickEvaluationOnboarding() {
  const { t } = useI18n()
  return <section className="panel evaluation-onboarding" aria-labelledby="evaluation-workflow-title">
    <header className="panel-header"><div><h2 id="evaluation-workflow-title">{t('quick.workflowTitle')}</h2><span>{t('quick.workflowDescription')}</span></div><span className="workflow-readiness"><ShieldCheck size={13} />{t('quick.readOnlyDefault')}</span></header>
    <div className="workflow-steps">
      <article><span className="workflow-icon"><GitFork size={17} /></span><div><small>{t('quick.discover')}</small><strong>{t('quick.loadPublicSkill')}</strong><p>{t('quick.discoverDescription')}</p></div></article>
      <article><span className="workflow-icon"><GitCompareArrows size={17} /></span><div><small>{t('quick.compare')}</small><strong>{t('quick.chooseLocalBaseline')}</strong><p>{t('quick.compareDescription')}</p></div></article>
      <article><span className="workflow-icon"><FlaskConical size={17} /></span><div><small>{t('quick.evaluate')}</small><strong>{t('quick.runSameTask')}</strong><p>{t('quick.evaluateDescription')}</p></div></article>
    </div>
  </section>
}

export function QuickBaselineStage({ analysis, selectedPath, busy, onInspectCandidate, onSelect, onExplain }: {
  analysis: CandidateAnalysis
  selectedPath: string
  busy: boolean
  onInspectCandidate: (path: string) => void
  onSelect: (path: string) => void
  onExplain: () => void
}) {
  const { t } = useI18n()
  const best = analysis.matches[0]
  const recommendation = !best
    ? t('quick.noLocalRecommendation')
    : best.similarity >= 65
      ? t('quick.updateRecommendation', { skillId: best.skillId })
      : best.similarity >= 25
        ? t('quick.overlapRecommendation', { skillId: best.skillId })
        : t('quick.distinctRecommendation')
  return <section className="panel candidate-analysis" aria-labelledby="candidate-analysis-title">
    <header><span className="lab-step">02</span><div><h2 id="candidate-analysis-title">{t('quick.chooseBaseline')}</h2><p>{recommendation}</p></div><div className="stage-header-actions"><span className="analysis-state"><CheckCircle2 size={14} />{t('quick.analyzed')}</span><button className="assistant-stage-action" type="button" onClick={onExplain}><MessageSquareText size={13} />{t('quick.explainOverlap')}</button></div></header>
    <div className="candidate-summary"><span className="candidate-mark"><Sparkles size={18} /></span><div><strong>{analysis.candidate.skillId}</strong><p>{analysis.candidate.description || t('quick.noDescription')}</p><small className="mono">{analysis.candidate.sourcePath}</small></div><span className="version-chip">{analysis.candidate.skillVersion}</span></div>
    {analysis.candidates.length > 1 && <label className="candidate-picker"><span>{t('quick.repositoryCandidate')}</span><span><select aria-label={t('quick.candidateSkill')} value={analysis.candidate.sourcePath} disabled={busy} onChange={(event) => onInspectCandidate(event.target.value)}>{analysis.candidates.map((candidate) => <option key={candidate.sourcePath} value={candidate.sourcePath}>{candidate.sourcePath}</option>)}</select><ChevronDown size={14} /></span></label>}
    <div className="match-list" role="radiogroup" aria-label={t('quick.localBaselineSkill')}>
      {analysis.matches.length ? analysis.matches.map((match) => <button key={`${match.runtime}:${match.sourcePath}`} className={selectedPath === match.sourcePath ? 'match-row selected' : 'match-row'} type="button" role="radio" aria-checked={selectedPath === match.sourcePath} disabled={busy} onClick={() => onSelect(match.sourcePath)}>
        <span className="radio-mark">{selectedPath === match.sourcePath ? <CheckCircle2 size={16} /> : <Circle size={16} />}</span>
        <span><strong>{match.skillId}</strong><small>{match.runtime} · {match.provider} · {match.skillVersion}</small><small className="mono">{match.source} · {match.sourcePath}</small></span>
        <span className={`relationship ${match.similarity >= 65 ? 'update' : ''}`}>{match.relationship === 'Likely update' ? t('quick.relationshipUpdate') : match.relationship === 'Overlapping purpose' ? t('quick.relationshipOverlap') : match.relationship === 'Distinct purpose' ? t('quick.relationshipDistinct') : match.relationship}</span><strong className="similarity-score">{match.similarity}%</strong><span className="shared-signals">{match.sharedSignals.length ? match.sharedSignals.join(' · ') : t('quick.noSharedTerms')}</span>
      </button>) : <div className="no-baseline">{t('quick.noLocalSkills')}</div>}
    </div>
  </section>
}

export function QuickRunStage({ task, criteria, mode, busy, running, ready, agentReasoningConflict, onTaskChange, onCriteriaChange, onModeChange, onSuggest, onSettings, onRun }: {
  task: string
  criteria: string
  mode: QuickEvaluationMode
  busy: boolean
  running: boolean
  ready: boolean
  agentReasoningConflict: boolean
  onTaskChange: (value: string) => void
  onCriteriaChange: (value: string) => void
  onModeChange: (value: QuickEvaluationMode) => void
  onSuggest: () => void
  onSettings: () => void
  onRun: () => void
}) {
  const { t } = useI18n()
  return <section className="panel ab-test-panel" aria-labelledby="ab-test-title">
    <header><span className="lab-step">03</span><div><h2 id="ab-test-title">{t('quick.runTitle')}</h2><p>{t('quick.runDescription')}</p></div><button className="assistant-stage-action" type="button" onClick={onSuggest}><MessageSquareText size={13} />{t('quick.suggestTask')}</button></header>
    <div className="ab-form">
      <label><span>{t('quick.evaluationTask')}</span><textarea aria-label={t('quick.evaluationTask')} rows={4} placeholder={t('quick.taskPlaceholder')} value={task} disabled={busy} onChange={(event) => onTaskChange(event.target.value)} /></label>
      <label><span>{t('quick.acceptanceCriteria')}</span><textarea aria-label={t('quick.acceptanceCriteria')} rows={3} placeholder={t('quick.criteriaPlaceholder')} value={criteria} disabled={busy} onChange={(event) => onCriteriaChange(event.target.value)} /></label>
      <fieldset className="evaluation-mode"><legend>{t('quick.executionMode')}</legend>
        <label><input type="radio" name="evaluation-mode" value="prompt-only" checked={mode === 'prompt-only'} disabled={busy} onChange={() => onModeChange('prompt-only')} /><span><strong>{t('quick.promptOnly')}</strong><small>{t('quick.promptOnlyDescription')}</small></span></label>
        <label><input type="radio" name="evaluation-mode" value="agent" checked={mode === 'agent'} disabled={busy} onChange={() => onModeChange('agent')} /><span><strong>{t('quick.readOnlyAgent')}</strong><small>{t('quick.agentDescription')}</small></span></label>
      </fieldset>
      {agentReasoningConflict && <div className="evaluation-compat-warning" role="alert"><BrainCircuit size={15} /><span>{t('quick.reasoningConflict')}</span><button type="button" disabled={busy} onClick={onSettings}>{t('quick.adjustSettings')}</button></div>}
      <div className="ab-run-row"><p><ShieldCheck size={14} />{mode === 'agent' ? t('quick.agentRunPrivacy') : t('quick.promptRunPrivacy')}</p><button className="button primary" type="button" disabled={!ready || busy || agentReasoningConflict} onClick={onRun}>{running ? <LoaderCircle className="spin" size={15} /> : <FlaskConical size={15} />}{running ? t('quick.running') : t('quick.runTest')}</button></div>
    </div>
  </section>
}


export function QuickResultStage({ evaluation, onDiscuss }: { evaluation: QuickEvaluationResult; onDiscuss: () => void }) {
  const { t, formatDateTime, formatDuration, formatNumber } = useI18n()
  const winnerLabel = evaluation.winner === 'candidate' ? t('quick.candidateWins') : evaluation.winner === 'baseline' ? t('quick.baselineWins') : t('quick.tie')
  const variants = [
    { label: t('quick.current'), winner: 'baseline', variant: evaluation.baseline },
    { label: t('quick.candidate'), winner: 'candidate', variant: evaluation.candidate },
  ]
  return <section className="panel evaluation-result" aria-labelledby="evaluation-result-title">
    <header><span className="lab-step complete"><CheckCircle2 size={15} /></span><div><h2 id="evaluation-result-title">{t('quick.resultTitle')}</h2><p>{formatDateTime(evaluation.createdAt)} · {evaluation.judge.model} · {evaluation.mode === 'agent' ? t('quick.readOnlyAgentShort') : t('quick.promptOnlyShort')}{evaluation.engine ? ` · ${evaluation.engine.name} ${evaluation.engine.version}` : ''}</p></div><div className="stage-header-actions"><span className={`winner-badge ${evaluation.winner}`}>{winnerLabel}</span><button className="assistant-stage-action" type="button" onClick={onDiscuss}><MessageSquareText size={13} />{t('quick.discussResult')}</button></div></header>
    <div className="score-comparison">
      {variants.map(({ label, winner, variant }) => <article key={winner} className={evaluation.winner === winner ? 'score-card winner' : 'score-card'}>
        <span>{label}</span><strong>{variant.score}<small>/100</small></strong><h3>{variant.skillId}</h3><p>{formatDuration(variant.durationMs)} · {t('quick.tokenCount', { count: formatNumber(variant.tokens) })}</p><details><summary>{t('quick.viewOutput')}</summary><pre>{variant.output}</pre></details>
      </article>)}
    </div>
    <div className="judge-reason"><MessageSquareText size={17} /><div><strong>{t('quick.blindRationale')}</strong><p>{evaluation.reason}</p></div></div>
    <p className="result-boundary"><LockKeyhole size={13} />{t('quick.resultPrivacy')}</p>
  </section>
}
