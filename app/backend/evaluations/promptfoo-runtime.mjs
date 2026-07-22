import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EvaluationError } from './errors.mjs'

const defaultRuntimeRoot = fileURLToPath(new URL('../../../data/promptfoo-runtime/', import.meta.url))
const workerPath = fileURLToPath(new URL('./promptfoo-child.mjs', import.meta.url))
const testNoEgressUrl = new URL('../../../scripts/test-no-egress.mjs', import.meta.url).href

export const PROMPTFOO_VERSION = '0.121.19'

export const PROMPTFOO_PRIVACY_ENV = Object.freeze({
  PROMPTFOO_DISABLE_TELEMETRY: '1',
  PROMPTFOO_DISABLE_UPDATE: '1',
  PROMPTFOO_DISABLE_SHARING: '1',
  PROMPTFOO_DISABLE_REMOTE_GENERATION: 'true',
  PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION: 'true',
  PROMPTFOO_CACHE_ENABLED: 'false',
  PROMPTFOO_LOG_LEVEL: 'error',
})

const RUNTIME_ENV_NAMES = new Set([
  'COMSPEC', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'PATH', 'PATHEXT',
  'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'TZ', 'WINDIR',
])

function isolatedEnvironment(runDirectory) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => RUNTIME_ENV_NAMES.has(name.toUpperCase()))),
    ...PROMPTFOO_PRIVACY_ENV,
    PROMPTFOO_CONFIG_DIR: runDirectory,
  }
}

async function inspectRuntimeDirectory(directory, forbiddenValues) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile()).map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name))).sort()
  const matches = []
  for (const file of files) {
    const contents = await readFile(path.join(directory, file), 'utf8').catch(() => '')
    for (const [label, value] of Object.entries(forbiddenValues)) {
      if (typeof value === 'string' && value && contents.includes(value)) matches.push({ file, label })
    }
  }
  return { files, forbiddenMatches: matches }
}

function collectResultStrings(value, output = {}, state = { count: 0 }, pathLabel = 'result') {
  if (state.count >= 200) return output
  if (typeof value === 'string' && value.length >= 8) {
    output[`${pathLabel}-${state.count}`] = value
    state.count += 1
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectResultStrings(item, output, state, `${pathLabel}-${index}`))
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => collectResultStrings(item, output, state, `${pathLabel}-${key}`))
  }
  return output
}

export async function runPromptfooIsolated(payload, options = {}) {
  const runtimeRoot = path.resolve(options.runtimeRoot || defaultRuntimeRoot)
  await mkdir(runtimeRoot, { recursive: true })
  const runDirectory = await mkdtemp(path.join(runtimeRoot, 'run-'))
  const signal = options.signal
  try {
    const result = await new Promise((resolve, reject) => {
      const child = fork(workerPath, [], {
        execArgv: process.env.NODE_ENV === 'test' ? ['--import', testNoEgressUrl] : [],
        env: isolatedEnvironment(runDirectory),
        cwd: runDirectory,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
      })
      let message
      let failure
      let stopTimer

      const stop = (error) => {
        failure ||= error
        if (child.exitCode === null && child.signalCode === null) child.kill()
      }
      const cleanup = () => {
        clearTimeout(stopTimer)
        signal?.removeEventListener('abort', abort)
      }
      const abort = () => stop(new EvaluationError('The Promptfoo run was cancelled.', 409))

      child.once('message', (value) => {
        message = value
        if (child.connected) child.disconnect()
        stopTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill()
        }, 1_000)
        stopTimer.unref()
      })
      child.once('error', () => {
        failure ||= new EvaluationError('The isolated Promptfoo process failed.', 500)
        cleanup()
        reject(failure)
      })
      child.once('exit', (code, exitSignal) => {
        cleanup()
        if (failure) return reject(failure)
        if (!message) return reject(new EvaluationError(`The isolated Promptfoo process exited unexpectedly (${exitSignal || code}).`, 500))
        if (message.ok) return resolve(message.result)
        reject(new EvaluationError(message.error?.message || 'The isolated Promptfoo run failed.', 500))
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      else child.send(payload, (error) => {
        if (error) stop(new EvaluationError('The isolated Promptfoo process could not start.', 500))
      })
    })
    const forbiddenValues = { ...(options.forbiddenValues || {}), ...collectResultStrings(result) }
    const runtimeAudit = await inspectRuntimeDirectory(runDirectory, forbiddenValues)
    return { result, runtimeAudit }
  } finally {
    await rm(runDirectory, { recursive: true, force: true })
  }
}
