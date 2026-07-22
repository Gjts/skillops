import { stat } from 'node:fs/promises'
import path from 'node:path'

const PROJECT_MARKERS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']

async function exists(location) {
  try {
    await stat(location)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EACCES' || error?.code === 'EPERM') return false
    throw error
  }
}

export async function resolveProjectRoot(start = process.cwd()) {
  let current = path.resolve(start)
  let projectRoot
  while (true) {
    if (await exists(path.join(current, '.git'))) return current
    if (!projectRoot && (await Promise.all(PROJECT_MARKERS.map((marker) => exists(path.join(current, marker))))).some(Boolean)) {
      projectRoot = current
    }
    const parent = path.dirname(current)
    if (parent === current) return projectRoot || path.resolve(start)
    current = parent
  }
}
