import { describe, expect, it } from 'vitest'
import { createPageEnvelope } from './page-envelope.mjs'

const byId = (left, right) => left.id.localeCompare(right.id, 'en-US')

describe('page envelope', () => {
  it('sorts before slicing and returns the shared page metadata', () => {
    const source = Array.from({ length: 45 }, (_, index) => ({ id: `item-${String(45 - index).padStart(2, '0')}` }))
    const result = createPageEnvelope(source, { page: '2', pageSize: '20', compare: byId })

    expect(result).toEqual({
      items: Array.from({ length: 20 }, (_, index) => ({ id: `item-${String(index + 21).padStart(2, '0')}` })),
      page: 2,
      pageSize: 20,
      totalItems: 45,
      totalPages: 3,
      hasPrevious: true,
      hasNext: true,
    })
    expect(source[0]).toEqual({ id: 'item-45' })
  })

  it('defaults to page one with 50 items and preserves an empty final page', () => {
    const source = Array.from({ length: 51 }, (_, index) => ({ id: `item-${String(index + 1).padStart(2, '0')}` }))
    expect(createPageEnvelope(source, { compare: byId })).toMatchObject({
      page: 1,
      pageSize: 50,
      totalItems: 51,
      totalPages: 2,
      hasPrevious: false,
      hasNext: true,
    })
    expect(createPageEnvelope(source, { page: 4, pageSize: 20, compare: byId })).toMatchObject({
      items: [],
      page: 4,
      totalPages: 3,
      hasPrevious: true,
      hasNext: false,
    })
  })

  it.each([
    [{ page: '0' }, 'page must be between 1 and 1000000.'],
    [{ page: '1.5' }, 'page must be a positive integer.'],
    [{ pageSize: '25' }, 'pageSize must be 20, 50, or 100.'],
    [{ pageSize: '' }, 'pageSize must be a positive integer.'],
  ])('rejects an invalid bounded query %#', (query, message) => {
    expect(() => createPageEnvelope([], { ...query, compare: byId })).toThrow(message)
  })
})
