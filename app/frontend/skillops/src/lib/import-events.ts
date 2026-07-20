import type { SkillEvent } from '../types'
// @ts-expect-error This plain JavaScript schema is shared with the Node event store.
import { normalizeEvents } from '../../../../shared/event-schema.mjs'

export type EventFileErrorCode = 'empty-file' | 'invalid-json' | 'invalid-jsonl' | 'invalid-events'

export class EventFileError extends Error {
  readonly code: EventFileErrorCode
  readonly line?: number

  constructor(code: EventFileErrorCode, message: string, line?: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EventFileError'
    this.code = code
    this.line = line
  }
}

function normalizeImportedEvents(events: unknown) {
  try {
    return normalizeEvents(events) as SkillEvent[]
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The event data failed validation.'
    throw new EventFileError('invalid-events', message, undefined, { cause: error })
  }
}

export function parseEventFile(contents: string): SkillEvent[] {
  const trimmed = contents.trim()
  if (!trimmed) throw new EventFileError('empty-file', 'The selected event file is empty.')
  if (trimmed.startsWith('[')) {
    try {
      return normalizeImportedEvents(JSON.parse(trimmed))
    } catch (error) {
      if (error instanceof EventFileError) throw error
      throw new EventFileError('invalid-json', 'The selected file is not valid JSON.', undefined, { cause: error })
    }
  }

  const events = []
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch (error) {
      throw new EventFileError('invalid-jsonl', `Invalid JSONL record on line ${index + 1}.`, index + 1, { cause: error })
    }
  }
  return normalizeImportedEvents(events)
}
