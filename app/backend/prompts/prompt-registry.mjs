import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { EvaluationError } from '../evaluations/errors.mjs'
import { adaptPromptDefinition, parsePromptRegistrySourceRef } from './prompt-definition.mjs'

const execFileAsync = promisify(execFile)
const MAX_PROMPT_BYTES = 256 * 1024
const MAX_PROMPTS = 500

function revision(value = 'HEAD') {
  if (typeof value !== 'string') throw new EvaluationError('Prompt Registry revision is invalid.', 422)
  const normalized = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(normalized)
    || normalized.includes('..') || normalized.includes('//') || normalized.includes('@{') || normalized.endsWith('/') || normalized.endsWith('.lock')) {
    throw new EvaluationError('Prompt Registry revision is invalid.', 422)
  }
  return normalized
}

function promptDirectory(value = 'prompts') {
  if (typeof value !== 'string') throw new EvaluationError('Prompt Registry directory is invalid.', 500)
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
  if (!normalized || normalized.startsWith('/') || normalized.includes(':') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new EvaluationError('Prompt Registry directory must be a repository-relative path.', 500)
  }
  return normalized
}

function searchText(value, label) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new EvaluationError(`${label} is invalid.`, 422)
  return value.trim().toLocaleLowerCase('en-US')
}

function publicRecord(record) {
  return {
    artifact: record.artifact,
    id: record.metadata.id,
    name: record.metadata.name,
    description: record.metadata.description,
    relativePath: record.metadata.relativePath,
    commit: record.metadata.commit,
    provider: record.prompt.model.provider,
    model: record.prompt.model.name,
    variables: record.prompt.variables,
    componentHashes: record.artifact.componentHashes,
  }
}

