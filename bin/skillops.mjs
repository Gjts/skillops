#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendEvent, appendUniqueDiscoveries, migrateLegacyEvents } from '../app/backend/event-store.mjs'
import { scanInstalledSkills } from '../app/backend/skill-scanner.mjs'
import { flags } from './cli-flags.mjs'

export { flags } from './cli-flags.mjs'

const eventNames = new Set(['skill.discovered', 'skill.matched', 'skill.started', 'skill.completed', 'skill.failed', 'skill.skipped'])
const runtimes = new Set(['codex', 'claude-code', 'cursor'])

const cliPath = fileURLToPath(import.meta.url)

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
    else if (command === 'events:migrate') console.log(JSON.stringify(await migrateLegacyEvents(), null, 2))
    else if (command === 'init') {
      const { projectTemplateInit } = await import('./project-template-cli.mjs')
      console.log(JSON.stringify(await projectTemplateInit(args), null, 2))
    }
    else if (command === 'eval:list') {
      const { evaluationList } = await import('./evaluation-cli.mjs')
      console.log(JSON.stringify(await evaluationList(), null, 2))
    } else if (command === 'eval:run') {
      const { evaluationRun } = await import('./evaluation-cli.mjs')
      console.log(JSON.stringify(await evaluationRun(args), null, 2))
    } else if (command === 'eval:changed') {
      const { evaluationChanged } = await import('./evaluation-changed-cli.mjs')
      console.log(JSON.stringify(await evaluationChanged(args), null, 2))
    } else if (command === 'eval:verify') {
      const { evaluationVerify } = await import('./evaluation-cli.mjs')
      const result = await evaluationVerify(args)
      console.log(JSON.stringify(result, null, 2))
      if (!result.ok) process.exitCode = 1
    }
    else {
      console.log(`SkillOps local event bridge

Usage:
  npm run scan
  npm run events:migrate
  npm run template:init -- --manifest <draft.json> --hash
  npm run template:init -- --manifest <stable-candidate.json> --nominate
  npm run template:init -- --approve --approval <approval-id>
  npm run template:init -- --manifest <team-template.json> --mode greenfield
  npm run template:init -- --manifest <team-template.json> --mode migration --apply
  npm run eval:list
  npm run eval:run -- --suite deterministic-smoke --baseline baseline --candidate candidate --deterministic
  npm run eval:changed -- --base <base-commit> --head <head-commit>
  npm run eval:verify -- --run <run-id>
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
