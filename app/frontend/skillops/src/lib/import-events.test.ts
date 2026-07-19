import { describe, expect, it } from 'vitest'
import { parseEventFile } from './import-events'

const event = { id: 'one', event: 'session.started', runtime: 'codex', timestamp: '2026-07-19T00:00:00.000Z' }

describe('event file import', () => {
  it('accepts both JSON arrays and JSONL records', () => {
    expect(parseEventFile(JSON.stringify([event]))).toEqual([event])
    expect(parseEventFile(`${JSON.stringify(event)}\n`)).toEqual([event])
  })

  it('reports the broken JSONL line', () => {
    expect(() => parseEventFile(`${JSON.stringify(event)}\n{"event":`)).toThrow('line 2')
  })

  it('rejects unsupported event names, runtimes, and timestamps', () => {
    expect(() => parseEventFile(JSON.stringify([{ ...event, event: 'not-real' }]))).toThrow('unsupported event')
    expect(() => parseEventFile(JSON.stringify([{ ...event, runtime: 'not-real' }]))).toThrow('unsupported runtime')
    expect(() => parseEventFile(JSON.stringify([{ ...event, timestamp: 'not-a-date' }]))).toThrow('invalid timestamp')
  })

  it('uses the same lifecycle outcome rules as the HTTP event store', () => {
    expect(() => parseEventFile(JSON.stringify([{ ...event, event: 'skill.completed', skillId: undefined }]))).toThrow('skillId is required')
    expect(() => parseEventFile(JSON.stringify([{ ...event, event: 'skill.completed', skillId: 'bad-outcome', outcome: 'failed' }]))).toThrow('skill.completed outcome')
    expect(parseEventFile(JSON.stringify([{ ...event, event: 'skill.completed', skillId: 'observed' }]))[0]).toMatchObject({ outcome: 'unknown' })
  })
})
