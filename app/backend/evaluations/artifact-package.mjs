import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { EvaluationError } from './errors.mjs'

export const MAX_ARTIFACT_PACKAGE_BYTES = 10 * 1024 * 1024
export const MAX_ARTIFACT_PACKAGE_FILES = 500

function packagePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1_000
    || value.includes('\\') || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || value.split('/').some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f<>:"|?*]/.test(part) || /[. ]$/.test(part))) {
    throw new EvaluationError('Artifact package path is invalid.', 422)
  }
  return value
}

function packageMode(value) {
  if (!Number.isInteger(value) || value < 0) throw new EvaluationError('Artifact package mode is invalid.', 422)
  return value & 0o111 ? 0o755 : 0o644
}

function packageBytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  throw new EvaluationError('Artifact package contents are invalid.', 422)
}

export function normalizeArtifactPackage(files) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_ARTIFACT_PACKAGE_FILES) {
    throw new EvaluationError(`Artifact packages require 1-${MAX_ARTIFACT_PACKAGE_FILES} files.`, 422)
  }
  let totalBytes = 0
  const seen = new Set()
  const normalized = files.map((file) => {
    const relativePath = packagePath(file?.relativePath)
    const collisionKey = relativePath.toLowerCase()
    if (seen.has(collisionKey)) throw new EvaluationError('Artifact package paths must be unique across supported filesystems.', 422)
    seen.add(collisionKey)
    const contents = packageBytes(file?.contents)
    totalBytes += contents.byteLength
    if (totalBytes > MAX_ARTIFACT_PACKAGE_BYTES) throw new EvaluationError('Artifact package exceeds the 10 MB limit.', 413)
    return { relativePath, mode: packageMode(file?.mode ?? 0o644), contents }
  })
  return normalized.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)
}

export function artifactPackageHash(files) {
  const normalized = normalizeArtifactPackage(files)
  const manifest = normalized.map(({ relativePath, contents }) => ({
    relativePath,
    contentHash: createHash('sha256').update(contents).digest('hex'),
  }))
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
}

export async function readArtifactPackage(directory, options = {}) {
  const inspect = options.lstat || lstat
  const list = options.readdir || readdir
  const read = options.readFile || readFile
  const canonical = options.realpath || realpath
  const root = await canonical(path.resolve(directory))
  const rootInfo = await inspect(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new EvaluationError('Artifact package root must be a real directory.', 422)
  const files = []
  let totalBytes = 0

  async function visit(current, relative = '') {
    const entries = await list(current, { withFileTypes: true })
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name
      const absolutePath = path.join(current, entry.name)
      const info = await inspect(absolutePath)
      if (info.isSymbolicLink()) throw new EvaluationError('Artifact packages cannot contain symbolic links.', 422)
      if (info.isDirectory()) {
        await visit(absolutePath, relativePath)
        continue
      }
      if (!info.isFile()) throw new EvaluationError('Artifact packages may contain only regular files.', 422)
      if (files.length >= MAX_ARTIFACT_PACKAGE_FILES) throw new EvaluationError(`Artifact packages may contain at most ${MAX_ARTIFACT_PACKAGE_FILES} files.`, 413)
      totalBytes += info.size
      if (totalBytes > MAX_ARTIFACT_PACKAGE_BYTES) throw new EvaluationError('Artifact package exceeds the 10 MB limit.', 413)
      files.push({ relativePath, mode: info.mode, contents: await read(absolutePath) })
    }
  }

  await visit(root)
  const packageFiles = normalizeArtifactPackage(files)
  return { packageFiles, contentHash: artifactPackageHash(packageFiles) }
}
