import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import dgram from 'node:dgram'
import dns from 'node:dns'
import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

const installed = Symbol.for('skillops.test.no-egress')
const explicitHosts = new Set((process.env.SKILLOPS_TEST_EGRESS_ALLOWLIST || '')
  .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean))
const explicitProcesses = new Set((process.env.SKILLOPS_TEST_PROCESS_ALLOWLIST || '')
  .split(',').map((command) => command.trim().toLowerCase()).filter(Boolean))
const offlineGitCommands = new Set([
  'add', 'branch', 'cat-file', 'checkout', 'commit', 'config', 'diff', 'for-each-ref', 'hash-object',
  'init', 'log', 'ls-tree', 'merge-base', 'reset', 'rev-list', 'rev-parse', 'show', 'status', 'switch', 'symbolic-ref', 'update-ref',
])
const dnsOperations = [
  'lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny',
  'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs',
  'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse',
]

export function isAllowedNetworkHost(value) {
  if (!value) return true
  const host = String(value).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || explicitHosts.has(host)) return true
  const ipv4 = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host
  return net.isIP(ipv4) === 4 && ipv4.split('.')[0] === '127'
}

function assertAllowed(host) {
  if (!isAllowedNetworkHost(host)) throw new Error(`Unexpected network egress to ${host}. Set SKILLOPS_TEST_EGRESS_ALLOWLIST only for a declared test dependency.`)
}

function guardDns(target) {
  for (const name of dnsOperations) {
    const operation = target?.[name]
    if (typeof operation !== 'function') continue
    target[name] = function (host, ...args) {
      assertAllowed(host)
      return operation.call(this, host, ...args)
    }
  }
}

function urlHost(input) {
  const value = typeof input === 'string' || input instanceof URL ? input : input?.url
  if (!value) return undefined
  return new URL(String(value), 'http://localhost').hostname
}

function requestHost(args) {
  const first = args[0]
  if (first instanceof URL || typeof first === 'string') return urlHost(first)
  if (first && typeof first === 'object') return first.hostname || String(first.host || '').replace(/:\d+$/, '') || 'localhost'
  return 'localhost'
}

function socketHost(args) {
  const values = Array.isArray(args[0]) ? args[0] : args
  const first = values[0]
  if (first && typeof first === 'object') return first.host || first.hostname || 'localhost'
  if (typeof first === 'number') return typeof values[1] === 'string' ? values[1] : 'localhost'
  return undefined
}

function datagramHost(args) {
  for (let index = args.length - 1; index > 0; index -= 1) {
    if (typeof args[index] === 'string') return args[index]
  }
  return undefined
}

function executableName(command) {
  return String(command || '').split(/[\\/]/).at(-1).toLowerCase()
}

function gitCommand(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index])
    if (['-C', '-c', '--git-dir', '--work-tree'].includes(value)) {
      index += 1
      continue
    }
    if (!value.startsWith('-')) return value.toLowerCase()
  }
  return ''
}

function assertAllowedProcess(command, args, options) {
  if (options?.shell) throw new Error('Unexpected child process with a shell. Tests must use an explicit offline executable.')
  const name = executableName(command)
  if (name === executableName(process.execPath)) return true
  if (explicitProcesses.has(name)) return false
  if ((name === 'git' || name === 'git.exe') &&
      offlineGitCommands.has(gitCommand(args)) &&
      !args.some((value) => /(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i.test(String(value)))) return false
  throw new Error(`Unexpected child process ${name || command}. Set SKILLOPS_TEST_PROCESS_ALLOWLIST only for a declared offline test dependency.`)
}

function processOptions(rest) {
  const index = Array.isArray(rest[0]) ? 1 : 0
  const value = rest[index]
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function guardedNodeRest(rest, guardOption) {
  const next = [...rest]
  const index = Array.isArray(next[0]) ? 1 : 0
  const current = processOptions(next) || {}
  const guarded = {
    ...current,
    env: { ...(current.env || process.env), NODE_OPTIONS: guardOption },
  }
  if (processOptions(next)) next[index] = guarded
  else next.splice(index, 0, guarded)
  return next
}

function guardRequest(module) {
  const request = module.request.bind(module)
  const get = module.get.bind(module)
  module.request = (...args) => {
    assertAllowed(requestHost(args))
    return request(...args)
  }
  module.get = (...args) => {
    assertAllowed(requestHost(args))
    return get(...args)
  }
}

function install() {
  if (globalThis[installed]) return
  Object.defineProperty(globalThis, installed, { value: true })
  const guardOption = `--import=${import.meta.url}`
  if (!(process.env.NODE_OPTIONS || '').includes(guardOption)) {
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, guardOption].filter(Boolean).join(' ')
  }

  const fetch = globalThis.fetch?.bind(globalThis)
  if (fetch) globalThis.fetch = (input, init) => {
    assertAllowed(urlHost(input))
    return fetch(input, init)
  }

  guardRequest(http)
  guardRequest(https)

  const connectHttp2 = http2.connect.bind(http2)
  http2.connect = (authority, ...args) => {
    assertAllowed(urlHost(authority))
    return connectHttp2(authority, ...args)
  }

  const socketConnect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (...args) {
    assertAllowed(socketHost(args))
    return socketConnect.apply(this, args)
  }

  const tlsConnect = tls.connect.bind(tls)
  tls.connect = (...args) => {
    assertAllowed(socketHost(args))
    return tlsConnect(...args)
  }

  const datagramConnect = dgram.Socket.prototype.connect
  dgram.Socket.prototype.connect = function (...args) {
    assertAllowed(socketHost(args))
    return datagramConnect.apply(this, args)
  }
  const datagramSend = dgram.Socket.prototype.send
  dgram.Socket.prototype.send = function (...args) {
    assertAllowed(datagramHost(args))
    return datagramSend.apply(this, args)
  }

  guardDns(dns)
  guardDns(dns.promises)
  guardDns(dns.Resolver?.prototype)
  guardDns(dns.promises?.Resolver?.prototype)
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = childProcess[name]
    const operation = original.bind(childProcess)
    const guarded = (command, ...rest) => {
      const args = Array.isArray(rest[0]) ? rest[0] : []
      const isNode = assertAllowedProcess(command, args, processOptions(rest))
      return operation(command, ...(isNode ? guardedNodeRest(rest, guardOption) : rest))
    }
    Object.setPrototypeOf(guarded, original)
    childProcess[name] = guarded
  }
  const fork = childProcess.fork.bind(childProcess)
  childProcess.fork = (modulePath, ...rest) => {
    const options = processOptions(rest)
    assertAllowedProcess(options?.execPath || process.execPath, Array.isArray(rest[0]) ? rest[0] : [], options)
    return fork(modulePath, ...guardedNodeRest(rest, guardOption))
  }
  for (const name of ['exec', 'execSync']) {
    childProcess[name] = () => {
      throw new Error('Unexpected shell child process. Tests must use an explicit offline executable.')
    }
  }
  syncBuiltinESMExports()
}

install()
