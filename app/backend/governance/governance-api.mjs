import { sendApiError, sendJson, setJsonApiHeaders } from '../api-response.mjs'
import { createArtifactResolver } from '../evaluations/artifact-resolver.mjs'
import { createEvaluationStore } from '../evaluations/evaluation-store.mjs'
import { EvaluationError } from '../evaluations/errors.mjs'
import { assertLocalApiRequest, readEvaluationJsonBody } from '../evaluations/request-guard.mjs'
import { createSuiteRegistry } from '../evaluations/suite-registry.mjs'
import { createPageEnvelope } from '../page-envelope.mjs'
import { createTeamControlPlane } from '../team-control-plane.mjs'
import { DEFAULT_GATE_POLICY, effectiveGatePolicy, evaluateGatePolicy, normalizeGatePolicy } from './capability-policy.mjs'
import { createGovernanceService } from './governance-service.mjs'
import { resolveAuthenticatedGovernancePrincipal, resolveGovernancePrincipal } from './principal.mjs'

function onlyKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError(`${label} must be an object.`, 422)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) throw new EvaluationError(`${label} contains unsupported field: ${unknown[0]}.`, 422)
  return value
}

function method(request, expected) {
  if (request.method !== expected) throw new EvaluationError('Method not allowed.', 405)
}

function query(request) {
  return new URL(request.url || '/', 'http://127.0.0.1').searchParams
}

