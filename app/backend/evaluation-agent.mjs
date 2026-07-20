import { lstat, realpath, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

const MAX_AGENT_ROUNDS = 6
const MAX_TOOL_CALLS = 12
const MAX_FILE_BYTES = 64_000
const MAX_LIST_ENTRIES = 200
const MAX_SEARCH_RESULTS = 40
const MAX_SEARCH_BYTES = 2_000_000
const deniedDirectories = new Set([
  '.git', '.next', '.opc', '.turbo', 'build', 'coverage', 'data', 'dist', 'node_modules',
  'obj', 'out', 'target', 'vendor', 'venv',
])
const allowedExtensions = new Set([
  '', '.cjs', '.css', '.csv', '.html', '.ini', '.java', '.js', '.json', '.jsonc', '.jsx',
  '.md', '.mjs', '.py', '.rs', '.scss', '.sh', '.sql', '.toml', '.ts', '.tsx', '.txt',
  '.vue', '.xml', '.yaml', '.yml',
])
const sensitiveName = /(?:^|[._-])(?:api[_-]?keys?|github[_-]?pat|credential|credentials|secret|secrets|token|tokens|password|passwords|passwd)(?:$|[._-])/
const sensitiveLine = /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:api[_-]?keys?|github[_-]?pat|pat|tokens?|password|passwd|secret|access[_-]?token|access[_-]?key(?:[_-]?id)?|aws[_-]?access[_-]?key[_-]?id|database[_-]?url|db[_-]?url|authorization|bearer|private[_-]?key|client[_-]?secret)(?:$|[^A-Za-z0-9])/i
const githubToken = /\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/
const openAiToken = /\bsk-[A-Za-z0-9_-]{10,}\b/
const awsAccessKey = /\bAKIA[0-9A-Z]{16}\b/
const credentialUrl = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i
const privateKeyBegin = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i
const privateKeyEnd = /-----END [A-Z0-9 ]*PRIVATE KEY-----/i

export const WORKSPACE_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'list_workspace_files',
    description: 'List allowed non-hidden text files under the workspace, optionally below a relative directory.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative directory path. Defaults to the workspace root.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'read_workspace_file',
    description: 'Read one allowed text file from the workspace. Files are limited to 64 KB and credential-like lines are redacted.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative file path.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_workspace',
    description: 'Search allowed text files for a literal query and return bounded, credential-redacted matching lines.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Literal text to find.' },
        path: { type: 'string', description: 'Optional relative directory path.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
])

function isSensitiveName(name) {
  const normalized = name.toLowerCase()
  return normalized.startsWith('.') ||
    sensitiveName.test(normalized) ||
    /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/.test(normalized) ||
    ['.key', '.pem', '.p12', '.pfx'].includes(path.extname(normalized))
}

function redactSensitiveLines(text) {
  let inPrivateKey = false
  return text.split(/\r?\n/).map((line) => {
    const redact = inPrivateKey || privateKeyBegin.test(line) || sensitiveLine.test(line) ||
      githubToken.test(line) || openAiToken.test(line) || awsAccessKey.test(line) || credentialUrl.test(line)
    if (privateKeyBegin.test(line)) inPrivateKey = true
    if (privateKeyEnd.test(line)) inPrivateKey = false
    return redact ? '[REDACTED SENSITIVE LINE]' : line
  }).join('\n')
}

function assertSafeSegments(relativePath) {
  if (typeof relativePath !== 'string') throw new Error('path must be a string')
  if (relativePath.length > 1_000 || relativePath.includes('\0')) throw new Error('path is invalid')
  const segments = relativePath.replaceAll('\\', '/').split('/').filter((segment) => segment && segment !== '.')
  if (path.isAbsolute(relativePath) || segments.includes('..')) throw new Error('path must stay within the workspace')
  for (const segment of segments) {
    if (deniedDirectories.has(segment.toLowerCase()) || isSensitiveName(segment)) throw new Error('path is blocked by the privacy boundary')
  }
  return segments
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function safePath(root, relativePath = '.') {
  const segments = assertSafeSegments(relativePath)
  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    const entry = await lstat(current)
    if (entry.isSymbolicLink()) throw new Error('path is blocked by the privacy boundary')
  }
  const resolved = await realpath(path.resolve(root, ...segments))
  if (!isInside(root, resolved)) throw new Error('path must stay within the workspace')
  assertSafeSegments(path.relative(root, resolved) || '.')
  return resolved
}

function allowedFile(filePath) {
  return !isSensitiveName(path.basename(filePath)) && allowedExtensions.has(path.extname(filePath).toLowerCase())
}

