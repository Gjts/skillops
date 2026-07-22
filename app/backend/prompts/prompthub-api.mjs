import { normalizeArtifactDefinition } from '../../shared/evaluation-schema.mjs'
import { sendApiError, sendJson, setJsonApiHeaders } from '../api-response.mjs'
import { createArtifactResolver } from '../evaluations/artifact-resolver.mjs'
import { EvaluationError } from '../evaluations/errors.mjs'
import { assertLocalApiRequest, readEvaluationJsonBody } from '../evaluations/request-guard.mjs'
import { initializeGovernanceServices } from '../governance/governance-api.mjs'
import { resolveGovernancePrincipal } from '../governance/principal.mjs'
import { createSecureCredentialStore } from '../secure-credential-store.mjs'
import { createPromptHubConnector } from './prompthub-connector.mjs'

function onlyKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError(`${label} must be an object.`, 422)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) throw new EvaluationError(`${label} contains unsupported field: ${unknown[0]}.`, 422)
  return value
}

function method(request, expected) {
  if (request.method !== expected) throw new EvaluationError('Method not allowed.', 405)
}


function publicPromptHubVersion(version) {
  const ref = version?.ref
  return {
    ...(ref ? { ref: { projectId: ref.projectId, revision: ref.revision, ...(ref.branch ? { branch: ref.branch } : {}) } } : {}),
    remoteId: version?.remoteId,
    remoteVersionId: version?.remoteVersionId,
    remoteHash: version?.remoteHash,
    name: version?.name,
    description: version?.description,
    type: version?.type,
    createdAt: version?.createdAt,
    artifact: normalizeArtifactDefinition(version?.artifact),
  }
}

function publicPromptHubPreview(plan) {
  return {
    mode: plan?.mode,
    persisted: plan?.persisted,
    previewToken: plan?.previewToken,
    expiresAt: plan?.expiresAt,
    targetStatus: plan?.targetStatus,
    replacesStable: plan?.replacesStable,
    ...(plan?.version ? { version: publicPromptHubVersion(plan.version) } : {}),
    ...(plan?.currentArtifact ? { currentArtifact: normalizeArtifactDefinition(plan.currentArtifact) } : {}),
    diff: {
      changed: Boolean(plan?.diff?.changed),
      changedComponents: Array.isArray(plan?.diff?.changedComponents)
        ? plan.diff.changedComponents.filter((item) => typeof item === 'string')
        : [],
    },
  }
}

function gitSourceRef(value) {
  if (typeof value !== 'string' || !value.trim().startsWith('git:') || value.trim().length > 4_000 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new EvaluationError('A committed Git Prompt source reference is required.', 422)
  }
  return value.trim()
}

async function resolveGitPromptCandidate(services, sourceRef, remote) {
  const record = await services.artifactResolver.resolve(sourceRef)
  const candidate = normalizeArtifactDefinition(record?.artifact)
  if (candidate.source !== 'git' || candidate.kind !== 'prompt') {
    throw new EvaluationError('PromptHub imports require a committed Git Prompt.', 422)
  }
  const components = ['system', 'prompt', 'model', 'configuration', 'variables']
  if (candidate.artifactId !== remote.artifact.artifactId
    || components.some((key) => candidate.componentHashes?.[key] !== remote.artifact.componentHashes?.[key])) {
    throw new EvaluationError('The committed Git Prompt does not match the previewed PromptHub version.', 409)
  }
  return candidate
}


export async function createPromptHubServices(options = {}) {
  const credentialStore = options.secureCredentialStore || createSecureCredentialStore(options)
  const artifactResolver = options.artifactResolver || createArtifactResolver(options)
  const governanceServices = options.governanceServices || await initializeGovernanceServices(options)
  const connector = options.promptHubConnector || createPromptHubConnector({
    ...options,
    credentialStore,
    listLocalArtifacts: async () => (await governanceServices.governance.list())
      .filter((capability) => capability.artifact.source === 'prompthub'
        || capability.artifact.kind === 'prompt' && /^prompthub-[1-9]\d{0,19}$/.test(capability.artifact.artifactId))
      .map((capability) => ({ artifact: capability.artifact, stage: capability.stage, updatedAt: capability.updatedAt })),
  })
  return { connector, credentialStore, governance: governanceServices.governance, teamControlPlane: governanceServices.teamControlPlane, artifactResolver }
}

let defaultServicesPromise
export function initializePromptHubServices(options = {}) {
  if (!defaultServicesPromise) defaultServicesPromise = createPromptHubServices(options)
  return defaultServicesPromise
}

