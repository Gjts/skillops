import { describe, expect, it } from 'vitest'
import { assessTailGrowth, buildAcceptance, seededRandom } from './performance.mjs'

function endpointResult(passed = true) {
  return {
    warm: {
      commandCenter: { passed },
      runs: { passed },
    },
  }
}

describe('performance protocol', () => {
  it('derives the random stream from the reported seed', () => {
    const sample = (seed) => {
      const random = seededRandom(seed)
      return Array.from({ length: 5 }, () => random())
    }

    expect(sample('skillops-personal-v1')).toEqual(sample('skillops-personal-v1'))
    expect(sample('skillops-personal-v1')).not.toEqual(sample('skillops-personal-v2'))
  })

  it('distinguishes a bounded tail plateau from sustained growth', () => {
    const mib = 1024 * 1024
    const baseline = 40 * mib
    const plateau = assessTailGrowth([
      { minute: 5, heapUsed: baseline },
      { minute: 15, heapUsed: baseline + 100_000 },
      { minute: 20, heapUsed: baseline + 180_000 },
      { minute: 25, heapUsed: baseline + 160_000 },
      { minute: 30, heapUsed: baseline + 220_000 },
    ], baseline, 30)
    const sustained = assessTailGrowth([
      { minute: 5, heapUsed: baseline },
      { minute: 15, heapUsed: baseline + 1 * mib },
      { minute: 20, heapUsed: baseline + 3 * mib },
      { minute: 25, heapUsed: baseline + 5 * mib },
      { minute: 30, heapUsed: baseline + 7 * mib },
    ], baseline, 30)

    expect(plateau).toMatchObject({ plateau: true, sampleCount: 4 })
    expect(sustained).toMatchObject({ plateau: false, sampleCount: 4 })
    expect(sustained.projectedGrowthBytes).toBeGreaterThan(sustained.toleranceBytes)
  })

  it('keeps endpoint acceptance separate from the incomplete release gate', () => {
    const acceptance = buildAcceptance({
      endpoints: endpointResult(),
      memory: null,
      dirty: true,
    })

    expect(acceptance).toMatchObject({
      commandScope: 'endpoint-only',
      endpoint: { complete: true, passed: true },
      releaseCandidate: {
        complete: false,
        passed: false,
        checks: {
          memorySoak: { passed: null, status: 'not-run' },
          browserUiTiming: { passed: null, status: 'not-measured-by-script' },
          browserNetworkBoundary: { passed: null, status: 'not-measured-by-script' },
          immutableCandidate: { passed: false, status: 'dirty' },
        },
      },
    })
    expect(acceptance.releaseCandidate.blockers).toEqual(expect.arrayContaining([
      'memory-soak-not-run',
      'browser-ui-timing-not-measured',
      'browser-network-boundary-not-measured',
      'working-tree-dirty',
    ]))

    const withPassingMemory = buildAcceptance({
      endpoints: endpointResult(),
      memory: { protocolComplete: true, passed: true },
      dirty: false,
    })
    expect(withPassingMemory).toMatchObject({
      commandScope: 'endpoint-and-memory-component',
      endpoint: { complete: true, passed: true },
      releaseCandidate: {
        complete: false,
        passed: false,
        checks: {
          memorySoak: { passed: true, status: 'passed' },
          browserUiTiming: { passed: null, status: 'not-measured-by-script' },
          browserNetworkBoundary: { passed: null, status: 'not-measured-by-script' },
          immutableCandidate: { passed: true, status: 'clean' },
        },
      },
    })
    expect(withPassingMemory.releaseCandidate.blockers).toEqual([
      'browser-ui-timing-not-measured',
      'browser-network-boundary-not-measured',
    ])
  })
})
