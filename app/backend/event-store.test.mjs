// @vitest-environment node
import { mkdirSync, rmSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
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

  it('keeps JSONL runs with null cost as unreported', async () => {
    const id = `null-cost-${Date.now()}`
    await appendFile(store.eventFile, `${JSON.stringify({ id, event: 'skill.completed', skillId: 'null-cost', runtime: 'codex', timestamp: new Date().toISOString(), costUsd: null })}\n`, 'utf8')

    const saved = (await store.readEvents()).find((event) => event.id === id)

    expect(saved).toBeTruthy()
    expect(saved).not.toHaveProperty('costUsd')
  })

  it('keeps valid events readable without mutating a truncated JSONL file', async () => {
    const saved = await store.appendEvent({ event: 'session.started', runtime: 'codex', sessionId: 'valid-before-corruption' })
    await appendFile(store.eventFile, '{"event":"session.started"', 'utf8')
    const before = await readFile(store.eventFile, 'utf8')

    const snapshot = await store.readEventsWithStatus()
    expect(snapshot.events.some((event) => event.sessionId === saved.sessionId)).toBe(true)
    expect(snapshot.sourceStatus).toBe('partial')
    await expect(store.appendEvent({ event: 'session.started', runtime: 'codex' })).rejects.toThrow('partial trailing record')
    expect(await readFile(store.eventFile, 'utf8')).toBe(before)
    await store.migrateLegacyEvents({ backup: false })
  })

  it('rejects a malformed final record that was fully written with a newline', async () => {
    await appendFile(store.eventFile, '{"event":"session.started"\n', 'utf8')
    const before = await readFile(store.eventFile, 'utf8')

    await expect(store.readEventsWithStatus()).rejects.toThrow('malformed record')
    expect(await readFile(store.eventFile, 'utf8')).toBe(before)
    await store.migrateLegacyEvents({ backup: false })
  })

  it('does not misclassify a complete invalid record without a newline as partial', async () => {
    await appendFile(store.eventFile, 'not-json', 'utf8')
    const before = await readFile(store.eventFile, 'utf8')

    await expect(store.readEventsWithStatus()).rejects.toThrow('malformed record')
    expect(await readFile(store.eventFile, 'utf8')).toBe(before)
    await store.migrateLegacyEvents({ backup: false })
  })

  it('rejects a structurally invalid final event even without a trailing newline', async () => {
    await appendFile(store.eventFile, '[]', 'utf8')
    const before = await readFile(store.eventFile, 'utf8')

    await expect(store.readEventsWithStatus()).rejects.toThrow('malformed record')
    expect(await readFile(store.eventFile, 'utf8')).toBe(before)
    await store.migrateLegacyEvents({ backup: false })
  })

  it('fails explicitly and non-destructively for malformed records before the tail', async () => {
    await appendFile(store.eventFile, '{"event":\n', 'utf8')
    await appendFile(store.eventFile, `${JSON.stringify({ id: 'after-corruption', event: 'session.started', runtime: 'codex', timestamp: new Date().toISOString() })}\n`, 'utf8')
    const before = await readFile(store.eventFile, 'utf8')

    await expect(store.readEvents()).rejects.toThrow('malformed record')
    expect(await readFile(store.eventFile, 'utf8')).toBe(before)
    await store.migrateLegacyEvents({ backup: false })
  })

  it('keeps generated legacy event IDs stable across reads, rewrites, and migration', async () => {
    const skillId = `legacy-without-id-${Date.now()}`
    const malformedSkillId = `legacy-malformed-id-${Date.now()}`
    const duplicateSkillId = `legacy-duplicate-${Date.now()}`
    const duplicateLine = JSON.stringify({ event: 'skill.completed', skillId: duplicateSkillId, runtime: 'codex', timestamp: '2026-07-22T00:00:00.000Z', outcome: 'success' })
    await appendFile(store.eventFile, [
      '',
      JSON.stringify({ id: 'expired-before-legacy', event: 'session.started', runtime: 'codex', timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({
        event: 'skill.completed',
        skillId,
        runtime: 'codex',
        timestamp: '2026-07-22T00:00:00.000Z',
        outcome: 'success',
      }),
      JSON.stringify({ id: null, event: 'skill.completed', skillId: malformedSkillId, runtime: 'codex', outcome: 'success' }),
      duplicateLine,
      duplicateLine,
      '',
    ].join('\n'), 'utf8')

    const initialEvents = await store.readEvents()
    const first = initialEvents.find((event) => event.skillId === skillId)
    const malformedFirst = initialEvents.find((event) => event.skillId === malformedSkillId)
    const second = (await store.readEvents()).find((event) => event.skillId === skillId)
    const malformedSecond = (await store.readEvents()).find((event) => event.skillId === malformedSkillId)
    const duplicateIds = initialEvents.filter((event) => event.skillId === duplicateSkillId).map((event) => event.id)
    expect(first.id).toMatch(/^legacy-sha256:[a-f0-9]{64}$/)
    expect(second.id).toBe(first.id)
    expect(malformedFirst.id).toMatch(/^legacy-sha256:[a-f0-9]{64}$/)
    expect(malformedSecond.id).toBe(malformedFirst.id)
    expect(new Set(duplicateIds).size).toBe(2)

    const pruned = await store.pruneEventsBefore(new Date('2026-07-01T00:00:00.000Z'), { backup: false })
    expect(pruned.removed).toBeGreaterThan(0)
    const rewrittenEvents = await store.readEvents()
    expect(rewrittenEvents.find((event) => event.skillId === skillId).id).toBe(first.id)
    expect(rewrittenEvents.find((event) => event.skillId === malformedSkillId).id).toBe(malformedFirst.id)
    expect(rewrittenEvents.filter((event) => event.skillId === duplicateSkillId).map((event) => event.id)).toEqual(duplicateIds)

    await store.migrateLegacyEvents({ backup: false })
    const migratedEvents = await store.readEvents()
    expect(migratedEvents.find((event) => event.skillId === skillId).id).toBe(first.id)
    expect(migratedEvents.find((event) => event.skillId === malformedSkillId).id).toBe(malformedFirst.id)
    expect(migratedEvents.filter((event) => event.skillId === duplicateSkillId).map((event) => event.id)).toEqual(duplicateIds)
  })

  it('migrates valid legacy rows and drops malformed rows through an explicit recoverable command', async () => {
    const rawSessionId = 'account@example.com/session-123'
    await writeFile(store.eventFile, `${JSON.stringify({
      id: `legacy:${rawSessionId}:session.started`,
      event: 'session.started',
      runtime: 'codex',
      timestamp: '2026-07-22T00:00:00.000Z',
      sessionId: rawSessionId,
    })}\n{"event":"truncated","sessionId":"${rawSessionId}`, 'utf8')
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

  it('restores the live event file when the discovery index cannot commit', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'skillops-event-retention-'))
    const file = path.join(directory, 'events.jsonl')
    const before = [
      JSON.stringify({ id: 'old', event: 'session.started', runtime: 'codex', timestamp: '2026-07-20T00:00:00.000Z' }),
      JSON.stringify({ id: 'current', event: 'session.started', runtime: 'codex', timestamp: '2026-07-22T00:00:00.000Z' }),
      '',
    ].join('\n')
    await writeFile(file, before, 'utf8')
    await mkdir(path.join(directory, 'discovery-index.json'))

    await expect(store.pruneEventsBefore('2026-07-21T00:00:00.000Z', { directory })).rejects.toThrow()

    expect(await readFile(file, 'utf8')).toBe(before)
    expect((await readdir(directory)).filter((name) => name.startsWith('events.jsonl.backup-'))).toHaveLength(1)
    await rm(directory, { recursive: true, force: true })
  })

  it.each([
    ['partial', '{"event":'],
    ['complete corruption', '{"event":"session.started"\n'],
    ['schema-invalid', '{"foo":"bar","sentinel":"must-survive"}\n'],
  ])('rejects retention before live data or backup GC changes for %s input', async (_label, corruptTail) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'skillops-event-retention-corrupt-'))
    const file = path.join(directory, 'events.jsonl')
    const before = `${JSON.stringify({
      id: 'old',
      event: 'session.started',
      runtime: 'codex',
      timestamp: '2026-07-20T00:00:00.000Z',
    })}\n${corruptTail}`
    const expiredBackup = `${file}.backup-expired`
    await writeFile(file, before, 'utf8')
    await writeFile(expiredBackup, 'expired backup', 'utf8')
    await utimes(expiredBackup, new Date('2026-07-19T00:00:00.000Z'), new Date('2026-07-19T00:00:00.000Z'))

    await expect(store.pruneEventsBefore('2026-07-21T00:00:00.000Z', { directory })).rejects.toThrow()

    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await readFile(expiredBackup, 'utf8')).toBe('expired backup')
    expect((await readdir(directory)).filter((name) => name.startsWith('events.jsonl.backup-'))).toEqual(['events.jsonl.backup-expired'])
    await rm(directory, { recursive: true, force: true })
  })

  it('appends discovery events only once for the same installed definition', async () => {
    const skill = { skillId: 'deduplicated', skillVersion: '1.0.0', runtime: 'codex', sourcePath: '/skills/deduplicated/SKILL.md' }
    expect(await store.appendUniqueDiscoveries([skill])).toHaveLength(1)
    expect(await store.appendUniqueDiscoveries([skill])).toHaveLength(0)
  })

  it('serializes an index-rewriting clear behind an in-flight discovery transaction', async () => {
    const before = await readFile(store.eventFile, 'utf8')
    const lockFile = path.join(dataDirectory, 'discovery-index.lock')
    const lock = await open(lockFile, 'wx')
    let settled = false
    const clearing = store.clearEvents({ backup: false }).then((result) => {
      settled = true
      return result
    })

    try {
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(settled).toBe(false)
      expect(await readFile(store.eventFile, 'utf8')).toBe(before)
    } finally {
      await lock.close()
      await rm(lockFile, { force: true })
    }

    await clearing
    expect(await store.readEvents()).toEqual([])
    expect(JSON.parse(await readFile(path.join(dataDirectory, 'discovery-index.json'), 'utf8'))).toEqual([])
  })

  it('rebuilds a stale discovery index after its commit fails without duplicating appended events', async () => {
    const first = { skillId: 'first', skillVersion: '1.0.0', runtime: 'codex', sourcePath: '/skills/first/SKILL.md' }
    let sabotaged = false
    const second = {
      skillId: 'second',
      skillVersion: '1.0.0',
      sourcePath: '/skills/second/SKILL.md',
      get runtime() {
        if (!sabotaged) {
          sabotaged = true
          rmSync(path.join(dataDirectory, 'discovery-index.json'), { force: true })
          mkdirSync(path.join(dataDirectory, 'discovery-index.json'))
        }
        return 'codex'
      },
    }

    await expect(store.appendUniqueDiscoveries([first, second])).rejects.toThrow()
    expect(await store.appendUniqueDiscoveries([first, { ...second }])).toHaveLength(0)

    const discoveries = (await store.readEvents()).filter((event) => event.event === 'skill.discovered' && ['first', 'second'].includes(event.skillId))
    expect(discoveries.map((event) => event.skillId)).toEqual(['first', 'second'])
  })

  it('serializes event recovery with discovery appends and rebuilds the authoritative index', async () => {
    await store.clearEvents({ backup: false })
    const oldDiscovery = {
      id: 'recovery-old',
      event: 'skill.discovered',
      skillId: 'recovery-old',
      skillVersion: '1.0.0',
      runtime: 'codex',
      sourcePath: '/skills/recovery-old/SKILL.md',
      timestamp: '2026-07-22T00:00:00.000Z',
    }
    const current = {
      id: 'recovery-current',
      event: 'session.started',
      runtime: 'codex',
      timestamp: '2026-07-23T00:00:00.000Z',
    }
    const postimage = `${JSON.stringify(current)}\n`
    const backup = `${store.eventFile}.backup-concurrent-recovery`
    await writeFile(store.eventFile, postimage, 'utf8')
    await writeFile(path.join(dataDirectory, 'discovery-index.json'), '[]\n', 'utf8')
    await writeFile(backup, `${JSON.stringify(oldDiscovery)}\n${postimage}`, 'utf8')
    const newDiscovery = {
      skillId: 'recovery-new',
      skillVersion: '1.0.0',
      runtime: 'codex',
      sourcePath: '/skills/recovery-new/SKILL.md',
    }

    await Promise.all([
      store.restoreEventsFromBackup(backup, postimage),
      store.appendUniqueDiscoveries([newDiscovery]),
    ])

    const discoveries = (await store.readEvents()).filter((event) => event.event === 'skill.discovered')
    expect(discoveries.map((event) => event.skillId).sort()).toEqual(['recovery-new', 'recovery-old'])
    expect(new Set(JSON.parse(await readFile(path.join(dataDirectory, 'discovery-index.json'), 'utf8'))))
      .toEqual(new Set(discoveries.map(store.discoveryKey)))
  })

  it('rolls event recovery back and invalidates its index when index rebuild fails', async () => {
    await store.clearEvents({ backup: false })
    const current = `${JSON.stringify({
      id: 'recovery-current-after-failure',
      event: 'session.started',
      runtime: 'codex',
      timestamp: '2026-07-23T00:00:00.000Z',
    })}\n`
    const restoredDiscovery = {
      id: 'recovery-failed-discovery',
      event: 'skill.discovered',
      skillId: 'recovery-failed-discovery',
      runtime: 'codex',
      timestamp: '2026-07-22T00:00:00.000Z',
    }
    const backup = `${store.eventFile}.backup-failed-recovery`
    await writeFile(store.eventFile, current, 'utf8')
    await writeFile(backup, `${JSON.stringify(restoredDiscovery)}\n${current}`, 'utf8')
    await rm(path.join(dataDirectory, 'discovery-index.json'), { force: true })
    await mkdir(path.join(dataDirectory, 'discovery-index.json'))

    await expect(store.restoreEventsFromBackup(backup, current)).rejects.toThrow()

    expect(await readFile(store.eventFile, 'utf8')).toBe(current)
    await expect(readFile(path.join(dataDirectory, 'discovery-index.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await store.appendUniqueDiscoveries([{
      skillId: restoredDiscovery.skillId,
      runtime: restoredDiscovery.runtime,
    }])).toHaveLength(1)
  })

  it('does not compact duplicate discoveries across a partial trailing record', async () => {
    const discovery = JSON.stringify({
      id: 'discovery',
      event: 'skill.discovered',
      skillId: 'duplicate',
      runtime: 'codex',
      timestamp: '2026-07-22T00:00:00.000Z',
    })
    const before = `${discovery}\n${discovery}\n{"event":`
    await writeFile(store.eventFile, before, 'utf8')

    await expect(store.compactDiscoveryEvents()).rejects.toThrow('partial trailing record')

    expect(await readFile(store.eventFile, 'utf8')).toBe(before)
    await store.migrateLegacyEvents({ backup: false })
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

  it('does not selectively remove events across a partial trailing record', async () => {
    const before = `${JSON.stringify({
      id: 'codex-desktop:remove-me',
      event: 'session.started',
      runtime: 'codex',
      timestamp: '2026-07-22T00:00:00.000Z',
    })}\n{"event":`
    await writeFile(store.eventFile, before, 'utf8')

    await expect(store.removeEventsByIdPrefix('codex-desktop:')).rejects.toThrow('partial trailing record')

    expect(await readFile(store.eventFile, 'utf8')).toBe(before)
    await store.migrateLegacyEvents({ backup: false })
  })

  it('clears local events through a recoverable backup', async () => {
    await store.appendEvent({ event: 'session.started', runtime: 'claude-code', sessionId: 'before-clear' })
    const result = await store.clearEvents()
    expect(result.removed).toBeGreaterThan(0)
    expect(result.backupFile).toContain('.backup-')
    expect(await store.readEvents()).toEqual([])
    expect(await readFile(result.backupFile, 'utf8')).not.toContain('before-clear')
  })

  it('does not clear events across a partial trailing record', async () => {
    const before = `${JSON.stringify({
      id: 'keep-me',
      event: 'session.started',
      runtime: 'codex',
      timestamp: '2026-07-22T00:00:00.000Z',
    })}\n{"event":`
    const backupNames = () => readdir(dataDirectory).then((names) => names.filter((name) => name.startsWith('events.jsonl.backup-')).sort())
    const indexFile = path.join(dataDirectory, 'discovery-index.json')
    const readIndex = () => readFile(indexFile, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
    await writeFile(store.eventFile, before, 'utf8')
    const backupsBefore = await backupNames()
    const indexBefore = await readIndex()

    await expect(store.clearEvents()).rejects.toThrow('partial trailing record')

    expect(await readFile(store.eventFile, 'utf8')).toBe(before)
    expect(await backupNames()).toEqual(backupsBefore)
    expect(await readIndex()).toBe(indexBefore)
    await store.migrateLegacyEvents({ backup: false })
  })

  it.each([
    ['clear', [
      JSON.stringify({ id: 'clear-me', event: 'session.started', runtime: 'codex', timestamp: '2026-07-22T00:00:00.000Z' }),
      '',
    ].join('\n')],
    ['remove', [
      JSON.stringify({ id: 'codex-desktop:remove-me', event: 'session.started', runtime: 'codex', timestamp: '2026-07-22T00:00:00.000Z' }),
      JSON.stringify({ id: 'keep-me', event: 'session.started', runtime: 'claude-code', timestamp: '2026-07-22T00:00:00.000Z' }),
      '',
    ].join('\n')],
    ['compact', [
      JSON.stringify({ id: 'discovery-a', event: 'skill.discovered', skillId: 'duplicate', runtime: 'codex', timestamp: '2026-07-22T00:00:00.000Z' }),
      JSON.stringify({ id: 'discovery-b', event: 'skill.discovered', skillId: 'duplicate', runtime: 'codex', timestamp: '2026-07-22T00:00:00.000Z' }),
      '',
    ].join('\n')],
    ['migrate', `${JSON.stringify({ event: 'session.started', runtime: 'codex', timestamp: '2026-07-22T00:00:00.000Z' })}\n`],
  ])('restores exact event bytes when %s cannot commit its discovery index', async (operation, before) => {
    const directory = await mkdtemp(path.join(tmpdir(), `skillops-event-${operation}-index-`))
    const previousDataDir = process.env.SKILLOPS_DATA_DIR
    process.env.SKILLOPS_DATA_DIR = directory
    const isolated = await import(/* @vite-ignore */ `${pathToFileURL(path.resolve('app/backend/event-store.mjs')).href}?${operation}=${Date.now()}`)
    if (previousDataDir === undefined) delete process.env.SKILLOPS_DATA_DIR
    else process.env.SKILLOPS_DATA_DIR = previousDataDir
    await writeFile(isolated.eventFile, before, 'utf8')
    await mkdir(path.join(directory, 'discovery-index.json'))

    const mutation = operation === 'clear'
      ? isolated.clearEvents()
      : operation === 'remove'
        ? isolated.removeEventsByIdPrefix('codex-desktop:')
        : operation === 'compact'
          ? isolated.compactDiscoveryEvents()
          : isolated.migrateLegacyEvents()
    await expect(mutation).rejects.toThrow()

    expect(await readFile(isolated.eventFile, 'utf8')).toBe(before)
    const backups = (await readdir(directory)).filter((name) => name.startsWith('events.jsonl.backup-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(path.join(directory, backups[0]), 'utf8')).toBe(before)
    await rm(directory, { recursive: true, force: true })
  })
})
