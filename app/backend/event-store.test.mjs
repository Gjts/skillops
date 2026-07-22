// @vitest-environment node
import { appendFile, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
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

const hmacSessionPattern = /^hmac-sha256:[a-f0-9]{64}$/

describe('event-store privacy boundary', () => {
  it('drops unknown fields before persistence', async () => {
    const created = await store.appendEvent({
      event: 'skill.completed',
      skillId: 'privacy-test',
      runtime: 'codex',
      prompt: 'private prompt content',
      toolOutput: 'private tool output',
      error: 'private provider error details',
      durationMs: 42,
    })
    const raw = await readFile(store.eventFile, 'utf8')
    expect(created).not.toHaveProperty('prompt')
    expect(raw).not.toContain('private prompt content')
    expect(raw).not.toContain('private tool output')
    expect(raw).not.toContain('private provider error details')
  })

  it('pseudonymizes session identifiers and embedded event ids with a stable per-install HMAC', async () => {
    const rawSessionId = 'account@example.com/session-123'
    const first = await store.appendEvent({
      id: `collector:${rawSessionId}:turn-1:session.started`,
      event: 'session.started',
      runtime: 'codex',
      sessionId: rawSessionId,
    })
    const second = await store.appendEvent({ event: 'turn.completed', runtime: 'codex', sessionId: rawSessionId })
    const reloaded = await import(/* @vite-ignore */ `${pathToFileURL(path.resolve('app/backend/event-store.mjs')).href}?reload=${Date.now()}`)
    const third = await reloaded.appendEvent({ event: 'session.completed', runtime: 'codex', sessionId: rawSessionId })

    expect(first.sessionId).toMatch(hmacSessionPattern)
    expect(second.sessionId).toBe(first.sessionId)
    expect(third.sessionId).toBe(first.sessionId)
    expect(first.id).toContain(first.sessionId)
    expect(await readFile(store.eventFile, 'utf8')).not.toContain(rawSessionId)
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

  it('keeps valid events readable without mutating a truncated JSONL file', async () => {
    const saved = await store.appendEvent({ event: 'session.started', runtime: 'codex', sessionId: 'valid-before-corruption' })
    await appendFile(store.eventFile, '{"event":"session.started"', 'utf8')
    const before = await readFile(store.eventFile, 'utf8')

    const events = await store.readEvents()
    expect(events.some((event) => event.sessionId === saved.sessionId)).toBe(true)
    expect(await readFile(store.eventFile, 'utf8')).toBe(before)
  })

  it('migrates valid legacy rows and drops malformed rows through an explicit recoverable command', async () => {
    const rawSessionId = 'account@example.com/session-123'
    await writeFile(store.eventFile, `${JSON.stringify({
      id: `legacy:${rawSessionId}:session.started`,
      event: 'session.started',
      runtime: 'codex',
      timestamp: '2026-07-22T00:00:00.000Z',
      sessionId: rawSessionId,
    })}\n{"event":"truncated","sessionId":"${rawSessionId}"\n`, 'utf8')
    const before = await readFile(store.eventFile, 'utf8')

    const [event] = await store.readEvents()
    expect(event.sessionId).toMatch(hmacSessionPattern)
    expect(event.id).not.toContain(rawSessionId)
    expect(await readFile(store.eventFile, 'utf8')).toBe(before)

    const result = await store.migrateLegacyEvents()
    const persisted = await readFile(store.eventFile, 'utf8')
    expect(result).toEqual({ migrated: 1, removed: 1, backupFile: expect.stringContaining('.backup-') })
    expect(await readFile(result.backupFile, 'utf8')).toBe(before)
    expect(persisted).not.toContain(rawSessionId)
    expect(persisted).not.toContain('truncated')
    expect(persisted.trim().split('\n')).toHaveLength(1)
    expect(await store.migrateLegacyEvents()).toEqual({ migrated: 0, removed: 0, backupFile: undefined })
  })

  it('removes retired fields from valid legacy rows only during explicit migration', async () => {
    await writeFile(store.eventFile, `${JSON.stringify({
      id: 'legacy-failure',
      event: 'skill.failed',
      skillId: 'privacy-test',
      runtime: 'codex',
      timestamp: '2026-07-22T00:00:00.000Z',
      error: 'private provider error details',
    })}\n`, 'utf8')

    const [event] = await store.readEvents()
    expect(event).not.toHaveProperty('error')
    expect(await readFile(store.eventFile, 'utf8')).toContain('private provider error details')
    await store.migrateLegacyEvents()
    expect(await readFile(store.eventFile, 'utf8')).not.toContain('private provider error details')
  })

  it('prunes expired events and event backups under the store lock', async () => {
    const oldEvent = { id: 'old', event: 'session.started', runtime: 'codex', timestamp: '2026-07-20T00:00:00.000Z' }
    const currentEvent = { id: 'current', event: 'session.started', runtime: 'codex', timestamp: '2026-07-22T00:00:00.000Z' }
    await writeFile(store.eventFile, `${JSON.stringify(oldEvent)}\n${JSON.stringify(currentEvent)}\n`, 'utf8')
    const expiredBackup = `${store.eventFile}.backup-expired`
    await writeFile(expiredBackup, 'expired', 'utf8')
    await utimes(expiredBackup, new Date('2026-07-19T00:00:00.000Z'), new Date('2026-07-19T00:00:00.000Z'))

    const result = await store.pruneEventsBefore('2026-07-21T00:00:00.000Z', { directory: dataDirectory })

    expect(result).toEqual({
      removed: 1,
      retained: 1,
      removedBackups: 1,
      backupFile: expect.stringContaining('.backup-'),
    })
    expect(await store.readEvents()).toEqual([expect.objectContaining({ id: 'current' })])
    await expect(readFile(expiredBackup, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(result.backupFile, 'utf8')).toContain('"id":"old"')
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
    expect(await readFile(result.backupFile, 'utf8')).not.toContain('before-clear')
  })
})
