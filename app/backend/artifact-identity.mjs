import path from 'node:path'

export function artifactIdFromPath(sourcePath, kind) {
  const normalized = sourcePath.replaceAll('\\', '/')
  return kind === 'skill'
    ? path.posix.basename(path.posix.dirname(normalized))
    : path.posix.basename(normalized).replace(/(?:\.prompt)?\.(?:md|json|toml)$/i, '')
}
