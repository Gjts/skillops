import type { SkillEvent } from '../types'
// @ts-expect-error This plain JavaScript schema is shared with the Node event store.
import { normalizeEvents } from '../../../../shared/event-schema.mjs'

export function parseEventFile(contents: string): SkillEvent[] {
  const trimmed = contents.trim()
  if (!trimmed) throw new Error('The selected event file is empty.')
  if (trimmed.startsWith('[')) return normalizeEvents(JSON.parse(trimmed)) as SkillEvent[]

  const events = []
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      throw new Error(`Invalid JSONL record on line ${index + 1}.`)
    }
  }
  return normalizeEvents(events) as SkillEvent[]
}
