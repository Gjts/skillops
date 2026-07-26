import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'

async function replaceDiagnostic(file, contents) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(contents, 'utf8')
    await handle.close()
    handle = null
    await rename(temporary, file)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function sanitizeAdapterDiagnostics(file, marker) {
  try {
    await lstat(file)
    await replaceDiagnostic(file, `${marker}\n`)
  } catch (error) {
    if (error?.code !== 'ENOENT') return false
  }
  return true
}

export async function recordAdapterFailure(file, line) {
  try {
    await replaceDiagnostic(file, `${line}\n`)
    return true
  } catch {
    return false
  }
}
