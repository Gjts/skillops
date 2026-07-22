import { createHash, timingSafeEqual } from 'node:crypto'
import os from 'node:os'
import { EvaluationError } from '../evaluations/errors.mjs'

function principal(value) {
  const input = typeof value === 'string' ? { id: value } : value
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EvaluationError('Governance principal is unavailable.', 403)
  if (typeof input.id !== 'string' || !input.id.trim() || input.id.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(input.id)) {
    throw new EvaluationError('Governance principal is invalid.', 403)
  }
  return {
    id: input.id.trim(),
    displayName: typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim().slice(0, 200) : input.id.trim(),
    assurance: typeof input.assurance === 'string' && input.assurance.trim() ? input.assurance.trim().slice(0, 100) : 'authenticated-provider',
  }
}

let cachedConfig

function configuredPrincipals(raw) {
  if (!raw) return []
  if (cachedConfig?.raw === raw) return cachedConfig.entries
  try {
    if (raw.length > 65_536) throw new Error()
    const records = JSON.parse(raw)
    if (!Array.isArray(records) || records.length > 100) throw new Error()
    const tokens = new Set()
    const entries = records.map((record) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error()
      if (typeof record.token !== 'string' || record.token.length < 32 || record.token.length > 512 || /[\u0000-\u0020\u007f]/.test(record.token)) throw new Error()
      const digest = createHash('sha256').update(record.token, 'utf8').digest()
      const key = digest.toString('hex')
      if (tokens.has(key)) throw new Error()
      tokens.add(key)
      return { digest, principal: principal({ ...record, assurance: 'configured-bearer-token' }) }
    })
    cachedConfig = { raw, entries }
    return entries
  } catch {
    throw new EvaluationError('Governance principal configuration is invalid.', 500)
  }
}

function requestToken(request) {
  const authorization = request?.headers?.authorization
  if (authorization === undefined) return null
  const match = typeof authorization === 'string' && /^Bearer ([\x21-\x7e]{32,512})$/.exec(authorization)
  if (!match) throw new EvaluationError('Governance credentials are invalid.', 403)
  return match[1]
}

function authenticatedPrincipal(request, options) {
  const token = requestToken(request)
  if (!token) return null
  const digest = createHash('sha256').update(token, 'utf8').digest()
  const match = configuredPrincipals((options.environment || process.env).SKILLOPS_GOVERNANCE_PRINCIPALS)
    .find((entry) => timingSafeEqual(entry.digest, digest))
  if (!match) throw new EvaluationError('Governance credentials are invalid.', 403)
  return match.principal
}

export async function resolveAuthenticatedGovernancePrincipal(request, options = {}) {
  if (typeof options.resolveGovernancePrincipal === 'function') return principal(await options.resolveGovernancePrincipal(request))
  const authenticated = authenticatedPrincipal(request, options)
  if (!authenticated) throw new EvaluationError('Governance credentials are required.', 403)
  return authenticated
}

export async function resolveGovernancePrincipal(request, options = {}) {
  if (typeof options.resolveGovernancePrincipal === 'function') return principal(await options.resolveGovernancePrincipal(request))
  const authenticated = authenticatedPrincipal(request, options)
  if (authenticated) return authenticated
  let user
  try { user = os.userInfo().username } catch { throw new EvaluationError('The local operating-system principal is unavailable.', 403) }
  return principal({
    id: `os:${os.hostname()}\\${user}`,
    displayName: `${user}@${os.hostname()}`,
    assurance: 'local-os-account',
  })
}
