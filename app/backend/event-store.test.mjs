// @vitest-environment node
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let dataDirectory
let store

beforeAll(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), 'skillops-event-store-'))
  process.env.SKILLOPS_DATA_DIR = dataDirectory
  const moduleUrl = `${pathToFileURL(path.resolve('app/backend/event-store.mjs')).href}?test=${Date.now()}`
  store = await import(/* @vite-ignore */ moduleUrl)
})

afterAll(async () => {
  delete process.env.SKILLOPS_DATA_DIR
  await rm(dataDirectory, { recursive: true, force: true })
})

describe('event-store privacy boundary', () => {
  it('drops unknown fields before persistence', async () => {
    const created = await store.appendEvent({
      event: 'skill.completed',
      skillId: 'privacy-test',
      runtime: 'codex',
      prompt: 'private prompt content',
      toolOutput: 'private tool output',
      durationMs: 42,
    })
    const raw = await readFile(store.eventFile, 'utf8')
    expect(created).not.toHaveProperty('prompt')
    expect(raw).not.toContain('private prompt content')
    expect(raw).not.toContain('private tool output')
  })

  it('rejects non-finite numeric fields', async () => {
    await expect(store.appendEvent({ event: 'skill.completed', skillId: 'bad-number', runtime: 'codex', durationMs: 'abc' }))
      .rejects.toThrow('durationMs must be a finite number')
    await expect(store.appendEvent({ event: 'skill.completed', skillId: 'bad-number', runtime: 'codex', costUsd: Number.NaN }))
      .rejects.toThrow('costUsd must be a finite number')
  })

  it('rejects invalid timestamps and contradictory lifecycle outcomes', async () => {
    await expect(store.appendEvent({ event: 'skill.completed', skillId: 'bad-time', runtime: 'codex', timestamp: 'not-a-date' }))
      .rejects.toThrow('timestamp must be a valid date')
    await expect(store.appendEvent({ event: 'skill.completed', skillId: 'bad-outcome', runtime: 'codex', outcome: 'failed' }))
      .rejects.toThrow('skill.completed outcome')
  })

  it('normalizes lifecycle outcomes and validates an entire import before writing', async () => {
    const observed = await store.appendEvent({ event: 'skill.completed', skillId: 'observed', runtime: 'codex' })
    expect(observed.outcome).toBe('unknown')

    const before = await readFile(store.eventFile, 'utf8')
    await expect(store.appendEvents([
      { event: 'skill.completed', skillId: 'valid-first', runtime: 'codex', outcome: 'success' },
      { event: 'skill.completed', runtime: 'codex', outcome: 'success' },
    ])).rejects.toThrow('skillId is required')
    expect(await readFile(store.eventFile, 'utf8')).toBe(before)
  })

  it('keeps valid events readable when a JSONL line is truncated', async () => {
    await store.appendEvent({ event: 'session.started', runtime: 'codex', sessionId: 'valid-before-corruption' })
    await appendFile(store.eventFile, '{"event":"session.started"', 'utf8')

    const events = await store.readEvents()
    expect(events.some((event) => event.sessionId === 'valid-before-corruption')).toBe(true)
  })

  it('appends discovery events only once for the same installed definition', async () => {
    const skill = { skillId: 'deduplicated', skillVersion: '1.0.0', runtime: 'codex', sourcePath: '/skills/deduplicated/SKILL.md' }
    expect(await store.appendUniqueDiscoveries([skill])).toHaveLength(1)
    expect(await store.appendUniqueDiscoveries([skill])).toHaveLength(0)
  })

  it('selectively removes generated event ids through a recoverable backup', async () => {
    await store.appendEvents([
      { id: 'codex-desktop:remove-me', event: 'session.started', runtime: 'codex' },
      { id: 'keep-me', event: 'session.started', runtime: 'claude-code' },
    ])
    const result = await store.removeEventsByIdPrefix('codex-desktop:')
    const events = await store.readEvents()
    expect(result.removed).toBe(1)
    expect(events.some((event) => event.id === 'codex-desktop:remove-me')).toBe(false)
    expect(events.some((event) => event.id === 'keep-me')).toBe(true)
    expect(await readFile(result.backupFile, 'utf8')).toContain('codex-desktop:remove-me')
  })

  it('clears local events through a recoverable backup', async () => {
    await store.appendEvent({ event: 'session.started', runtime: 'claude-code', sessionId: 'before-clear' })
    const result = await store.clearEvents()
    expect(result.removed).toBeGreaterThan(0)
    expect(result.backupFile).toContain('.backup-')
    expect(await store.readEvents()).toEqual([])
    expect(await readFile(result.backupFile, 'utf8')).toContain('before-clear')
  })
})
