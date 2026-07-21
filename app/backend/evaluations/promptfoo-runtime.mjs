import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { EvaluationError } from './errors.mjs'

const defaultRuntimeRoot = fileURLToPath(new URL('../../../data/promptfoo-runtime/', import.meta.url))
const workerUrl = new URL('./promptfoo-worker.mjs', import.meta.url)

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
  let worker
  try {
    const result = await new Promise((resolve, reject) => {
      worker = new Worker(workerUrl, {
        workerData: payload,
        env: { ...process.env, ...PROMPTFOO_PRIVACY_ENV, PROMPTFOO_CONFIG_DIR: runDirectory },
        stdout: true,
        stderr: true,
      })
      const abort = () => {
        worker.terminate().catch(() => {})
        reject(new EvaluationError('The Promptfoo run was cancelled.', 409))
      }
      if (signal?.aborted) return abort()
      signal?.addEventListener('abort', abort, { once: true })
      worker.once('message', (message) => {
        signal?.removeEventListener('abort', abort)
        if (message?.ok) resolve(message.result)
        else reject(new EvaluationError(message?.error?.message || 'The isolated Promptfoo run failed.', 502))
      })
      worker.once('error', () => {
        signal?.removeEventListener('abort', abort)
        reject(new EvaluationError('The isolated Promptfoo worker failed.', 502))
      })
      worker.once('exit', (code) => {
        if (code !== 0 && !signal?.aborted) reject(new EvaluationError('The isolated Promptfoo worker exited unexpectedly.', 502))
      })
    })
    const forbiddenValues = {
      ...(options.forbiddenValues || {}),
      ...(options.auditResultStrings ? collectResultStrings(result) : {}),
    }
    const runtimeAudit = await inspectRuntimeDirectory(runDirectory, forbiddenValues)
    return { result, runtimeAudit }
  } finally {
    if (worker) await worker.terminate().catch(() => {})
    const resolvedRunDirectory = path.resolve(runDirectory)
    if (resolvedRunDirectory.startsWith(`${runtimeRoot}${path.sep}`)) await rm(resolvedRunDirectory, { recursive: true, force: true })
  }
}