export function createPromptRegistry(options = {}) {
  const workspace = path.resolve(options.promptWorkspace || options.environment?.SKILLOPS_PROMPT_WORKSPACE || process.env.SKILLOPS_PROMPT_WORKSPACE || process.cwd())
  const directory = promptDirectory(options.promptDirectory || options.environment?.SKILLOPS_PROMPT_DIRECTORY || process.env.SKILLOPS_PROMPT_DIRECTORY || 'prompts')
  const runGit = options.runGit || (async (args, maxBuffer = 2 * 1024 * 1024) => {
    try {
      const result = await execFileAsync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer })
      return result.stdout.trim()
    } catch (error) {
      const message = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
      throw new EvaluationError(message ? `Prompt Registry Git operation failed: ${message.slice(0, 300)}` : 'Prompt Registry Git operation failed.', 409)
    }
  })

  async function repositoryIdentity(commit) {
    const remote = await runGit(['config', '--get', 'remote.origin.url']).catch(() => '')
    const scp = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(remote)
    const candidate = scp ? `https://${scp[1]}/${scp[2]}` : remote
    try {
      const url = new URL(candidate)
      if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) {
        return url.toString().replace(/\.git\/?$/, '').replace(/\/$/, '')
      }
    } catch {
      // A local or credentialed remote is not public metadata.
    }
    const roots = await runGit(['rev-list', '--max-parents=0', commit]).catch(() => '')
    const root = roots.split(/\r?\n/).find((item) => /^[a-f0-9]{40,64}$/i.test(item)) || commit
    return `git-root:${root.toLowerCase()}`
  }
  async function commitFor(value) {
    const ref = revision(value)
    const commit = await runGit(['rev-parse', '--verify', `${ref}^{commit}`])
    if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new EvaluationError('Prompt Registry revision did not resolve to a commit.', 409)
    return commit.toLowerCase()
  }

  async function branches() {
    const output = await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    return [...new Set(output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))].sort()
  }

  async function readCommittedPrompt(commit, relativePath, repository) {
    if (!relativePath.startsWith(`${directory}/`) || !relativePath.endsWith('.prompt.json') || relativePath.includes('\\') || relativePath.split('/').includes('..')) {
      throw new EvaluationError('Prompt Registry path is outside the configured prompt directory.', 422)
    }
    const contents = await runGit(['show', `${commit}:${relativePath}`], MAX_PROMPT_BYTES + 1)
    if (Buffer.byteLength(contents, 'utf8') > MAX_PROMPT_BYTES) throw new EvaluationError('Prompt definition exceeds the 256 KiB limit.', 422)
    let parsed
    try { parsed = JSON.parse(contents) } catch { throw new EvaluationError(`Prompt definition ${relativePath} is not valid JSON.`, 422) }
    return adaptPromptDefinition(parsed, { commit, relativePath, repository: repository || await repositoryIdentity(commit) })
  }

  async function list(input = {}) {
    const commit = await commitFor(input.revision || 'HEAD')
    const repository = await repositoryIdentity(commit)
    const output = await runGit(['ls-tree', '-r', '--name-only', commit, '--', directory])
    const files = output.split(/\r?\n/).filter((item) => item.startsWith(`${directory}/`) && item.endsWith('.prompt.json'))
    if (files.length > MAX_PROMPTS) throw new EvaluationError(`Prompt Registry contains more than ${MAX_PROMPTS} prompt definitions.`, 422)
    const items = []
    const warnings = []
    for (const relativePath of files) {
      try { items.push(publicRecord(await readCommittedPrompt(commit, relativePath, repository))) } catch (error) {
        warnings.push({ relativePath, code: 'INVALID_PROMPT_DEFINITION', message: error instanceof Error ? error.message : 'Prompt definition is invalid.' })
      }
    }
    const search = searchText(input.search, 'Prompt search')
    const provider = searchText(input.provider, 'Prompt provider filter')
    const model = searchText(input.model, 'Prompt model filter')
    return {
      revision: input.revision || 'HEAD',
      commit,
      items: items.filter((item) => {
        const haystack = `${item.id}\n${item.name}\n${item.description || ''}\n${item.relativePath}`.toLocaleLowerCase('en-US')
        return (!search || haystack.includes(search))
          && (!provider || item.provider.toLocaleLowerCase('en-US') === provider)
          && (!model || item.model.toLocaleLowerCase('en-US').includes(model))
      }),
      warnings,
    }
  }

  async function resolveArtifact(sourceRef) {
    const parsed = parsePromptRegistrySourceRef(sourceRef)
    const record = await readCommittedPrompt(parsed.commit, parsed.relativePath)
    if (record.artifact.sourceRef !== sourceRef || record.artifact.contentHash !== parsed.contentHash) {
      throw new EvaluationError('Prompt Registry content does not match its immutable reference.', 409)
    }
    return record
  }

  return {
    workspace,
    directory,
    async status() {
      const [commit, availableBranches] = await Promise.all([commitFor('HEAD'), branches()])
      let currentBranch = 'HEAD'
      try { currentBranch = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD']) || 'HEAD' } catch {}
      return {
        available: true,
        workspace: path.basename(workspace),
        promptDirectory: directory,
        currentBranch,
        commit,
        branches: availableBranches,
        persistence: 'git-source-only',
      }
    },
    list,
    resolveArtifact,
    async compare(leftRef, rightRef) {
      const [left, right] = await Promise.all([resolveArtifact(leftRef), resolveArtifact(rightRef)])
      if (left.artifact.artifactId !== right.artifact.artifactId) throw new EvaluationError('Prompt comparison requires two versions of the same Prompt ID.', 422)
      const fields = ['system', 'prompt', 'model', 'configuration', 'variables']
      return {
        artifactId: left.artifact.artifactId,
        left: publicRecord(left),
        right: publicRecord(right),
        changedFields: fields.filter((field) => left.artifact.componentHashes?.[field] !== right.artifact.componentHashes?.[field]),
        changed: left.artifact.contentHash !== right.artifact.contentHash,
      }
    },
  }
}

let defaultRegistry
export function promptRegistry(options = {}) {
  if (!defaultRegistry) defaultRegistry = createPromptRegistry(options)
  return defaultRegistry
}
