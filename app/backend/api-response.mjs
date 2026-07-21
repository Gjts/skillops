import { EvaluationSchemaError } from '../shared/evaluation-schema.mjs'
import { EvaluationError } from './evaluations/errors.mjs'

const STATUS_CODES = new Map([
  [400, 'INVALID_REQUEST'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [405, 'METHOD_NOT_ALLOWED'],
  [409, 'CONFLICT'], [413, 'PAYLOAD_TOO_LARGE'], [415, 'UNSUPPORTED_MEDIA_TYPE'],
  [422, 'VALIDATION_FAILED'], [429, 'PROVIDER_RATE_LIMITED'], [502, 'UPSTREAM_FAILURE'], [503, 'SERVICE_UNAVAILABLE'],
])

export function setJsonApiHeaders(response) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
}

export function sendJson(response, status, body) {
  response.statusCode = status
  response.end(body === undefined ? '' : JSON.stringify(body))
}

export function sendApiError(response, error, fallback = 'Local API request failed.') {
  const known = error instanceof EvaluationError || error instanceof EvaluationSchemaError
  const status = known && Number.isInteger(error.status) ? error.status : 500
  sendJson(response, status, {
    error: {
      code: STATUS_CODES.get(status) || 'INTERNAL_ERROR',
      ...(known && typeof error.publicCode === 'string' ? { code: error.publicCode } : {}),
      message: known ? error.message : fallback,
    },
  })
}
