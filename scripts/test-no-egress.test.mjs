// @vitest-environment node
import { spawnSync } from 'node:child_process'
import dns from 'node:dns'
import dgram from 'node:dgram'
import http2 from 'node:http2'
import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { isAllowedNetworkHost } from './test-no-egress.mjs'

describe('default no-egress test guard', () => {
  it('allows loopback targets and rejects external hosts', () => {
    expect(isAllowedNetworkHost('127.0.0.1')).toBe(true)
    expect(isAllowedNetworkHost('::1')).toBe(true)
    expect(isAllowedNetworkHost('localhost')).toBe(true)
    expect(isAllowedNetworkHost('example.com')).toBe(false)
    expect(isAllowedNetworkHost('127.attacker.example')).toBe(false)
    expect(isAllowedNetworkHost('127.0.0.1.attacker.example')).toBe(false)
    expect(isAllowedNetworkHost('::ffff:127.attacker.example')).toBe(false)
  })

  it('blocks fetch, TCP, UDP, and child-process bypasses before an external connection is attempted', () => {
    expect(() => globalThis.fetch('https://example.com/private')).toThrow(/Unexpected network egress/)
    expect(() => net.connect(443, 'example.com')).toThrow(/Unexpected network egress/)
    expect(() => http2.connect('https://example.com')).toThrow(/Unexpected network egress/)
    expect(() => dns.resolveMx('example.com', () => {})).toThrow(/Unexpected network egress/)
    expect(() => dns.promises.resolve4('example.com')).toThrow(/Unexpected network egress/)
    expect(() => new dns.Resolver().resolve4('example.com', () => {})).toThrow(/Unexpected network egress/)
    expect(() => new dns.promises.Resolver().resolve4('example.com')).toThrow(/Unexpected network egress/)
    const socket = dgram.createSocket('udp4')
    try {
      expect(() => socket.connect(53, '8.8.8.8')).toThrow(/Unexpected network egress/)
    } finally {
      socket.close()
    }
    expect(process.env.NODE_OPTIONS).toContain('test-no-egress.mjs')
    const child = spawnSync(process.execPath, ['-e', "fetch('https://example.com')"], { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' })
    expect(child.status).not.toBe(0)
    expect(`${child.stdout}${child.stderr}`).toContain('Unexpected network egress')
    expect(() => spawnSync('curl', ['https://example.com'])).toThrow(/Unexpected child process/)
    expect(() => spawnSync('git', ['ls-remote', 'https://example.com/repository'])).toThrow(/Unexpected child process/)
    expect(() => spawnSync('git', ['status'], { shell: true })).toThrow(/Unexpected child process with a shell/)
    expect(spawnSync('git', ['rev-list', '--max-count=1', 'HEAD']).status).toBe(0)
    expect(spawnSync('git', ['ls-tree', '--name-only', 'HEAD']).status).toBe(0)
  })
})
