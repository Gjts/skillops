import {
  BrainCircuit, CheckCircle2, ChevronDown, Circle, FlaskConical, GitCompareArrows,
  GitFork, LoaderCircle, LockKeyhole, MessageSquareText, ShieldCheck, Sparkles,
} from 'lucide-react'
import type { CandidateAnalysis, QuickEvaluationMode, QuickEvaluationResult } from '../types'

export function QuickCandidateSource({ sourceUrl, busy, analyzing, onSourceChange, onInspect }: {
  sourceUrl: string
  busy: boolean
  analyzing: boolean
  onSourceChange: (value: string) => void
  onInspect: () => void
}) {
  return <section className="panel candidate-source-panel" aria-labelledby="candidate-source-title">
    <header><span className="lab-step">01</span><div><h2 id="candidate-source-title">Inspect candidate</h2><p>Public GitHub repository, tree, blob, or raw SKILL.md URL.</p></div></header>
    <div className="candidate-source-controls">
      <label><GitFork size={16} /><input type="url" aria-label="Candidate GitHub URL" placeholder="https://github.com/owner/repo" value={sourceUrl} disabled={busy} onChange={(event) => onSourceChange(event.target.value)} /></label>
      <button className="button primary" type="button" disabled={!sourceUrl.trim() || busy} onClick={onInspect}>{analyzing ? <LoaderCircle className="spin" size={15} /> : <GitCompareArrows size={15} />}{analyzing ? 'Inspecting…' : 'Find matches'}</button>
    </div>
    <p className="source-privacy"><LockKeyhole size={13} />Only the requested public SKILL.md is downloaded; local Skill content is never returned to the browser.</p>
  </section>
}

export function QuickEvaluationOnboarding() {
  return <section className="panel evaluation-onboarding" aria-labelledby="evaluation-workflow-title">
    <header className="panel-header"><div><h2 id="evaluation-workflow-title">Evaluation workflow</h2><span>One controlled path from discovery to decision.</span></div><span className="workflow-readiness"><ShieldCheck size={13} />Read-only by default</span></header>
    <div className="workflow-steps">
      <article><span className="workflow-icon"><GitFork size={17} /></span><div><small>Discover</small><strong>Load one public Skill</strong><p>Resolve and pin the requested SKILL.md before comparing anything locally.</p></div></article>
      <article><span className="workflow-icon"><GitCompareArrows size={17} /></span><div><small>Compare</small><strong>Choose a local baseline</strong><p>Review overlap signals and select the enabled Skill that represents current behavior.</p></div></article>
      <article><span className="workflow-icon"><FlaskConical size={17} /></span><div><small>Evaluate</small><strong>Run the same task twice</strong><p>Score both outputs with a blind judge. Nothing is installed or promoted automatically.</p></div></article>
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
  return <section className="panel candidate-analysis" aria-labelledby="candidate-analysis-title">
    <header><span className="lab-step">02</span><div><h2 id="candidate-analysis-title">Choose the baseline</h2><p>{analysis.recommendation}</p></div><div className="stage-header-actions"><span className="analysis-state"><CheckCircle2 size={14} />Analyzed</span><button className="assistant-stage-action" type="button" onClick={onExplain}><MessageSquareText size={13} />Explain overlap</button></div></header>
    <div className="candidate-summary"><span className="candidate-mark"><Sparkles size={18} /></span><div><strong>{analysis.candidate.skillId}</strong><p>{analysis.candidate.description || 'No frontmatter description provided.'}</p><small className="mono">{analysis.candidate.sourcePath}</small></div><span className="version-chip">{analysis.candidate.skillVersion}</span></div>
    {analysis.candidates.length > 1 && <label className="candidate-picker"><span>Candidate in repository</span><span><select aria-label="Candidate Skill" value={analysis.candidate.sourcePath} disabled={busy} onChange={(event) => onInspectCandidate(event.target.value)}>{analysis.candidates.map((candidate) => <option key={candidate.sourcePath} value={candidate.sourcePath}>{candidate.sourcePath}</option>)}</select><ChevronDown size={14} /></span></label>}
    <div className="match-list" role="radiogroup" aria-label="Local baseline Skill">
      {analysis.matches.length ? analysis.matches.map((match) => <button key={`${match.runtime}:${match.sourcePath}`} className={selectedPath === match.sourcePath ? 'match-row selected' : 'match-row'} type="button" role="radio" aria-checked={selectedPath === match.sourcePath} disabled={busy} onClick={() => onSelect(match.sourcePath)}>
        <span className="radio-mark">{selectedPath === match.sourcePath ? <CheckCircle2 size={16} /> : <Circle size={16} />}</span>
        <span><strong>{match.skillId}</strong><small>{match.runtime} · {match.provider} · {match.skillVersion}</small><small className="mono">{match.source} · {match.sourcePath}</small></span>
        <span className={`relationship ${match.similarity >= 65 ? 'update' : ''}`}>{match.relationship}</span><strong className="similarity-score">{match.similarity}%</strong><span className="shared-signals">{match.sharedSignals.length ? match.sharedSignals.join(' · ') : 'No strong shared terms'}</span>
      </button>) : <div className="no-baseline">No enabled local Skills were available. Run a Registry scan and try again.</div>}
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
  return <section className="panel ab-test-panel" aria-labelledby="ab-test-title">
    <header><span className="lab-step">03</span><div><h2 id="ab-test-title">Run a controlled A/B task</h2><p>Both Skills receive identical input; a third blinded model call scores the outputs.</p></div><button className="assistant-stage-action" type="button" onClick={onSuggest}><MessageSquareText size={13} />Suggest task</button></header>
    <div className="ab-form">
      <label><span>Evaluation task</span><textarea aria-label="Evaluation task" rows={4} placeholder="Describe one representative task where these Skills should produce a useful result…" value={task} disabled={busy} onChange={(event) => onTaskChange(event.target.value)} /></label>
      <label><span>Acceptance criteria</span><textarea aria-label="Acceptance criteria" rows={3} placeholder="List concrete requirements the judge should score…" value={criteria} disabled={busy} onChange={(event) => onCriteriaChange(event.target.value)} /></label>
      <fieldset className="evaluation-mode"><legend>Execution mode</legend>
        <label><input type="radio" name="evaluation-mode" value="prompt-only" checked={mode === 'prompt-only'} disabled={busy} onChange={() => onModeChange('prompt-only')} /><span><strong>Prompt-only comparison</strong><small>Runs each Skill as a single model prompt without workspace tools.</small></span></label>
        <label><input type="radio" name="evaluation-mode" value="agent" checked={mode === 'agent'} disabled={busy} onChange={() => onModeChange('agent')} /><span><strong>Read-only workspace agent</strong><small>May send requested allowed source excerpts to the provider. Common secret paths/lines, runtime data, build output, and writes are blocked; review allowed source before use.</small></span></label>
      </fieldset>
      {agentReasoningConflict && <div className="evaluation-compat-warning" role="alert"><BrainCircuit size={15} /><span>GPT-5.6 tool calls require reasoning effort <strong>None</strong> on Chat Completions.</span><button type="button" disabled={busy} onClick={onSettings}>Adjust AI settings</button></div>}
      <div className="ab-run-row"><p><ShieldCheck size={14} />{mode === 'agent' ? 'Uses bounded read-only tools plus a blind judge; provider calls run sequentially.' : 'Runs 3 sequential provider calls with no workspace access.'} Prompts and outputs stay in page memory.</p><button className="button primary" type="button" disabled={!ready || busy || agentReasoningConflict} onClick={onRun}>{running ? <LoaderCircle className="spin" size={15} /> : <FlaskConical size={15} />}{running ? 'Running A/B…' : 'Run A/B test'}</button></div>
    </div>
  </section>
}

