#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveEffectiveSettingsFile } from './config.mjs'

const installerPath = fileURLToPath(import.meta.url)
const adapterDir = path.dirname(installerPath)
const hookPath = path.join(adapterDir, 'hook.mjs')
const marker = 'skillops-claude-hook'
const sensitiveSetting = /(token|secret|password|authorization|api[-_]?key|credential)/i

const eventDefinitions = [
  { name: 'SessionStart', matcher: 'startup|resume|clear|compact' },
  { name: 'UserPromptSubmit', async: true },
  { name: 'UserPromptExpansion', mode: 'exact' },
  { name: 'PreToolUse', matcher: '^Skill$', mode: 'exact' },
  { name: 'PreToolUse', matcher: '*', mode: 'generic', async: true },
  { name: 'PostToolUse', matcher: '*', async: true },
  { name: 'PostToolUseFailure', matcher: '*', async: true },
  { name: 'SubagentStart', matcher: '*', async: true },
  { name: 'SubagentStop', matcher: '*', async: true },
  { name: 'Stop' },
  { name: 'StopFailure' },
  { name: 'SessionEnd' },
]

function quotePosix(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function quoteWindows(value) {
  return `"${value.replaceAll('"', '""')}"`
}

function skillOpsHandler(definition) {
  const mode = definition.mode || 'default'
  const quote = process.platform === 'win32' ? quoteWindows : quotePosix
  const command = `${quote(process.execPath)} ${quote(hookPath)} --adapter=${marker} --hook-mode=${mode}`
  return {
    type: 'command',
    command,
    timeout: 10,
    ...(definition.async ? { async: true } : {}),
  }
}

function isSkillOpsHandler(handler) {
  return typeof handler?.command === 'string' && handler.command.includes(marker)
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
      .map((group) => ({
        ...group,
        hooks: Array.isArray(group.hooks) ? group.hooks.filter((hook) => !isSkillOpsHandler(hook)) : [],
      }))
      .filter((group) => group.hooks.length)
    if (!output.hooks[eventName].length) delete output.hooks[eventName]
  }
  if (!Object.keys(output.hooks).length) delete output.hooks
  return output
}

export function mergeSkillOpsHooks(config) {
  const output = removeSkillOpsHooks(config)
  output.hooks ||= {}
  for (const definition of eventDefinitions) {
    output.hooks[definition.name] ||= []
    output.hooks[definition.name].push({
      ...(definition.matcher ? { matcher: definition.matcher } : {}),
      hooks: [skillOpsHandler(definition)],
    })
  }
  return output
}

export function redactConfigForDisplay(value, parentKey = '') {
  if (Array.isArray(value)) return value.map((item) => redactConfigForDisplay(item, parentKey))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    parentKey === 'env' || sensitiveSetting.test(key)
      ? '[REDACTED]'
      : redactConfigForDisplay(nested, key),
  ]))
}

async function readConfig(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`Cannot read ${file}: ${error.message}`)
  }
}

export function resolveSettingsFile({ scope = 'user', target = process.cwd(), claudeHome } = {}) {
  if (scope === 'project') return path.join(path.resolve(target), '.claude', 'settings.json')
  if (scope === 'local') return path.join(path.resolve(target), '.claude', 'settings.local.json')
  const home = claudeHome || process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
  return path.join(path.resolve(home), 'settings.json')
}

export async function updateInstallation({ scope = 'user', target, claudeHome, home, ccSwitchHome, environment, dryRun = false, uninstall = false } = {}) {
  const file = await resolveEffectiveSettingsFile({ scope, target, claudeHome, home, ccSwitchHome, environment })
  const current = await readConfig(file)
  const next = uninstall ? removeSkillOpsHooks(current) : mergeSkillOpsHooks(current)
  const changed = JSON.stringify(current) !== JSON.stringify(next)
  if (dryRun) return { file, changed, config: next }
  if (!changed) return { file, changed, config: next }

  await mkdir(path.dirname(file), { recursive: true })
  let backup
  if (Object.keys(current).length) {
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    backup = `${file}.skillops-backup-${stamp}`
    await copyFile(file, backup)
  }
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return { file, backup, changed, config: next }
}

function parseArguments(args) {
  const options = { scope: 'user', dryRun: false, uninstall: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--scope') options.scope = args[++index]
    else if (argument === '--target') options.target = args[++index]
    else if (argument === '--claude-home') options.claudeHome = args[++index]
    else if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--uninstall') options.uninstall = true
    else throw new Error(`Unknown option: ${argument}`)
  }
  if (!['user', 'project', 'local'].includes(options.scope)) {
    throw new Error('--scope must be user, project, or local.')
  }
  return options
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const result = await updateInstallation(options)
  if (options.dryRun) {
    console.log(JSON.stringify(redactConfigForDisplay(result.config), null, 2))
    console.log(`\nDry run only. Target: ${result.file}`)
    return
  }
  console.log(options.uninstall ? 'SkillOps Claude Code hooks removed.' : 'SkillOps Claude Code hooks installed.')
  console.log(`Settings file: ${result.file}`)
  if (!result.changed) console.log('No changes were needed.')
  if (result.backup) console.log(`Backup: ${result.backup}`)
  if (!options.uninstall) console.log('Next: restart Claude Code and run /hooks to verify the SkillOps definitions.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === installerPath) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