export async function handlePromptHubApi(request, response, pathname, options = {}) {
  const root = pathname === '/api/connectors/prompthub'
  const credentialRoute = pathname === '/api/connectors/prompthub/credential'
  const projects = pathname === '/api/connectors/prompthub/projects'
  const version = pathname === '/api/connectors/prompthub/version'
  const preview = pathname === '/api/connectors/prompthub/import-preview'
  const importRoute = pathname === '/api/connectors/prompthub/import'
  const drift = pathname === '/api/connectors/prompthub/drift'
  const publish = pathname === '/api/connectors/prompthub/publish'
  if (!root && !credentialRoute && !projects && !version && !preview && !importRoute && !drift && !publish) return false
  setJsonApiHeaders(response)
  try {
    const bodyMethod = ['POST', 'PUT'].includes(request.method)
    assertLocalApiRequest(request, { requireJson: bodyMethod })
    const services = options.promptHubServices || await initializePromptHubServices(options)
    const authorize = async (minimumRole) => {
      const principal = await resolveGovernancePrincipal(request, options)
      await services.teamControlPlane?.authorize?.(principal, minimumRole)
      return principal
    }
    const changeCredential = async (configured, principal, operation) => {
      const previous = await services.credentialStore.get('prompthub')
      const result = await operation()
      try {
        await services.teamControlPlane?.recordConnectorCredentialChange?.('prompthub', configured, principal)
      } catch (error) {
        try {
          if (typeof previous === 'string' && previous) await services.credentialStore.set('prompthub', previous)
          else await services.credentialStore.remove('prompthub')
        } catch {
          throw new EvaluationError('PromptHub credential change failed and automatic recovery was incomplete.', 500)
        }
        throw error
      }
      return result
    }
    if (root) {
      method(request, 'GET')
      let secureCredential = false
      let secureStoreAvailable = true
      try { secureCredential = Boolean(await services.credentialStore.get('prompthub')) } catch { secureStoreAvailable = false }
      sendJson(response, 200, {
        ...services.connector.metadata,
        credentialConfigured: Boolean((options.environment || process.env).SKILLOPS_PROMPTHUB_API_KEY) || secureCredential,
        secureStoreAvailable,
      })
    } else if (credentialRoute && request.method === 'GET') {
      sendJson(response, 200, await services.credentialStore.status('prompthub'))
    } else if (credentialRoute && request.method === 'PUT') {
      const principal = await authorize('Owner')
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['apiKey']), 'PromptHub credential request')
      sendJson(response, 200, await changeCredential(true, principal, () => services.credentialStore.set('prompthub', body.apiKey)))
    } else if (credentialRoute) {
      method(request, 'DELETE')
      const principal = await authorize('Owner')
      sendJson(response, 200, await changeCredential(false, principal, () => services.credentialStore.remove('prompthub')))
    } else if (projects) {
      method(request, 'GET')
      sendJson(response, 200, { items: await services.connector.listArtifacts() })
    } else if (version) {
      method(request, 'POST')
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['projectId', 'revision', 'contentHash', 'branch']), 'PromptHub version request')
      sendJson(response, 200, publicPromptHubVersion(await services.connector.getVersion(body)))
    } else if (preview) {
      method(request, 'POST')
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['projectId', 'revision', 'contentHash', 'branch']), 'PromptHub import preview')
      sendJson(response, 200, publicPromptHubPreview(await services.connector.previewImport(body)))
    } else if (importRoute) {
      method(request, 'POST')
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['previewToken', 'gitSourceRef', 'targetSkeleton', 'projectId']), 'PromptHub import request')
      if (typeof body.previewToken !== 'string' || !body.previewToken.trim()) throw new EvaluationError('PromptHub preview token is required.', 422)
      if (typeof body.targetSkeleton !== 'string' || !body.targetSkeleton.trim()) throw new EvaluationError('PromptHub target skeleton is required.', 422)
      const sourceRef = gitSourceRef(body.gitSourceRef)
      const principal = await authorize('Developer')
      sendJson(response, 201, await services.connector.applyImport(
        body.previewToken,
        async (remote) => {
          const artifact = await resolveGitPromptCandidate(services, sourceRef, remote)
          return services.governance.nominate({
            artifact,
            owner: principal.id,
            ownerIdentityAssurance: principal.assurance,
            ...(body.projectId ? { projectId: body.projectId } : {}),
            targetSkeleton: body.targetSkeleton,
          })
        },
        (imported) => imported.reused
          ? undefined
          : services.governance.retractCandidate(imported.capability.id, { actor: principal.id }),
      ))
    } else if (drift) {
      method(request, 'GET')
      sendJson(response, 200, { items: await services.connector.compareState() })
    } else {
      method(request, 'POST')
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['artifact']), 'PromptHub publish request')
      sendJson(response, 200, await services.connector.publishVersion(body.artifact))
    }
  } catch (error) {
    sendApiError(response, error, 'PromptHub request failed.')
  }
  return true
}