async function collectFiles(root, directory, limit = MAX_LIST_ENTRIES) {
  const files = []
  async function walk(current) {
    if (files.length > limit) return
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (files.length > limit) return
      if (deniedDirectories.has(entry.name.toLowerCase()) || isSensitiveName(entry.name) || entry.isSymbolicLink()) continue
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(fullPath)
      else if (entry.isFile() && allowedFile(fullPath)) files.push(path.relative(root, fullPath).replaceAll('\\', '/'))
    }
  }
  await walk(directory)
  return { files: files.slice(0, limit), truncated: files.length > limit }
}

export function createWorkspaceToolExecutor(options = {}) {
  let workspaceRoot
  return async function executeWorkspaceTool(name, args = {}) {
    workspaceRoot ||= await realpath(options.workspaceRoot || process.cwd())
    if (!WORKSPACE_TOOL_DEFINITIONS.some((tool) => tool.name === name)) throw new Error('unknown workspace tool')
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('tool arguments must be an object')
    if (name === 'list_workspace_files') {
      const directory = await safePath(workspaceRoot, typeof args.path === 'string' ? args.path : '.')
      return JSON.stringify(await collectFiles(workspaceRoot, directory))
    }
    if (name === 'read_workspace_file') {
      const filePath = await safePath(workspaceRoot, args.path)
      if (!allowedFile(filePath)) throw new Error('file type is blocked by the privacy boundary')
      const info = await stat(filePath)
      if (!info.isFile()) throw new Error('file type is blocked by the privacy boundary')
      if (info.size > MAX_FILE_BYTES) throw new Error('file exceeds the 64 KB read limit')
      return redactSensitiveLines((await readFile(filePath)).toString('utf8'))
    }
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query || query.length > 500) throw new Error('query is required and must be at most 500 characters')
    const directory = await safePath(workspaceRoot, typeof args.path === 'string' ? args.path : '.')
    const { files, truncated: fileListTruncated } = await collectFiles(workspaceRoot, directory, MAX_LIST_ENTRIES)
    const results = []
    let bytesRead = 0
    let truncated = fileListTruncated
    for (const relativePath of files) {
      let filePath
      try {
        filePath = await safePath(workspaceRoot, relativePath)
      } catch {
        truncated = true
        break
      }
      const info = await stat(filePath)
      if (!info.isFile()) continue
      if (info.size > MAX_SEARCH_BYTES - bytesRead) {
        truncated = true
        break
      }
      const contents = await readFile(filePath)
      bytesRead += contents.byteLength
      for (const [index, line] of redactSensitiveLines(contents.toString('utf8')).split(/\r?\n/).entries()) {
        if (line.toLowerCase().includes(query.toLowerCase())) {
          results.push({ path: relativePath, line: index + 1, text: line.slice(0, 500) })
          if (results.length >= MAX_SEARCH_RESULTS) return JSON.stringify({ results, truncated: true })
        }
      }
    }
    return JSON.stringify({ results, truncated })
  }
}

function addUsage(total, usage = {}) {
  total.inputTokens += Number(usage.inputTokens || 0)
  total.outputTokens += Number(usage.outputTokens || 0)
  total.totalTokens += Number(usage.totalTokens || 0)
}

export async function runEvaluationAgent(callProvider, provider, initialMessages, options = {}) {
  const messages = [...initialMessages]
  const executeTool = options.executeWorkspaceTool || createWorkspaceToolExecutor({ workspaceRoot: options.workspaceRoot })
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let providerName = provider.provider
  let model = provider.model
  let toolCallCount = 0
  for (let round = 0; round < MAX_AGENT_ROUNDS; round += 1) {
    const response = await callProvider(provider, messages, { ...options, tools: WORKSPACE_TOOL_DEFINITIONS, maxTokens: 1_800 })
    addUsage(usage, response.usage)
    providerName = response.provider
    model = response.model
    const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : []
    if (!toolCalls.length) {
      if (!response.content?.trim()) throw new Error('AI provider returned neither a final answer nor a workspace tool call.')
      return { ...response, usage, provider: providerName, model }
    }
    messages.push({ role: 'assistant', content: response.content || '', toolCalls })
    for (const toolCall of toolCalls) {
      toolCallCount += 1
      if (toolCallCount > MAX_TOOL_CALLS) throw new Error('The read-only agent exceeded its 12-call workspace tool limit.')
      let content
      try {
        content = await executeTool(toolCall.name, toolCall.arguments)
      } catch {
        content = JSON.stringify({ error: 'Workspace tool failed.' })
      }
      messages.push({ role: 'tool', toolCallId: toolCall.id, name: toolCall.name, content: String(content).slice(0, 70_000) })
    }
  }
  throw new Error('The read-only agent did not finish within 6 model rounds.')
}
