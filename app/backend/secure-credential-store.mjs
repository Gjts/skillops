import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { EvaluationError } from './evaluations/errors.mjs'

const CREDENTIALS = new Set(['prompthub'])
const SERVICE = 'skillops'
const POWERSHELL_PROTECT = "$inputText=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($inputText);$encrypted=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($encrypted))"
const POWERSHELL_UNPROTECT = "$inputText=[Console]::In.ReadToEnd();$bytes=[Convert]::FromBase64String($inputText);$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))"
const MACOS_KEYCHAIN_SCRIPT = String.raw`
ObjC.import('Foundation')
ObjC.import('Security')
ObjC.import('stdlib')

function query(account) {
  const value = $.NSMutableDictionary.alloc.init
  value.setObjectForKey($.kSecClassGenericPassword, $.kSecClass)
  value.setObjectForKey(ObjC.wrap('skillops'), $.kSecAttrService)
  value.setObjectForKey(ObjC.wrap(account), $.kSecAttrAccount)
  return value
}

function checked(status, missingIsNormal) {
  const code = Number(status)
  if (code === 0) return
  if (missingIsNormal && code === -25300) $.exit(44)
  throw new Error('Keychain operation failed (' + code + ').')
}

function run(argv) {
  const operation = argv[0]
  const item = query(argv[1])
  if (operation === 'get') {
    item.setObjectForKey($.kCFBooleanTrue, $.kSecReturnData)
    const result = Ref()
    checked($.SecItemCopyMatching(item, result), true)
    $.NSFileHandle.fileHandleWithStandardOutput.writeData(result[0])
    return
  }
  if (operation === 'set') {
    const secret = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
    const added = item.mutableCopy
    added.setObjectForKey(secret, $.kSecValueData)
    const status = Number($.SecItemAdd(added, null))
    if (status === -25299) {
      const update = $.NSMutableDictionary.alloc.init
      update.setObjectForKey(secret, $.kSecValueData)
      checked($.SecItemUpdate(item, update), false)
    } else checked(status, false)
    return
  }
  if (operation === 'remove') {
    checked($.SecItemDelete(item), true)
    return
  }
  throw new Error('Unsupported Keychain operation.')
}`

function credentialId(value) {
  if (!CREDENTIALS.has(value)) throw new EvaluationError('Credential ID is invalid.', 422)
  return value
}

function credential(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_000 || /[\u0000\r\n]/.test(value)) {
    throw new EvaluationError('Credential value is invalid.', 422)
  }
  return value.trim()
}

function commandError(error) {
  if (error instanceof EvaluationError) return error
  return new EvaluationError('The operating-system credential store is unavailable.', 503)
}

function runCommand(command, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    let size = 0
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) child.kill()
      else stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => { if (Buffer.concat(stderr).length < 16 * 1024) stderr.push(chunk) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 && size <= 64 * 1024) resolve(Buffer.concat(stdout).toString('utf8'))
      else {
        const error = new Error(Buffer.concat(stderr).toString('utf8') || `Credential command exited with ${code}.`)
        error.code = code
        reject(error)
      }
    })
    child.stdin.end(input)
  })
}

async function replaceFileAtomic(file, contents) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}

export function createSecureCredentialStore(options = {}) {
  const platform = options.platform || process.platform
  const run = options.run || runCommand
  const dataDir = path.resolve(options.dataDir || process.env.SKILLOPS_DATA_DIR || path.join(process.cwd(), 'data'))
  const credentialDir = path.join(dataDir, 'credentials')
  const powershell = options.powershell || 'powershell.exe'

  async function set(id, value) {
    const name = credentialId(id)
    const secret = credential(value)
    try {
      if (platform === 'win32') {
        const encrypted = (await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_PROTECT], secret)).trim()
        if (!/^[A-Za-z0-9+/]+=*$/.test(encrypted)) throw new Error('DPAPI returned invalid ciphertext.')
        await mkdir(credentialDir, { recursive: true })
        await replaceFileAtomic(path.join(credentialDir, `${name}.dpapi`), encrypted)
      } else if (platform === 'darwin') {
        await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MACOS_KEYCHAIN_SCRIPT, 'set', name], secret)
      } else if (platform === 'linux') {
        await run('secret-tool', ['store', '--label', `SkillOps ${name}`, 'service', SERVICE, 'account', name], secret)
      } else throw new EvaluationError('Secure credential storage is not supported on this operating system.', 501)
      return { id: name, configured: true, storage: platform === 'win32' ? 'windows-dpapi' : platform === 'darwin' ? 'macos-keychain' : 'linux-secret-service' }
    } catch (error) { throw commandError(error) }
  }

  async function get(id) {
    const name = credentialId(id)
    try {
      if (platform === 'win32') {
        const encrypted = (await readFile(path.join(credentialDir, `${name}.dpapi`), 'utf8')).trim()
        return credential(await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_UNPROTECT], encrypted))
      }
      if (platform === 'darwin') return credential(await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MACOS_KEYCHAIN_SCRIPT, 'get', name]))
      if (platform === 'linux') return credential(await run('secret-tool', ['lookup', 'service', SERVICE, 'account', name]))
      throw new EvaluationError('Secure credential storage is not supported on this operating system.', 501)
    } catch (error) {
      if (error?.code === 'ENOENT' || platform !== 'win32' && [1, 44].includes(error?.code)) return null
      throw commandError(error)
    }
  }

  async function remove(id) {
    const name = credentialId(id)
    try {
      if (platform === 'win32') await unlink(path.join(credentialDir, `${name}.dpapi`)).catch((error) => { if (error?.code !== 'ENOENT') throw error })
      else if (platform === 'darwin') await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MACOS_KEYCHAIN_SCRIPT, 'remove', name]).catch((error) => { if (error?.code !== 44) throw error })
      else if (platform === 'linux') await run('secret-tool', ['clear', 'service', SERVICE, 'account', name]).catch((error) => { if (error?.code !== 1) throw error })
      else throw new EvaluationError('Secure credential storage is not supported on this operating system.', 501)
      return { id: name, configured: false }
    } catch (error) { throw commandError(error) }
  }

  async function status(id) {
    const name = credentialId(id)
    return { id: name, configured: Boolean(await get(name)) }
  }

  return { set, get, remove, status }
}
