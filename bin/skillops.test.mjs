// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { flags } from './skillops.mjs'

describe('SkillOps CLI flags', () => {
  it('treats a trailing flag and a flag followed by another flag as booleans', () => {
    expect(flags(['--verbose'])).toEqual({ verbose: true })
    expect(flags(['--verbose', '--runtime', 'codex', '--dry-run'])).toEqual({
      verbose: true,
      runtime: 'codex',
      'dry-run': true,
    })
  })
})
