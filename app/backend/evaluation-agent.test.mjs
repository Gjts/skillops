// @vitest-environment node
import { mkdtemp, mkdir, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceToolExecutor, runEvaluationAgent, WORKSPACE_TOOL_DEFINITIONS } from './evaluation-agent.mjs'

const temporaryRoots = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function workspaceFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'skillops-agent-')))
  temporaryRoots.push(root)
  await mkdir(path.join(root, 'app'), { recursive: true })
  await mkdir(path.join(root, 'data'), { recursive: true })
  await writeFile(path.join(root, 'README.md'), '# Fixture\nAuthentication boundary.\n')
  await writeFile(path.join(root, 'app', 'server.ts'), 'export const auth = true\n')
  await writeFile(path.join(root, '.env'), 'SECRET=never-send\n')
  await writeFile(path.join(root, '.npmrc'), '//registry.example/:_authToken=never-send\n')
  await writeFile(path.join(root, 'data', 'events.jsonl'), '{"prompt":"never-send"}\n')
  await writeFile(path.join(root, 'app', 'config.ts'), 'export const apiKey = "never-send"\n')
  return root
}

async function populateFiles(root, directory, count, contents = '') {
  await mkdir(path.join(root, directory), { recursive: true })
  await Promise.all(Array.from({ length: count }, (_, index) => (
    writeFile(path.join(root, directory, `file-${String(index).padStart(3, '0')}.txt`), contents)
  )))
}

