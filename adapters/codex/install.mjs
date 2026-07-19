#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const installerPath = fileURLToPath(import.meta.url)
const adapterDir = path.dirname(installerPath)
const hookPath = path.join(adapterDir, 'hook.mjs')
const marker = 'skillops-codex-hook'

const eventDefinitions = [
  { name: 'SessionStart', matcher: 'startup|resume|clear|compact' },
  { name: 'UserPromptSubmit' },
  { name: 'PreToolUse', matcher: '*' },
  { name: 'PostToolUse', matcher: '*' },
  { name: 'SubagentStart', matcher: '*' },
  { name: 'SubagentStop', matcher: '*' },
  { name: 'Stop' },
]

function quotePosix(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function quoteWindows(value) {
  return `"${value.replaceAll('"', '""')}"`
}

function skillOpsHandler() {
  return {
    type: 'command',
    command: `SKILLOPS_ADAPTER=${marker} ${quotePosix(process.execPath)} ${quotePosix(hookPath)}`,
    commandWindows: `node ${quoteWindows(hookPath)}`,
    timeout: 10,
  }
}

function isSkillOpsHandler(handler) {
  return typeof handler?.command === 'string' && handler.command.includes(marker) ||
    typeof handler?.commandWindows === 'string' && handler.commandWindows.includes(marker)
}

export function hasSkillOpsHooks(config) {
  return Object.values(config?.hooks || {}).some((groups) => Array.isArray(groups) && groups.some((group) =>
    Array.isArray(group?.hooks) && group.hooks.some(isSkillOpsHandler)))
}

export function removeSkillOpsHooks(config) {
  const output = structuredClone(config || {})
  output.hooks ||= {}
  for (const [eventName, groups] of Object.entries(output.hooks)) {
    if (!Array.isArray(groups)) continue
    output.hooks[eventName] = groups
      .map((group) => ({ ...group, hooks: Array.isArray(group.hooks) ? group.hooks.filter((hook) => !isSkillOpsHandler(hook)) : [] }))
      .filter((group) => group.hooks.length)
    if (!output.hooks[eventName].length) delete output.hooks[eventName]
  }
  return output
}

export function mergeSkillOpsHooks(config) {
  const output = removeSkillOpsHooks(config)
  output.description ||= 'Codex lifecycle hooks.'
  output.hooks ||= {}
  for (const definition of eventDefinitions) {
    output.hooks[definition.name] ||= []
    output.hooks[definition.name].push({
      ...(definition.matcher ? { matcher: definition.matcher } : {}),
      hooks: [skillOpsHandler()],
    })
  }
  return output
}

async function readConfig(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`Cannot read ${file}: ${error.message}`)
  }
}

export function resolveHooksFile({ scope = 'user', target = process.cwd(), codexHome } = {}) {
  if (scope === 'project') return path.join(path.resolve(target), '.codex', 'hooks.json')
  const home = codexHome || process.env.CODEX_HOME || path.join(homedir(), '.codex')
  return path.join(path.resolve(home), 'hooks.json')
}

export async function updateInstallation({ scope = 'user', target, codexHome, dryRun = false, uninstall = false } = {}) {
  const file = resolveHooksFile({ scope, target, codexHome })
  const current = await readConfig(file)
  const next = uninstall ? removeSkillOpsHooks(current) : mergeSkillOpsHooks(current)
  if (dryRun) return { file, changed: JSON.stringify(current) !== JSON.stringify(next), config: next }

  await mkdir(path.dirname(file), { recursive: true })
  let backup
  if (Object.keys(current).length) {
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    backup = `${file}.skillops-backup-${stamp}`
    await copyFile(file, backup)
  }
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return { file, backup, changed: JSON.stringify(current) !== JSON.stringify(next), config: next }
}

function parseArguments(args) {
  const options = { scope: 'user', dryRun: false, uninstall: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--scope') options.scope = args[++index]
    else if (argument === '--target') options.target = args[++index]
    else if (argument === '--codex-home') options.codexHome = args[++index]
    else if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--uninstall') options.uninstall = true
    else throw new Error(`Unknown option: ${argument}`)
  }
  if (!['user', 'project'].includes(options.scope)) throw new Error('--scope must be user or project.')
  return options
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const result = await updateInstallation(options)
  if (options.dryRun) {
    console.log(JSON.stringify(result.config, null, 2))
    console.log(`\nDry run only. Target: ${result.file}`)
    return
  }
  console.log(options.uninstall ? 'SkillOps Codex hooks removed.' : 'SkillOps Codex hooks installed.')
  console.log(`Hooks file: ${result.file}`)
  if (result.backup) console.log(`Backup: ${result.backup}`)
  if (!options.uninstall) {
    console.log('Next: restart Codex, run /hooks, and trust the new SkillOps hook definitions.')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === installerPath) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