function compareCapabilities(left, right) {
  const leftCreatedAt = typeof left.createdAt === 'string' ? left.createdAt : ''
  const rightCreatedAt = typeof right.createdAt === 'string' ? right.createdAt : ''
  if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt > rightCreatedAt ? -1 : 1
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function limitedQuery(search, name) {
  const value = search.get(name)
  if (value === null) return null
  if (!value.trim() || value.length > 200) throw new EvaluationError(`${name} is invalid.`, 400)
  return value.trim()
}

function withReleaseTarget(item, lock) {
  const target = lock.targets?.[item.targetKey || item.targetSkeleton]
  return {
    ...item,
    releaseTarget: {
      stableCapabilityId: target?.stable?.capabilityId || null,
      previousStableCapabilityId: target?.previous?.[0]?.capabilityId || null,
    },
  }
}

function withoutEffectiveGate(item) {
  return {
    ...item,
    effectiveGateResult: 'not-evaluated',
    effectiveGates: [],
    effectivePolicyHash: null,
  }
}

async function policyForCapability(item, services) {
  const basePolicy = normalizeGatePolicy(services.gatePolicy || DEFAULT_GATE_POLICY)
  const policyId = item.policyId || basePolicy.id
  if (policyId === basePolicy.id) return basePolicy
  if (typeof services.resolveGatePolicy !== 'function') return null
  const resolved = await services.resolveGatePolicy({ policyId, projectId: item.projectId || null })
  if (resolved?.waived) {
    if (!resolved.exceptionId || !item.projectId || resolved.projectId !== item.projectId) return null
    return basePolicy
  }
  const selected = normalizeGatePolicy(resolved?.policy)
  return selected.id === policyId ? selected : null
}

async function withEffectiveGate(item, services) {
  if (!item?.evidence || item.evidenceStale !== false || typeof services.evaluations?.getRun !== 'function') {
    return withoutEffectiveGate(item)
  }
  const run = await services.evaluations.getRun(item.evidence.qualityRunId)
  if (run?.id !== item.evidence.qualityRunId
    || run.status !== 'completed'
    || run.mode !== 'suite'
    || run.evidenceHash !== item.evidence.qualityEvidenceHash) {
    return withoutEffectiveGate(item)
  }
  const policy = await policyForCapability(item, services)
  if (!policy) return withoutEffectiveGate(item)
  let suiteGate
  try {
    const suite = run.suiteId && typeof services.suites?.get === 'function'
      ? await services.suites.get(run.suiteId)
      : null
    if (suite && (suite.suiteHash !== run.suiteHash
      || (suite.datasetHash || null) !== (run.datasetHash || null))) {
      return withoutEffectiveGate(item)
    }
    suiteGate = suite?.gate
  } catch (error) {
    if (error instanceof EvaluationError && error.status === 404) return withoutEffectiveGate(item)
    throw error
  }
  const evaluated = evaluateGatePolicy({
    ...run,
    redteamEvidenceHash: item.evidence.redteamEvidenceHash || null,
  }, effectiveGatePolicy(policy, suiteGate))
  return {
    ...item,
    effectiveGateResult: evaluated.gateResult,
    effectiveGates: evaluated.gates,
    effectivePolicyHash: evaluated.policyHash,
  }
}

function capabilityRoute(pathname) {
  const match = pathname.match(/^\/api\/capabilities\/([^/]+)(?:\/(audit|evaluate|approve|canary|install|promote|deprecate|rollback))?$/)
  if (!match) return null
  try { return { id: decodeURIComponent(match[1]), action: match[2] || null } } catch { throw new EvaluationError('Capability ID is invalid.', 422) }
}

export async function createGovernanceServices(options = {}) {
  const evaluations = options.evaluations || createEvaluationStore(options)
  const suites = options.suites || createSuiteRegistry(options)
  const artifacts = options.artifacts || createArtifactResolver(options)
  const teamControlPlane = options.teamControlPlane || createTeamControlPlane(options)
  const gatePolicy = normalizeGatePolicy(options.policy || DEFAULT_GATE_POLICY)
  const resolveGatePolicy = options.resolveGatePolicy || teamControlPlane.resolveGatePolicy
  const governance = options.governance || createGovernanceService({
    ...options,
    evaluations,
    artifacts,
    policy: gatePolicy,
    resolveGatePolicy,
    resolveSuite: options.resolveSuite || ((suiteId) => suites.get(suiteId)),
    resolveProjectRoot: options.resolveProjectRoot || teamControlPlane.resolveProjectRoot,
  })
  await governance.initialize?.()
  return { governance, artifacts, evaluations, suites, gatePolicy, resolveGatePolicy, teamControlPlane }
}

let defaultServicesPromise

export function initializeGovernanceServices(options = {}) {
  if (!defaultServicesPromise) defaultServicesPromise = createGovernanceServices(options)
  return defaultServicesPromise
}

export async function handleGovernanceApi(request, response, pathname, options = {}) {
  const collection = pathname === '/api/capabilities'
  const route = capabilityRoute(pathname)
  const lockRoute = pathname === '/api/project-skeleton-lock'
  const auditRoute = pathname === '/api/governance-audit'
  if (!collection && !route && !lockRoute && !auditRoute) return false
  setJsonApiHeaders(response)
  try {
    const post = request.method === 'POST'
    assertLocalApiRequest(request, { requireJson: post })
    const services = options.governanceServices || await initializeGovernanceServices(options)
    const { governance, artifacts, teamControlPlane } = services
    let principal = post ? await resolveGovernancePrincipal(request, options) : null
    const authorize = async (minimumRole) => {
      if (!teamControlPlane?.authorize) return
      principal ||= await resolveGovernancePrincipal(request, options)
      await teamControlPlane.authorize(principal, minimumRole)
    }
    if (auditRoute) {
      method(request, 'GET')
      principal = await resolveAuthenticatedGovernancePrincipal(request, options)
      await authorize('Viewer')
      const search = query(request)
      const result = await governance.audit.page({
        page: search.get('page'),
        pageSize: search.get('pageSize'),
      })
      sendJson(response, 200, { ...result, generatedAt: new Date().toISOString() })
    } else if (collection && request.method === 'GET') {
      await authorize('Viewer')
      const [items, lock] = await Promise.all([governance.list(), governance.lockState()])
      const search = query(request)
      const evaluationRunId = limitedQuery(search, 'evaluationRunId')
      const filtered = evaluationRunId
        ? items.filter((item) => item.originEvaluationRunId === evaluationRunId || item.latestEvidenceRunId === evaluationRunId)
        : items
      const result = createPageEnvelope(filtered, {
        page: search.get('page'),
        pageSize: search.get('pageSize'),
        compare: compareCapabilities,
      })
      sendJson(response, 200, {
        ...result,
        items: await Promise.all(result.items.map((item) => withEffectiveGate(withReleaseTarget(item, lock), services))),
        generatedAt: new Date().toISOString(),
      })
    } else if (collection) {
      method(request, 'POST')
      await authorize('Developer')
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['artifact', 'sourceRef', 'baseline', 'targetSkeleton', 'projectId', 'policyId', 'evaluationRunId']), 'Capability nomination')
      const targetSkeleton = body.targetSkeleton || (body.sourceRef?.startsWith('local-scan:') ? body.sourceRef : null)
      if (!targetSkeleton) throw new EvaluationError('Capability nomination requires an explicit target skeleton.', 422)
      if (Boolean(body.artifact) === Boolean(body.sourceRef)) throw new EvaluationError('Capability nomination requires exactly one artifact or sourceRef.', 422)
      const resolved = body.sourceRef ? await artifacts.resolve(body.sourceRef) : null
      const result = await governance.nominate({
        artifact: resolved?.artifact || body.artifact,
        ...(body.baseline ? { baseline: body.baseline } : {}),
        ...(body.policyId ? { policyId: body.policyId } : {}),
        ...(body.projectId ? { projectId: body.projectId } : {}),
        ...(body.evaluationRunId ? { originEvaluationRunId: body.evaluationRunId } : {}),
        owner: principal.id,
        ownerIdentityAssurance: principal.assurance,
        targetSkeleton,
      })
      sendJson(response, result.reused ? 200 : 201, result)
    } else if (lockRoute) {
      method(request, 'GET')
      principal = await resolveAuthenticatedGovernancePrincipal(request, options)
      await authorize('Viewer')
      sendJson(response, 200, await governance.lockState())
    } else if (!route.action) {
      method(request, 'GET')
      await authorize('Viewer')
      const [item, lock] = await Promise.all([governance.get(route.id), governance.lockState()])
      sendJson(response, 200, await withEffectiveGate(withReleaseTarget(item, lock), services))
    } else if (route.action === 'audit') {
      method(request, 'GET')
      principal = await resolveAuthenticatedGovernancePrincipal(request, options)
      await authorize('Viewer')
      const search = query(request)
      const result = await governance.audit.page({
        capabilityId: route.id,
        page: search.get('page'),
        pageSize: search.get('pageSize'),
      })
      sendJson(response, 200, { ...result, generatedAt: new Date().toISOString() })
    } else {
      method(request, 'POST')
      if (route.action === 'approve') principal = await resolveAuthenticatedGovernancePrincipal(request, options)
      if (route.action === 'evaluate') {
        const capability = await governance.get(route.id)
        await authorize(capability?.stage === 'canary' ? 'Maintainer' : 'Developer')
      } else {
        await authorize(route.action === 'approve' ? 'Reviewer' : ['canary', 'install', 'promote', 'deprecate', 'rollback'].includes(route.action) ? 'Maintainer' : 'Developer')
      }
      const body = await readEvaluationJsonBody(request)
      if (route.action === 'evaluate') {
        onlyKeys(body, new Set(['runId', 'redteamRunId']), 'Evidence binding request')
        const capability = await governance.bindEvidence(route.id, { ...body, actor: principal.id })
        sendJson(response, 200, await withEffectiveGate(capability, services))
      } else if (route.action === 'approve') {
        onlyKeys(body, new Set(['decision']), 'Approval request')
        sendJson(response, 200, await governance.approve(route.id, {
          ...body,
          reviewer: principal.id,
          reviewerIdentityAssurance: principal.assurance,
        }))
      } else {
        const actions = {
          canary: ['previewCanary', 'canary'],
          install: ['previewInstallation', 'install'],
          promote: ['previewPromotion', 'promote'],
          deprecate: ['previewDeprecation', 'deprecate'],
          rollback: ['previewRollback', 'rollback'],
        }
        const methods = actions[route.action]
        const allowed = new Set(['action', 'previewToken', 'confirm', ...(route.action === 'canary' ? ['targetSkeleton', 'projectRoot'] : [])])
        onlyKeys(body, allowed, 'Release request')
        if (body.action === 'preview') {
          sendJson(response, 200, await governance[methods[0]](route.id, route.action === 'canary'
            ? { targetSkeleton: body.targetSkeleton, projectRoot: body.projectRoot }
            : undefined))
        } else if (body.action === 'apply') {
          sendJson(response, 200, await governance[methods[1]](route.id, { ...body, actor: principal.id }))
        }
        else throw new EvaluationError('Release action must be preview or apply.', 422)
      }
    }
  } catch (error) {
    sendApiError(response, error, 'Governance request failed.')
  }
  return true
}