async function linkedDirectory(target, link) {
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

describe('read-only evaluation workspace tools', () => {
  it('exposes only bounded read/list/search operations', () => {
    expect(WORKSPACE_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'list_workspace_files',
      'read_workspace_file',
      'search_workspace',
    ])
  })

  it('reads ordinary source while blocking secrets, runtime data, and traversal', async () => {
    const root = await workspaceFixture()
    const execute = createWorkspaceToolExecutor({ workspaceRoot: root })

    await expect(execute('read_workspace_file', { path: 'README.md' })).resolves.toContain('Authentication boundary')
    await expect(execute('read_workspace_file', { path: '.env' })).rejects.toThrow('privacy boundary')
    await expect(execute('read_workspace_file', { path: '.npmrc' })).rejects.toThrow('privacy boundary')
    await expect(execute('read_workspace_file', { path: 'data/events.jsonl' })).rejects.toThrow('privacy boundary')
    await expect(execute('read_workspace_file', { path: '../outside.txt' })).rejects.toThrow('stay within')
    await expect(execute('read_workspace_file', { path: 'app/config.ts' })).resolves.toBe('[REDACTED SENSITIVE LINE]\n')
  })

  it('omits blocked paths and their contents from list and search results', async () => {
    const root = await workspaceFixture()
    const execute = createWorkspaceToolExecutor({ workspaceRoot: root })

    const listed = await execute('list_workspace_files', {})
    const searched = await execute('search_workspace', { query: 'never-send' })

    expect(listed).toContain('README.md')
    expect(listed).toContain('app/server.ts')
    expect(listed).not.toContain('.env')
    expect(listed).not.toContain('.npmrc')
    expect(listed).not.toContain('events.jsonl')
    expect(searched).not.toContain('never-send')
    expect(searched).not.toContain('.env')
    expect(searched).not.toContain('events.jsonl')
  })

  it('blocks direct symlink or junction traversal into hidden and denied directories', async () => {
    const root = await workspaceFixture()
    await mkdir(path.join(root, '.git'), { recursive: true })
    await writeFile(path.join(root, '.git', 'leak.txt'), 'hidden-token\n')
    await writeFile(path.join(root, 'data', 'leak.txt'), 'runtime-token\n')
    await linkedDirectory(path.join(root, '.git'), path.join(root, 'hidden-link'))
    await linkedDirectory(path.join(root, 'data'), path.join(root, 'disabled-link'))
    const execute = createWorkspaceToolExecutor({ workspaceRoot: root })

    for (const directory of ['hidden-link', 'disabled-link']) {
      await expect(execute('read_workspace_file', { path: `${directory}/leak.txt` })).rejects.toThrow('privacy boundary')
      await expect(execute('list_workspace_files', { path: directory })).rejects.toThrow('privacy boundary')
      await expect(execute('search_workspace', { path: directory, query: 'token' })).rejects.toThrow('privacy boundary')
    }
  })

  it('rechecks enumerated search paths before reading replaced directories', async () => {
    const root = await workspaceFixture()
    const outside = await mkdtemp(path.join(os.tmpdir(), 'skillops-agent-outside-'))
    temporaryRoots.push(outside)
    const swappable = path.join(root, 'swappable')
    await mkdir(swappable)
    await writeFile(path.join(swappable, 'leak.txt'), 'inside-safe\n')
    await writeFile(path.join(outside, 'leak.txt'), 'outside-marker\n')
    let swapped = false
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual('node:fs/promises')
      return {
        ...actual,
        readdir: async (directory, ...args) => {
          const entries = await actual.readdir(directory, ...args)
          if (!swapped && path.resolve(String(directory)) === path.resolve(swappable)) {
            swapped = true
            await actual.rm(swappable, { recursive: true, force: true })
            await actual.symlink(outside, swappable, process.platform === 'win32' ? 'junction' : 'dir')
          }
          return entries
        },
      }
    })
    try {
      const moduleUrl = `${pathToFileURL(path.resolve('app/backend/evaluation-agent.mjs')).href}?search-race=${Date.now()}`
      const { createWorkspaceToolExecutor: createExecutor } = await import(/* @vite-ignore */ moduleUrl)
      const searched = JSON.parse(await createExecutor({ workspaceRoot: root })('search_workspace', { query: 'outside-marker' }))

      expect(searched.results).toEqual([])
      expect(searched.truncated).toBe(true)
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('rejects sensitive filenames and dependency build directories while allowing repository bin sources', async () => {
    const root = await workspaceFixture()
    const execute = createWorkspaceToolExecutor({ workspaceRoot: root })
    await writeFile(path.join(root, 'passwords.txt'), 'never-send\n')
    await writeFile(path.join(root, 'api_keys.txt'), 'never-send\n')
    await writeFile(path.join(root, 'github-pat.txt'), 'never-send\n')
    for (const directory of ['vendor', 'target', 'venv', 'out', 'obj']) {
      await mkdir(path.join(root, directory), { recursive: true })
      await writeFile(path.join(root, directory, 'leak.txt'), `${directory}-secret\n`)
    }
    await mkdir(path.join(root, 'bin'), { recursive: true })
    await writeFile(path.join(root, 'bin', 'tool.sh'), 'echo source-bin\n')
    await writeFile(path.join(root, 'auth.ts'), 'export const auth = true\n')

    for (const sensitivePath of ['passwords.txt', 'api_keys.txt', 'github-pat.txt']) {
      await expect(execute('read_workspace_file', { path: sensitivePath })).rejects.toThrow('privacy boundary')
    }
    for (const directory of ['vendor', 'target', 'venv', 'out', 'obj']) {
      await expect(execute('read_workspace_file', { path: `${directory}/leak.txt` })).rejects.toThrow('privacy boundary')
    }
    await expect(execute('read_workspace_file', { path: 'auth.ts' })).resolves.toContain('auth = true')

    const listed = await execute('list_workspace_files', {})
    const searched = await execute('search_workspace', { query: 'secret' })
    expect(listed).toContain('bin/tool.sh')
    expect(listed).not.toContain('passwords.txt')
    expect(listed).not.toContain('api_keys.txt')
    expect(listed).not.toContain('github-pat.txt')
    for (const directory of ['vendor', 'target', 'venv', 'out', 'obj']) {
      expect(listed).not.toContain(`${directory}/leak.txt`)
      expect(searched).not.toContain(`${directory}-secret`)
    }
  })

  it('redacts credential labels, GitHub tokens, credential URLs, and PEM private keys by line', async () => {
    const root = await workspaceFixture()
    const sensitiveLines = [
      'DB_PASSWORD=never-send',
      'GITHUB_PAT=short',
      'GITHUB_TOKEN=never-send',
      'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
      'DATABASE_URL=https://example.test/db',
      `${'github' + '_pat_' + 'A'.repeat(70)}`,
      `${'ghp_' + '1234567890'}`,
      `${'sk-' + '1234567890abcdefghij'}`,
      `${'sk-proj-' + '1234567890abcdefghij'}`,
      'AKIAIOSFODNN7EXAMPLE',
      'fetch("https://user:pass@example.test/repo.git")',
      '-----BEGIN RSA PRIVATE KEY-----',
      'base64-secret-body',
      '-----END RSA PRIVATE KEY-----',
    ]
    await writeFile(path.join(root, 'safe.txt'), [...sensitiveLines, 'safe line'].join('\n'))
    const execute = createWorkspaceToolExecutor({ workspaceRoot: root })

    await expect(execute('read_workspace_file', { path: 'safe.txt' })).resolves.toBe([
      ...sensitiveLines.map(() => '[REDACTED SENSITIVE LINE]'),
      'safe line',
    ].join('\n'))
  })

  it('returns only 200 listed files and propagates file enumeration truncation into search', async () => {
    const root = await workspaceFixture()
    await populateFiles(root, 'many', 201)
    const execute = createWorkspaceToolExecutor({ workspaceRoot: root })

    const listed = JSON.parse(await execute('list_workspace_files', { path: 'many' }))
    const searched = JSON.parse(await execute('search_workspace', { path: 'many', query: 'missing' }))

    expect(listed.files).toHaveLength(200)
    expect(listed.truncated).toBe(true)
    expect(searched.results).toEqual([])
    expect(searched.truncated).toBe(true)
  })

  it('rejects oversized reads by stat and skips search files that exceed the remaining byte budget', async () => {
    const root = await workspaceFixture()
    await writeFile(path.join(root, 'large-read.txt'), 'x')
    await truncate(path.join(root, 'large-read.txt'), 64_001)
    await writeFile(path.join(root, 'budget-overflow.txt'), 'needle')
    await truncate(path.join(root, 'budget-overflow.txt'), 2_000_001)
    const readAttempts = []
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual('node:fs/promises')
      return {
        ...actual,
        readFile: async (file, ...args) => {
          readAttempts.push(String(file))
          if (String(file).endsWith('large-read.txt') || String(file).endsWith('budget-overflow.txt')) {
            throw new Error(`unexpected read of ${file}`)
          }
          return actual.readFile(file, ...args)
        },
      }
    })
    try {
      const moduleUrl = `${pathToFileURL(path.resolve('app/backend/evaluation-agent.mjs')).href}?stat-budget=${Date.now()}`
      const { createWorkspaceToolExecutor: createExecutor } = await import(/* @vite-ignore */ moduleUrl)
      const execute = createExecutor({ workspaceRoot: root })

      await expect(execute('read_workspace_file', { path: 'large-read.txt' })).rejects.toThrow('64 KB')
      const searched = JSON.parse(await execute('search_workspace', { query: 'needle' }))

      expect(searched.results).toEqual([])
      expect(searched.truncated).toBe(true)
      expect(readAttempts.some((file) => file.endsWith('large-read.txt'))).toBe(false)
      expect(readAttempts.some((file) => file.endsWith('budget-overflow.txt'))).toBe(false)
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('keeps provider tool error messages free of filesystem paths and error codes', async () => {
    const root = await workspaceFixture()
    const providerMessages = []
    const callProvider = async (_provider, messages) => {
      providerMessages.push(messages)
      if (messages.some((message) => message.role === 'tool')) {
        return { content: 'done', usage: { totalTokens: 1 }, provider: 'test', model: 'test-model' }
      }
      return {
        content: '',
        toolCalls: [{ id: 'tool-1', name: 'read_workspace_file', arguments: { path: 'missing.txt' } }],
        usage: { totalTokens: 1 },
        provider: 'test',
        model: 'test-model',
      }
    }

    await runEvaluationAgent(callProvider, { provider: 'test', model: 'test-model' }, [{ role: 'user', content: 'Inspect.' }], { workspaceRoot: root })
    const toolMessage = providerMessages.at(-1).find((message) => message.role === 'tool')

    expect(toolMessage.content).toContain('Workspace tool failed')
    expect(toolMessage.content).not.toContain(root)
    expect(toolMessage.content).not.toContain('missing.txt')
    expect(toolMessage.content).not.toMatch(/ENOENT|ENOTDIR|EACCES|EPERM/)
  })
})
