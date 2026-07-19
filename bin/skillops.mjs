#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendEvent, appendUniqueDiscoveries } from '../app/backend/event-store.mjs'
import { scanInstalledSkills } from '../app/backend/skill-scanner.mjs'

const eventNames = new Set(['skill.discovered', 'skill.matched', 'skill.started', 'skill.completed', 'skill.failed', 'skill.skipped'])
const runtimes = new Set(['codex', 'claude-code', 'cursor'])

const cliPath = fileURLToPath(import.meta.url)

export function flags(values) {
  const result = {}
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith('--')) continue
    const next = values[index + 1]
    result[values[index].slice(2)] = next === undefined || next.startsWith('--') ? true : values[++index]
  }
  return result
}

async function scan() {
  const installed = await scanInstalledSkills()
  const discovered = await appendUniqueDiscoveries(installed)
  console.log(`Scanned ${installed.length} installed definitions. Recorded ${discovered.length} new discoveries.`)
}

async function emit(args) {
  const event = args[0]
  const options = flags(args.slice(1))
  if (!eventNames.has(event)) throw new Error(`Unknown event “${event}”.`)
  if (!options.skill) throw new Error('Missing required --skill.')
  const runtime = options.runtime || 'codex'
  if (!runtimes.has(runtime)) throw new Error('Runtime must be codex, claude-code, or cursor.')
  const created = await appendEvent({
    event,
    skillId: options.skill,
    skillVersion: options.version || 'unversioned',
    runtime,
    sessionId: options.session,
    project: options.project || path.basename(process.cwd()),
    durationMs: options.duration ? Number(options.duration) : undefined,
    costUsd: options.cost ? Number(options.cost) : undefined,
    error: options.error,
    outcome: options.outcome,
  })
  console.log(JSON.stringify(created, null, 2))
}

export async function main(values = process.argv.slice(2)) {
  const [command, ...args] = values
  try {
    if (command === 'scan') await scan()
    else if (command === 'emit') await emit(args)
    else {
      console.log(`SkillOps local event bridge

Usage:
  npm run scan
  npm run emit -- skill.started --skill frontend-builder --runtime codex --version 2.1.0
  npm run emit -- skill.completed --skill frontend-builder --runtime codex --version 2.1.0 --duration 82000 --cost 0.12 --outcome success`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === cliPath) {
  await main()
}
