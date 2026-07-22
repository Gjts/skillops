import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'
import { normalizeArtifactDefinition } from '../../shared/evaluation-schema.mjs'
import { artifactIdFromPath } from '../artifact-identity.mjs'
import { adaptPromptDefinition } from '../prompts/prompt-definition.mjs'
import { artifactContentHash, normalizeArtifactContent } from './artifact-definition.mjs'
import { artifactPackageHash, MAX_ARTIFACT_PACKAGE_BYTES, normalizeArtifactPackage } from './artifact-package.mjs'
import { EvaluationError } from './errors.mjs'

const execute = promisify(execFile)
const MAX_ARTIFACT_BYTES = 256 * 1024
const MAX_ARTIFACTS = 1_000

function revision(value = 'HEAD') {
  if (typeof value !== 'string') throw new EvaluationError('Git Artifact revision is invalid.', 422)
  const normalized = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(normalized)
    || normalized.includes('..') || normalized.includes('//') || normalized.includes('@{') || normalized.endsWith('/') || normalized.endsWith('.lock')) {
    throw new EvaluationError('Git Artifact revision is invalid.', 422)
  }
  return normalized
}

function sourcePath(value) {
  if (typeof value !== 'string') throw new EvaluationError('Git Artifact path is invalid.', 422)
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '')
  if (!normalized || normalized.length > 1_000 || normalized.startsWith('/') || normalized.includes(':')
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new EvaluationError('Git Artifact path is invalid.', 422)
  }
  return normalized
}

