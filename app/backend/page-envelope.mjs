import { EvaluationError } from './evaluations/errors.mjs'

const PAGE_SIZES = new Set([20, 50, 100])
const MAX_PAGE = 1_000_000

function positiveInteger(value, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null) return fallback
  const serialized = typeof value === 'number' ? String(value) : value
  if (typeof serialized !== 'string' || !/^\d+$/.test(serialized)) {
    throw new EvaluationError(`${name} must be a positive integer.`, 400)
  }
  const parsed = Number(serialized)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new EvaluationError(`${name} must be between 1 and ${maximum}.`, 400)
  }
  return parsed
}

export function createPageEnvelope(items, { page, pageSize, compare } = {}) {
  if (!Array.isArray(items)) throw new TypeError('Pagination items must be an array.')
  if (typeof compare !== 'function') throw new TypeError('Pagination requires a stable comparator.')
  const normalizedPage = positiveInteger(page, 'page', 1, MAX_PAGE)
  const normalizedPageSize = positiveInteger(pageSize, 'pageSize', 50, 100)
  if (!PAGE_SIZES.has(normalizedPageSize)) {
    throw new EvaluationError('pageSize must be 20, 50, or 100.', 400)
  }
  const ordered = [...items].sort(compare)
  const totalItems = ordered.length
  const totalPages = Math.ceil(totalItems / normalizedPageSize)
  const offset = (normalizedPage - 1) * normalizedPageSize
  return {
    items: ordered.slice(offset, offset + normalizedPageSize),
    page: normalizedPage,
    pageSize: normalizedPageSize,
    totalItems,
    totalPages,
    hasPrevious: totalItems > 0 && normalizedPage > 1,
    hasNext: normalizedPage < totalPages,
  }
}