function formatDuration(value: number) {
  return value < 1_000 ? `${value}ms` : `${(value / 1_000).toFixed(1)}s`
}

export function QuickResultStage({ evaluation, onDiscuss }: { evaluation: QuickEvaluationResult; onDiscuss: () => void }) {
  return <section className="panel evaluation-result" aria-labelledby="evaluation-result-title">
    <header><span className="lab-step complete"><CheckCircle2 size={15} /></span><div><h2 id="evaluation-result-title">Evaluation result</h2><p>{new Date(evaluation.createdAt).toLocaleString()} · {evaluation.judge.model} · {evaluation.mode === 'agent' ? 'read-only agent' : 'prompt-only'}{evaluation.engine ? ` · ${evaluation.engine.name} ${evaluation.engine.version}` : ''}</p></div><div className="stage-header-actions"><span className={`winner-badge ${evaluation.winner}`}>{evaluation.winner === 'candidate' ? 'Candidate wins' : evaluation.winner === 'baseline' ? 'Baseline wins' : 'Tie'}</span><button className="assistant-stage-action" type="button" onClick={onDiscuss}><MessageSquareText size={13} />Discuss result</button></div></header>
    <div className="score-comparison">
      {[{ label: 'Current', variant: evaluation.baseline }, { label: 'Candidate', variant: evaluation.candidate }].map(({ label, variant }) => <article key={label} className={evaluation.winner === label.toLowerCase() || (label === 'Current' && evaluation.winner === 'baseline') ? 'score-card winner' : 'score-card'}>
        <span>{label}</span><strong>{variant.score}<small>/100</small></strong><h3>{variant.skillId}</h3><p>{formatDuration(variant.durationMs)} · {variant.tokens.toLocaleString()} tokens</p><details><summary>View session output</summary><pre>{variant.output}</pre></details>
      </article>)}
    </div>
    <div className="judge-reason"><MessageSquareText size={17} /><div><strong>Blind judge rationale</strong><p>{evaluation.reason}</p></div></div>
    <p className="result-boundary"><LockKeyhole size={13} />{evaluation.privacy} No Skill was installed or promoted.</p>
  </section>
}
