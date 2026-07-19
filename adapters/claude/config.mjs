import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

function expandCcSwitchPath(value, home) {
  const trimmed = value.trim()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(home, trimmed.slice(2))
  }
  return path.resolve(trimmed)
}

async function ccSwitchClaudeHome(settingsFile, home) {
  try {
    const raw = (await readFile(settingsFile, 'utf8')).replace(/^\uFEFF/, '')
    const configured = JSON.parse(raw)?.claude_config_dir
    return typeof configured === 'string' && configured.trim()
      ? expandCcSwitchPath(configured, home)
      : undefined
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error instanceof SyntaxError) return undefined
    throw error
  }
}

export async function resolveClaudeHome({
  claudeHome,
  home = homedir(),
  ccSwitchHome = path.join(home, '.cc-switch'),
  environment = process.env,
} = {}) {
  if (claudeHome) return path.resolve(claudeHome)
  if (environment.CLAUDE_CONFIG_DIR) return path.resolve(environment.CLAUDE_CONFIG_DIR)

  const switchedHome = await ccSwitchClaudeHome(path.join(ccSwitchHome, 'settings.json'), home)
  return switchedHome || path.join(home, '.claude')
}

export async function resolveEffectiveSettingsFile(options = {}) {
  if (options.scope === 'project') return path.join(path.resolve(options.target || process.cwd()), '.claude', 'settings.json')
  if (options.scope === 'local') return path.join(path.resolve(options.target || process.cwd()), '.claude', 'settings.local.json')
  return path.join(await resolveClaudeHome(options), 'settings.json')
}