function frontmatter(contents, key) {
  const block = contents.startsWith('---') ? contents.split(/^---\s*$/m)[1] || '' : ''
  const value = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim()
  return value?.replace(/^['"]|['"]$/g, '').trim() || undefined
}
function tomlString(contents, key) {
  const match = contents.match(new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`, 'm'))
  if (!match) return undefined
  if (match[1].startsWith("'")) return match[1].slice(1, -1).trim()
  try {
    return JSON.parse(match[1]).trim()
  } catch {
    return undefined
  }
}

function metadataValue(contents, key, relativePath) {
  return relativePath.toLowerCase().endsWith('.toml') ? tomlString(contents, key) : frontmatter(contents, key)
}


function frontmatterList(contents, key) {
  const value = frontmatter(contents, key)
  if (!value) return undefined
  const list = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  return list.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

function json(contents, label) {
  try {
    const value = JSON.parse(contents)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch {
    throw new EvaluationError(`${label} is not valid JSON.`, 422)
  }
}

export function classifyGitArtifactPath(value) {
  const relativePath = sourcePath(value)
  const lower = relativePath.toLowerCase()
  const basename = path.posix.basename(lower)
  if (basename === 'skill.md') return 'skill'
  if (lower.endsWith('.prompt.json')) return 'prompt'
  if ((lower.startsWith('.claude/commands/') || lower.startsWith('workflows/')) && lower.endsWith('.md')) return 'workflow'
  if (basename === 'agents.md' || basename === 'claude.md'
    || (lower.startsWith('rules/') || lower.startsWith('.claude/rules/') || lower.startsWith('.cursor/rules/')) && lower.endsWith('.md')) return 'rules'
  if (((lower.startsWith('agents/') || lower.startsWith('.claude/agents/')) && lower.endsWith('.md'))
    || (lower.startsWith('.codex/agents/') && lower.endsWith('.toml'))) return 'agent'
  if (lower.startsWith('evals/suites/') && lower.endsWith('.json')) return 'evaluation-suite'
  if ((lower.startsWith('policies/') || lower.startsWith('evals/policies/')) && lower.endsWith('.json')) return 'policy-pack'
  return null
}

function runtimeTargets(relativePath, kind) {
  const lower = relativePath.toLowerCase()
  if (kind === 'rules') {
    if (path.posix.basename(lower) === 'agents.md') return ['codex']
    if (path.posix.basename(lower) === 'claude.md' || lower.startsWith('.claude/rules/')) return ['claude-code']
    if (lower.startsWith('.cursor/rules/')) return ['cursor']
  }
  if (kind === 'workflow' && lower.startsWith('.claude/commands/')) return ['claude-code']
  if (kind === 'agent' && lower.startsWith('.claude/agents/')) return ['claude-code']
  if (kind === 'agent' && lower.startsWith('.codex/agents/')) return ['codex']
  if (kind === 'skill') {
    if (lower.startsWith('.claude/')) return ['claude-code']
    if (lower.startsWith('.cursor/')) return ['cursor']
    if (lower.startsWith('.codex/') || lower.startsWith('.agents/')) return ['codex']
  }
  return undefined
}


function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function gitArtifactSourceRef(repository, commit, relativePath, contentHash) {
  if (typeof repository !== 'string' || !repository || !/^[a-f0-9]{40,64}$/i.test(commit) || !/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new EvaluationError('Git Artifact source reference is invalid.', 422)
  }
  return `git:v1:${sha256(repository)}:${commit.toLowerCase()}:${encodeURIComponent(sourcePath(relativePath))}:${contentHash}`
}

function parseSourceRef(value) {
  if (typeof value !== 'string') throw new EvaluationError('Git Artifact source reference is invalid.', 422)
  const match = /^git:v1:([a-f0-9]{64}):([a-f0-9]{40,64}):([^:]+):([a-f0-9]{64})$/i.exec(value)
  if (!match) throw new EvaluationError('Git Artifact source reference is invalid.', 422)
  let relativePath
  try { relativePath = sourcePath(decodeURIComponent(match[3])) } catch {
    throw new EvaluationError('Git Artifact source reference path is invalid.', 422)
  }
  return { repositoryHash: match[1].toLowerCase(), commit: match[2].toLowerCase(), relativePath, contentHash: match[4].toLowerCase() }
}

export function createGitArtifactSource(options = {}) {
  const environment = options.environment || process.env
  const workspace = path.resolve(options.artifactWorkspace || environment.SKILLOPS_ARTIFACT_GIT_WORKSPACE || process.cwd())
  const runGit = options.runGit || (async (args, maxBuffer = 2 * 1024 * 1024) => {
    try {
      const result = await execute('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer })
      return result.stdout
    } catch {
      throw new EvaluationError('Git Artifact source operation failed.', 409)
    }
  })
  const runGitBytes = options.runGitBytes || (async (args, maxBuffer = MAX_ARTIFACT_PACKAGE_BYTES + 1) => {
    try {
      const result = await execute('git', ['-C', workspace, ...args], { encoding: null, windowsHide: true, maxBuffer })
      return Buffer.from(result.stdout)
    } catch {
      throw new EvaluationError('Git Artifact source operation failed.', 409)
    }
  })

  async function commitFor(value) {
    const commit = (await runGit(['rev-parse', '--verify', `${revision(value)}^{commit}`])).trim().toLowerCase()
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new EvaluationError('Git Artifact revision did not resolve to a commit.', 409)
    return commit
  }

  async function repositoryIdentity(commit) {
    const remote = (await runGit(['config', '--get', 'remote.origin.url']).catch(() => '')).trim()
    const scp = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(remote)
    const candidate = scp ? `https://${scp[1]}/${scp[2]}` : remote
    try {
      const url = new URL(candidate)
      if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) {
        return url.toString().replace(/\.git\/?$/, '').replace(/\/$/, '')
      }
    } catch {
      // Local and credentialed remotes are represented by their immutable root commit.
    }
    const roots = (await runGit(['rev-list', '--max-parents=0', commit])).trim()
    const root = roots.split(/\r?\n/).find((item) => /^[a-f0-9]{40,64}$/i.test(item)) || commit
    return `git-root:${root.toLowerCase()}`
  }

  async function readSkillPackage(commit, relativePath) {
    const root = path.posix.dirname(relativePath)
    const prefix = root === '.' ? '' : `${root}/`
    const output = await runGit(['ls-tree', '-r', '-z', commit, '--', root], 2 * 1024 * 1024)
    const files = []
    for (const record of output.split('\0').filter(Boolean)) {
      const match = /^([0-7]{6}) blob ([a-f0-9]{40,64})\t([\s\S]+)$/i.exec(record)
      if (!match) throw new EvaluationError('Skill packages may contain only committed regular files.', 422)
      const repositoryPath = sourcePath(match[3])
      if (prefix && !repositoryPath.startsWith(prefix)) throw new EvaluationError('Git Skill package escaped its directory.', 422)
      const packageRelativePath = prefix ? repositoryPath.slice(prefix.length) : repositoryPath
      files.push({
        relativePath: packageRelativePath,
        mode: match[1] === '100755' ? 0o755 : 0o644,
        contents: await runGitBytes(['cat-file', 'blob', match[2]]),
      })
    }
    const packageFiles = normalizeArtifactPackage(files)
    const primary = packageFiles.find((file) => file.relativePath === path.posix.basename(relativePath))
    if (!primary) throw new EvaluationError('Git Skill package does not contain its SKILL.md.', 422)
    let contents
    try {
      contents = normalizeArtifactContent(new TextDecoder('utf-8', { fatal: true }).decode(primary.contents))
    } catch {
      throw new EvaluationError('Git Skill definition must be UTF-8 text.', 422)
    }
    if (Buffer.byteLength(contents, 'utf8') > MAX_ARTIFACT_BYTES) throw new EvaluationError('Git Artifact exceeds the 256 KiB limit.', 422)
    return { contents, packageFiles, contentHash: artifactPackageHash(packageFiles) }
  }

  async function readArtifact(commit, relativePath, repository) {
    const kind = classifyGitArtifactPath(relativePath)
    if (!kind) throw new EvaluationError('Git path is not a supported Artifact.', 422)
    const packageRecord = kind === 'skill' ? await readSkillPackage(commit, relativePath) : null
    const contents = packageRecord?.contents
      || normalizeArtifactContent(await runGit(['show', `${commit}:${relativePath}`], MAX_ARTIFACT_BYTES + 1))
    if (!packageRecord && Buffer.byteLength(contents, 'utf8') > MAX_ARTIFACT_BYTES) throw new EvaluationError('Git Artifact exceeds the 256 KiB limit.', 422)
    if (kind === 'prompt') {
      const record = adaptPromptDefinition(json(contents, `Prompt definition ${relativePath}`), { commit, relativePath, repository })
      const sourceRef = gitArtifactSourceRef(repository, commit, relativePath, record.artifact.contentHash)
      return {
        ...record,
        artifact: normalizeArtifactDefinition({ ...record.artifact, source: 'git', sourceRef }),
      }
    }
    const contentHash = packageRecord?.contentHash || artifactContentHash(contents)
    const sourceRef = gitArtifactSourceRef(repository, commit, relativePath, contentHash)
    const metadata = kind === 'evaluation-suite' || kind === 'policy-pack' ? json(contents, `${kind} ${relativePath}`) : {}
    const artifactId = String(metadata.id || metadataValue(contents, 'id', relativePath) || metadataValue(contents, 'name', relativePath) || artifactIdFromPath(relativePath, kind))
    const name = String(metadata.name || metadataValue(contents, 'name', relativePath) || artifactId)
    const version = String(metadata.version || metadataValue(contents, 'version', relativePath) || commit)
    const targets = runtimeTargets(relativePath, kind)
    return {
      artifact: normalizeArtifactDefinition({
        kind,
        artifactId,
        version,
        description: metadata.description || metadataValue(contents, 'description', relativePath),
        source: 'git',
        sourceRef,
        contentHash,
        gitCommit: commit,
        repository,
        dependencies: metadata.dependencies || frontmatterList(contents, 'dependencies'),
        runtimeTargets: targets,
        compatibility: targets ? Object.fromEntries(targets.map((runtime) => [runtime, 'supported'])) : undefined,
        schemaVersion: metadata.schemaVersion,
      }),
      contents,
      metadata: { id: artifactId, name, relativePath, commit },
      ...(packageRecord ? { packageFiles: packageRecord.packageFiles } : {}),
    }
  }

  async function list(input = {}) {
    const commit = await commitFor(input.revision || 'HEAD')
    const repository = await repositoryIdentity(commit)
    const output = await runGit(['ls-tree', '-r', '-z', '--name-only', commit])
    const files = output.split('\0').filter((item) => item && classifyGitArtifactPath(item))
    if (files.length > MAX_ARTIFACTS) throw new EvaluationError(`Git source contains more than ${MAX_ARTIFACTS} Artifacts.`, 422)
    const items = []
    const warnings = []
    for (const relativePath of files) {
      try {
        const record = await readArtifact(commit, relativePath, repository)
        items.push({ artifact: record.artifact, id: record.metadata.id, name: record.metadata.name, relativePath, commit })
      } catch (error) {
        warnings.push({ relativePath, code: 'INVALID_GIT_ARTIFACT', message: error instanceof Error ? error.message : 'Git Artifact is invalid.' })
      }
    }
    return { revision: input.revision || 'HEAD', commit, items, warnings }
  }

  async function resolveArtifact(value) {
    const ref = parseSourceRef(value)
    const repository = await repositoryIdentity(ref.commit)
    if (sha256(repository) !== ref.repositoryHash) throw new EvaluationError('Git Artifact repository identity does not match its immutable reference.', 409)
    const record = await readArtifact(ref.commit, ref.relativePath, repository)
    if (record.artifact.sourceRef !== value || record.artifact.contentHash !== ref.contentHash) {
      throw new EvaluationError('Git Artifact content does not match its immutable reference.', 409)
    }
    return record
  }

  return { workspace, list, resolveArtifact }
}

let defaultSource
export function gitArtifactSource(options = {}) {
  if (!defaultSource) defaultSource = createGitArtifactSource(options)
  return defaultSource
}
