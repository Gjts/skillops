import { readEvaluationJsonBody, assertLocalApiRequest } from '../evaluations/request-guard.mjs'
import { ConflictError, createConflictService } from './conflict-service.mjs'

let service

export function initializeConflictServices(options = {}) {
  service = createConflictService(options)
  return service
}

export async function handleConflictApi(request, response, pathname) {
  if (!pathname.startsWith('/api/conflicts/')) return false
  response.setHeader('Content-Type', 'application/json')
  try {
    if (request.method !== 'POST') throw new ConflictError('Method not allowed.', 405)
    assertLocalApiRequest(request, { requireJson: true })
    const body = await readEvaluationJsonBody(request)
    const conflicts = service || initializeConflictServices()
    let result
    if (pathname === '/api/conflicts/inspect') result = await conflicts.inspect(body)
    else if (pathname === '/api/conflicts/preview') result = await conflicts.preview(body)
    else if (pathname === '/api/conflicts/apply') result = await conflicts.apply(body.previewToken, { confirm: body.confirm, confirmedDefinitionKey: body.confirmedDefinitionKey })
    else if (pathname === '/api/conflicts/batch') result = await conflicts.applyBatch(body.items)
    else if (pathname === '/api/conflicts/undo') result = await conflicts.undo(body.recordId)
    else throw new ConflictError('Conflict endpoint not found.', 404)
    response.end(JSON.stringify(result))
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : Number.isInteger(error?.status) ? error.status : 500
    response.statusCode = status
    response.end(JSON.stringify({ error: status === 500 ? 'Conflict action failed.' : error.message }))
  }
  return true
}
