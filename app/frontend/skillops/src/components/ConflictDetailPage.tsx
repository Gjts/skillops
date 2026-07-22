import { ArrowLeft, CheckCircle2, RefreshCw, RotateCcw, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { runtimeLabel } from '../lib/analytics'
import type { InstalledSkill } from '../types'

type ConflictAction = 'keep' | 'enable' | 'disable' | 'remove' | 'rename' | 'replace' | 'defer'
type DiffSection = 'frontmatter' | 'instructions' | 'tools' | 'references' | 'scripts'

interface ConflictDefinition extends InstalledSkill { definitionKey: string }
interface SectionDiff { changed: boolean; before?: unknown; after?: unknown; beforeHash?: string; afterHash?: string; beforeBytes?: number; afterBytes?: number }
interface ConflictDetail {
  runtime: InstalledSkill['runtime']
  skillId: string
  classifications: string[]
  definitions: ConflictDefinition[]
  possibleLoadedDefinitions: Array<{ definitionKey: string; possible: boolean; status: string; shadowedBy?: string | null }>
  impact: { projects: string[]; runtimes: string[]; installationSources: string[]; providers: string[] }
  comparisons: Array<{ before: string; after: string; sections: Record<DiffSection, SectionDiff> }>
}
interface ConflictPlan {
  previewToken: string
  action: ConflictAction
  definitionKey: string
  definition: { sourcePath: string }
  changes: Array<{ target: string; operation: string; diff: SectionDiff }>
  rollback: string
}
interface ActionResult { recordId: string; action?: ConflictAction; status: string; changed?: boolean; rollback?: { restored: boolean } }

const sections: DiffSection[] = ['frontmatter', 'instructions', 'tools', 'references', 'scripts']
const classificationKeys: Record<string, 'registry.exactDuplicate' | 'registry.contentConflict' | 'registry.versionConflict' | 'registry.shadowedDefinition' | 'registry.disabledDefinition' | 'registry.missingMetadata'> = {
  'exact-duplicate': 'registry.exactDuplicate',
  'content-conflict': 'registry.contentConflict',
  'version-conflict': 'registry.versionConflict',
  'shadowed-definition': 'registry.shadowedDefinition',
  'disabled-definition': 'registry.disabledDefinition',
  'missing-metadata': 'registry.missingMetadata',
}
const actionKeys: Record<ConflictAction, 'registry.actionKeep' | 'registry.actionEnable' | 'registry.actionDisable' | 'registry.actionRemove' | 'registry.actionRename' | 'registry.actionReplace' | 'registry.actionDefer'> = {
  keep: 'registry.actionKeep', enable: 'registry.actionEnable', disable: 'registry.actionDisable', remove: 'registry.actionRemove',
  rename: 'registry.actionRename', replace: 'registry.actionReplace', defer: 'registry.actionDefer',
}
const sectionKeys: Record<DiffSection, 'registry.diffFrontmatter' | 'registry.diffInstructions' | 'registry.diffTools' | 'registry.diffReferences' | 'registry.diffScripts'> = {
  frontmatter: 'registry.diffFrontmatter', instructions: 'registry.diffInstructions', tools: 'registry.diffTools',
  references: 'registry.diffReferences', scripts: 'registry.diffScripts',
}

async function post<T>(endpoint: string, body: unknown): Promise<T> {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(result?.error || 'Conflict request failed')
  return result as T
}

function DisplayValue({ value }: { value: unknown }) {
  return <pre>{typeof value === 'string' ? value || '—' : JSON.stringify(value, null, 2)}</pre>
}

function DiffValues({ value }: { value: SectionDiff }) {
  return <div>{value.before === undefined && value.after === undefined
    ? <DisplayValue value={value} />
    : <><DisplayValue value={value.before} /><DisplayValue value={value.after} /></>}</div>
}

export function ConflictDetailPage({ skill, onBack, onChanged }: { skill: InstalledSkill; onBack: () => void; onChanged: () => void }) {
  const { t } = useI18n()
  const [detail, setDetail] = useState<ConflictDetail | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [selectedDefinitionKey, setSelectedDefinitionKey] = useState('')
  const [action, setAction] = useState<ConflictAction>('defer')
  const [newName, setNewName] = useState('')
  const [replacementDefinitionKey, setReplacementDefinitionKey] = useState('')
  const [plans, setPlans] = useState<ConflictPlan[]>([])
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<ActionResult[]>([])

  const load = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await post<ConflictDetail>('/api/conflicts/inspect', { runtime: skill.runtime, skillId: skill.skillId })
      setDetail(result)
      setSelectedDefinitionKey((current) => current || result.definitions.find((item) => item.sourcePath === skill.sourcePath)?.definitionKey || result.definitions[0]?.definitionKey || '')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Conflict inspection failed')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void load() }, [skill.runtime, skill.skillId]) // eslint-disable-line react-hooks/exhaustive-deps

  const selected = detail?.definitions.find((item) => item.definitionKey === selectedDefinitionKey)
  const replacements = useMemo(() => detail?.definitions.filter((item) => item.definitionKey !== selectedDefinitionKey) ?? [], [detail, selectedDefinitionKey])

  const preview = async () => {
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      const replacement = detail?.definitions.find((item) => item.definitionKey === replacementDefinitionKey)
      const plan = await post<ConflictPlan>('/api/conflicts/preview', {
        action, runtime: selected.runtime, sourcePath: selected.sourcePath,
        ...(action === 'rename' ? { newName } : {}),
        ...(action === 'replace' ? { replacementSourcePath: replacement?.sourcePath } : {}),
      })
      setPlans((current) => [...current.filter((item) => item.definitionKey !== plan.definitionKey), plan])
      setConfirmed((current) => { const next = new Set(current); next.delete(plan.previewToken); return next })
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'Action preview failed')
    } finally {
      setBusy(false)
    }
  }

  const applyPlan = async (plan: ConflictPlan) => {
    setBusy(true)
    setError('')
    try {
      const result = await post<ActionResult>('/api/conflicts/apply', { previewToken: plan.previewToken, confirm: true, confirmedDefinitionKey: plan.definitionKey })
      setResults((current) => [result, ...current])
      setPlans((current) => current.filter((item) => item.previewToken !== plan.previewToken))
      onChanged()
      await load()
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'Action failed')
      setBusy(false)
    }
  }

  const applyBatch = async () => {
    setBusy(true)
    setError('')
    try {
      const response = await post<{ results: ActionResult[] }>('/api/conflicts/batch', { items: plans.map((plan) => ({ previewToken: plan.previewToken, confirmedDefinitionKey: plan.definitionKey, confirmed: confirmed.has(plan.previewToken) })) })
      setResults((current) => [...response.results, ...current])
      setPlans([])
      setConfirmed(new Set())
      onChanged()
      await load()
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'Batch action failed')
      setBusy(false)
    }
  }

  const undo = async (recordId: string) => {
    setBusy(true)
    setError('')
    try {
      const result = await post<ActionResult>('/api/conflicts/undo', { recordId })
      setResults((current) => current.map((item) => item.recordId === recordId ? result : item))
      onChanged()
      await load()
    } catch (undoError) {
      setError(undoError instanceof Error ? undoError.message : 'Undo failed')
      setBusy(false)
    }
  }

  return (
    <div className="single-page conflict-detail-page">
      <div className="page-intro">
        <div><button className="button secondary conflict-back" type="button" onClick={onBack}><ArrowLeft size={14} />{t('registry.backInventory')}</button><h2>{t('registry.conflictDetails')}: {skill.skillId}</h2><p>{runtimeLabel[skill.runtime]}</p></div>
        <button className="button secondary" type="button" disabled={busy} onClick={() => void load()}><RefreshCw size={14} className={busy ? 'spin' : ''} />{t('registry.refreshConflict')}</button>
      </div>

      {error ? <div className="registry-warning" role="alert">{error}</div> : null}
      {busy && !detail ? <div className="panel conflict-loading">{t('registry.loadingConflict')}</div> : null}
      {detail ? <>
        <section className="panel conflict-summary">
          <header><span>{t('registry.classifications')}</span><div>{detail.classifications.map((item) => <strong className="registry-issue conflict" key={item}>{t(classificationKeys[item] || 'registry.contentConflict')}</strong>)}</div></header>
          <div className="conflict-impact"><div><b>{t('common.runtime')}</b><span>{detail.impact.runtimes.join(', ')}</span></div><div><b>{t('registry.projects')}</b><span>{detail.impact.projects.join(', ') || '—'}</span></div><div><b>{t('registry.installationSources')}</b><span>{detail.impact.installationSources.join(', ')}</span></div><div><b>{t('common.provider')}</b><span>{detail.impact.providers.join(', ')}</span></div></div>
        </section>

        <section className="panel conflict-definitions">
          <h3>{t('registry.possibleDefinitions')}</h3><p>{t('registry.possibleDefinitionsNote')}</p>
          <div>{detail.definitions.map((definition) => <article key={definition.definitionKey}><header><strong>{definition.skillId}</strong><span>{definition.status || (definition.enabled ? 'active' : 'disabled')}</span></header><dl><dt>{t('common.version')}</dt><dd>{definition.skillVersion}</dd><dt>{t('common.source')}</dt><dd>{definition.source}</dd><dt>{t('common.location')}</dt><dd className="mono">{definition.sourcePath}</dd><dt>{t('registry.contentHash')}</dt><dd className="mono">{definition.contentHash || '—'}</dd></dl>{detail.possibleLoadedDefinitions.some((item) => item.definitionKey === definition.definitionKey) ? <span className="conflict-possible"><ShieldAlert size={13} />{t('registry.runtimeMayLoad')}</span> : null}</article>)}</div>
        </section>

        <section className="panel conflict-diffs">
          <h3>{t('registry.structuredDiff')}</h3>
          {detail.comparisons.length ? detail.comparisons.map((comparison) => <article key={`${comparison.before}:${comparison.after}`}><header><code>{comparison.before}</code><span>→</span><code>{comparison.after}</code></header>{sections.map((name) => { const value = comparison.sections[name]; return <details key={name} open={value.changed}><summary>{t(sectionKeys[name])}<b>{t(value.changed ? 'registry.changed' : 'registry.unchanged')}</b></summary><DiffValues value={value} /></details> })}</article>) : <p>{t('registry.noComparison')}</p>}
        </section>

        <section className="panel conflict-actions">
          <h3>{t('registry.safeActions')}</h3>
          <div className="conflict-action-form">
            <label><span>{t('registry.definition')}</span><select aria-label={t('registry.definition')} value={selectedDefinitionKey} onChange={(event) => setSelectedDefinitionKey(event.target.value)}>{detail.definitions.map((definition) => <option value={definition.definitionKey} key={definition.definitionKey}>{definition.source} · {definition.sourcePath}</option>)}</select></label>
            <label><span>{t('registry.action')}</span><select aria-label={t('registry.action')} value={action} onChange={(event) => setAction(event.target.value as ConflictAction)}>{(Object.keys(actionKeys) as ConflictAction[]).map((item) => <option value={item} key={item}>{t(actionKeys[item])}</option>)}</select></label>
            {action === 'rename' ? <label><span>{t('registry.newName')}</span><input aria-label={t('registry.newName')} value={newName} onChange={(event) => setNewName(event.target.value)} /></label> : null}
            {action === 'replace' ? <label><span>{t('registry.replacement')}</span><select aria-label={t('registry.replacement')} value={replacementDefinitionKey} onChange={(event) => setReplacementDefinitionKey(event.target.value)}><option value="">—</option>{replacements.map((definition) => <option value={definition.definitionKey} key={definition.definitionKey}>{definition.source} · {definition.sourcePath}</option>)}</select></label> : null}
            <button className="button primary" type="button" disabled={busy || !selected || (action === 'rename' && !newName) || (action === 'replace' && !replacementDefinitionKey)} onClick={() => void preview()}>{t('registry.previewAction')}</button>
          </div>

          <div className="conflict-plans">{plans.map((plan) => <article key={plan.previewToken}><header><strong>{t(actionKeys[plan.action])}</strong><code>{plan.definition.sourcePath}</code></header>{plan.changes.map((change) => <details key={change.target} open><summary>{change.operation} · {change.target}</summary><DiffValues value={change.diff} /></details>)}<p>{plan.rollback}</p><label className="conflict-confirm"><input type="checkbox" checked={confirmed.has(plan.previewToken)} onChange={(event) => setConfirmed((current) => { const next = new Set(current); if (event.target.checked) next.add(plan.previewToken); else next.delete(plan.previewToken); return next })} />{t('registry.confirmDefinition')}</label><button className="button primary" type="button" disabled={busy || !confirmed.has(plan.previewToken)} onClick={() => void applyPlan(plan)}>{t('registry.applyAction')}</button></article>)}</div>
          {plans.length > 1 ? <button className="button primary" type="button" disabled={busy || plans.some((plan) => !confirmed.has(plan.previewToken))} onClick={() => void applyBatch()}>{t('registry.applyBatch')}</button> : null}
        </section>

        {results.length ? <section className="panel conflict-results"><h3>{t('registry.actionResults')}</h3>{results.map((result) => <article key={`${result.recordId}:${result.status}`}><span>{result.status === 'applied' ? <CheckCircle2 size={15} /> : <ShieldAlert size={15} />}{result.status}</span><code>{result.recordId}</code>{result.status === 'applied' && result.changed ? <button className="button secondary" type="button" disabled={busy} onClick={() => void undo(result.recordId)}><RotateCcw size={13} />{t('registry.undoAction')}</button> : null}</article>)}</section> : null}
      </> : null}
    </div>
  )
}
