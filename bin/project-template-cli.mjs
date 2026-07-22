import path from 'node:path'
import { computeTeamTemplateHash, createProjectTemplateManager, loadTeamTemplate, loadTeamTemplateNomination, readTeamTemplateDraft, verifyTeamTemplateNomination } from '../app/backend/project-template.mjs'
import { EvaluationError } from '../app/backend/evaluations/errors.mjs'
import { createEvaluationStore } from '../app/backend/evaluations/evaluation-store.mjs'
import { createCapabilityRegistry } from '../app/backend/governance/capability-registry.mjs'
import { createGovernanceAuditLog } from '../app/backend/governance/governance-audit.mjs'
import { resolveGovernancePrincipal } from '../app/backend/governance/principal.mjs'
import { createTeamTemplateApprovalStore } from '../app/backend/team-template-approvals.mjs'
import { evaluationRun } from './evaluation-cli.mjs'
import { flags } from './cli-flags.mjs'

function required(options, name) {
  const value = options[name]
  if (typeof value !== 'string' || !value.trim()) throw new EvaluationError(`Missing required --${name}.`, 422)
  return value.trim()
}

function appendOption(args, options, name) {
  if (typeof options[name] === 'string' && options[name].trim()) args.push(`--${name}`, options[name].trim())
}

function governanceServices(dependencies) {
  return {
    evaluationStore: dependencies.evaluationStore || createEvaluationStore(dependencies),
    capabilityRegistry: dependencies.capabilityRegistry || createCapabilityRegistry(dependencies),
    auditLog: dependencies.auditLog || createGovernanceAuditLog(dependencies),
    templateApprovals: dependencies.templateApprovals || createTeamTemplateApprovalStore(dependencies),
  }
}

export async function projectTemplateInit(args, dependencies = {}) {
  const options = flags(args)
  for (const name of ['approve', 'status', 'apply', 'rollback', 'hash', 'nominate']) {
    if (options[name] !== undefined && options[name] !== true) throw new EvaluationError(`--${name} does not accept a value.`, 422)
  }
  if (options['api-key']) throw new EvaluationError('Use --api-key-env or SKILLOPS_EVAL_API_KEY instead of putting a key on the command line.', 422)
  const governance = governanceServices(dependencies)
  if (options.approve === true) {
    const reviewer = await (dependencies.resolvePrincipal || resolveGovernancePrincipal)(null, dependencies)
    return governance.templateApprovals.approve(required(options, 'approval'), { reviewer })
  }
  if (options.status === true && (options.apply === true || options.rollback === true)) throw new EvaluationError('--status cannot be combined with --apply or --rollback.', 422)
  const manifestFile = required(options, 'manifest')
  if (options.hash === true) {
    const draft = await (dependencies.loadDraft || readTeamTemplateDraft)(manifestFile)
    const contentHash = (dependencies.computeHash || computeTeamTemplateHash)(draft)
    return { id: draft.id, version: draft.version, contentHash }
  }
  if (options.nominate === true) {
    const manifest = await (dependencies.loadNomination || loadTeamTemplateNomination)(manifestFile)
    await (dependencies.verifyNomination || verifyTeamTemplateNomination)(manifest, governance)
    const submitter = await (dependencies.resolvePrincipal || resolveGovernancePrincipal)(null, dependencies)
    return governance.templateApprovals.nominate({
      templateId: manifest.id,
      version: manifest.version,
      templateHash: manifest.templateHash,
      runId: manifest.release.evidence.runId,
      suiteId: manifest.release.evidence.suiteId,
      evidenceHash: manifest.release.evidence.evidenceHash,
      submitter,
    })
  }
  const manifest = await (dependencies.loadTemplate || loadTeamTemplate)(manifestFile)
  const targetRoot = path.resolve(typeof options.target === 'string' ? options.target : process.cwd())
  const runEvaluation = dependencies.evaluationRun || evaluationRun
  const evaluateSuite = async (suite, context) => {
    const evaluationArgs = [
      '--suite', suite.id,
      '--baseline', suite.baselineRef || `${manifest.id}@${context.currentLock?.template?.version || 'unmanaged'}`,
      '--candidate', suite.candidateRef || `${manifest.id}@${manifest.version}`,
    ]
    evaluationArgs.push('--subject-hash', manifest.templateHash)
    if (suite.deterministic) evaluationArgs.push('--deterministic')
    for (const name of ['provider', 'model', 'base-url', 'api-key-env', 'reasoning-effort', 'timeout-ms']) appendOption(evaluationArgs, options, name)
    return runEvaluation(evaluationArgs)
  }
  const manager = (dependencies.createManager || createProjectTemplateManager)({ targetRoot, manifest, evaluateSuite, governance })
  if (options.status === true) return manager.status()
  if (options.rollback === true) return options.apply === true ? manager.rollback() : manager.previewRollback()
  const mode = typeof options.mode === 'string' ? options.mode : 'greenfield'
  return options.apply === true ? manager.apply(mode) : manager.preview(mode)
}
