import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EvaluationError } from './errors.mjs'
import { assertEvaluationMatrixSize, normalizeEvaluationSuite, normalizeSuiteDataset } from './suite-schema.mjs'

const defaultEvalsRoot = fileURLToPath(new URL('../../../evals/', import.meta.url))
const MAX_SUITE_FILE_BYTES = 1_000_000

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function sha256Json(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

async function readJsonFile(file, allowedRoot, label) {
  const root = await realpath(allowedRoot).catch(() => path.resolve(allowedRoot))
  const info = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') throw new EvaluationError(`${label} was not found.`, 404)
    throw error
  })
  if (info.isSymbolicLink() || !info.isFile()) throw new EvaluationError(`${label} must be a regular non-symlink file.`, 422)
  if (info.size > MAX_SUITE_FILE_BYTES) throw new EvaluationError(`${label} exceeds the 1 MB limit.`, 413)
  const canonical = await realpath(file)
  if (canonical !== root && !canonical.startsWith(`${root}${path.sep}`)) throw new EvaluationError(`${label} escapes its allowed directory.`, 422)
  const text = await readFile(canonical, 'utf8')
  try { return JSON.parse(text) } catch { throw new EvaluationError(`${label} contains invalid JSON.`, 422) }
}

async function resolveDataset(suite, evalsRoot) {
  if (!suite.dataset) return { cases: suite.cases, datasetHash: null, datasetId: null }
  const datasetRoot = path.join(evalsRoot, 'datasets')
  const candidate = path.resolve(datasetRoot, suite.dataset)
  if (candidate !== datasetRoot && !candidate.startsWith(`${datasetRoot}${path.sep}`)) throw new EvaluationError('Suite dataset path escapes evals/datasets.', 422)
  const dataset = normalizeSuiteDataset(await readJsonFile(candidate, datasetRoot, 'Suite dataset'))
  if (dataset.cases.length > 200) throw new EvaluationError('Suite dataset exceeds the 200-case limit.', 413)
  return { cases: dataset.cases, datasetHash: sha256Json(dataset), datasetId: dataset.id }
}

function metadata(entry) {
  return {
    id: entry.suite.id,
    name: entry.suite.name,
    version: entry.suite.version,
    owner: entry.suite.owner,
    sensitivity: entry.suite.sensitivity,
    artifactKind: entry.suite.artifactKind,
    repeats: entry.suite.repeats,
    ...(entry.suite.matrix ? { matrix: entry.suite.matrix } : {}),
    caseCount: entry.cases.length,
    suiteHash: entry.suiteHash,
    datasetHash: entry.datasetHash,
    datasetId: entry.datasetId,
  }
}

export function createSuiteRegistry(options = {}) {
  const evalsRoot = path.resolve(options.evalsRoot || defaultEvalsRoot)
  const suitesRoot = path.join(evalsRoot, 'suites')

  async function loadEntries() {
    const suitesInfo = await lstat(suitesRoot).catch((error) => {
      if (error?.code === 'ENOENT') return null
      throw error
    })
    if (!suitesInfo) return []
    if (suitesInfo.isSymbolicLink() || !suitesInfo.isDirectory()) throw new EvaluationError('Evaluation suites directory must be a regular non-symlink directory.', 422)
    const entries = await readdir(suitesRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return []
      throw error
    })
    const loaded = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) throw new EvaluationError(`Evaluation suite ${entry.name} must not be a symlink.`, 422)
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
      const raw = await readJsonFile(path.join(suitesRoot, entry.name), suitesRoot, `Evaluation suite ${entry.name}`)
      const suite = normalizeEvaluationSuite(raw)
      const resolved = await resolveDataset(suite, evalsRoot)
      assertEvaluationMatrixSize(suite, resolved.cases)
      loaded.push({ suite, cases: resolved.cases, datasetHash: resolved.datasetHash, datasetId: resolved.datasetId, suiteHash: sha256Json(suite) })
    }
    const seen = new Set()
    for (const entry of loaded) {
      if (seen.has(entry.suite.id)) throw new EvaluationError(`Duplicate evaluation suite ID: ${entry.suite.id}.`, 422)
      seen.add(entry.suite.id)
    }
    return loaded
  }

  return {
    async list() {
      return (await loadEntries()).map(metadata)
    },
    async get(suiteId) {
      if (typeof suiteId !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(suiteId)) throw new EvaluationError('Suite ID is invalid.', 422)
      const entry = (await loadEntries()).find((item) => item.suite.id === suiteId)
      if (!entry) throw new EvaluationError('Evaluation suite was not found.', 404)
      return { ...entry.suite, cases: entry.cases, suiteHash: entry.suiteHash, datasetHash: entry.datasetHash, datasetId: entry.datasetId }
    },
  }
}
