// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSecureCredentialStore } from './secure-credential-store.mjs'

const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('secure credential store', () => {
  it('persists only DPAPI ciphertext on Windows and never returns the secret from status', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'skillops-credentials-'))
    roots.push(dataDir)
    const run = vi.fn(async (_command, args, input) => args.at(-1).includes('Protect(') ? Buffer.from(`encrypted:${input}`).toString('base64') : Buffer.from(input, 'base64').toString('utf8').replace('encrypted:', ''))
    const store = createSecureCredentialStore({ platform: 'win32', dataDir, run })

    expect(await store.set('prompthub', 'secret-token')).toEqual({ id: 'prompthub', configured: true, storage: 'windows-dpapi' })
    const persisted = await readFile(path.join(dataDir, 'credentials', 'prompthub.dpapi'), 'utf8')
    expect(persisted).not.toContain('secret-token')
    expect(await store.get('prompthub')).toBe('secret-token')
    expect(await store.status('prompthub')).toEqual({ id: 'prompthub', configured: true })
    expect(await store.remove('prompthub')).toEqual({ id: 'prompthub', configured: false })
    expect(await store.status('prompthub')).toEqual({ id: 'prompthub', configured: false })
  })

  it('routes macOS to Keychain without exposing plaintext in process arguments', async () => {
    const macRun = vi.fn(async (_command, args) => args.at(-2) === 'get' ? 'mac-token' : '')
    const mac = createSecureCredentialStore({ platform: 'darwin', run: macRun })
    expect(await mac.set('prompthub', 'mac-token')).toEqual(expect.objectContaining({ storage: 'macos-keychain' }))
    expect(await mac.get('prompthub')).toBe('mac-token')
    expect(macRun.mock.calls[0][0]).toBe('/usr/bin/osascript')
    expect(JSON.stringify(macRun.mock.calls[0][1])).not.toContain('mac-token')
    expect(macRun.mock.calls[0][2]).toBe('mac-token')
  })

  it('routes Linux to Secret Service without local persistence', async () => {
    const linuxRun = vi.fn(async (_command, args, input) => args[0] === 'lookup' ? 'linux-token' : input || '')
    const linux = createSecureCredentialStore({ platform: 'linux', run: linuxRun })
    expect(await linux.set('prompthub', 'linux-token')).toEqual(expect.objectContaining({ storage: 'linux-secret-service' }))
    expect(await linux.get('prompthub')).toBe('linux-token')
    expect(linuxRun.mock.calls[0]).toEqual(expect.arrayContaining(['secret-tool', expect.any(Array), 'linux-token']))
  })

  it('rejects unknown credential IDs and invalid plaintext', async () => {
    const store = createSecureCredentialStore({ platform: 'linux', run: vi.fn() })
    await expect(store.set('other', 'secret')).rejects.toThrow('Credential ID')
    await expect(store.set('prompthub', 'line\nbreak')).rejects.toThrow('Credential value')
  })
})
