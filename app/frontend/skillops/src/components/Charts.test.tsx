// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { niceAxisMax } from './Charts'

describe('chart scaling', () => {
  it('keeps low-volume activity readable instead of forcing a fifty-run axis', () => {
    expect(niceAxisMax(0)).toBe(1)
    expect(niceAxisMax(5)).toBe(5)
    expect(niceAxisMax(6)).toBe(8)
  })
})
