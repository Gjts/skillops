import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { scanInstalledSkills } from '../skill-scanner.mjs'
import { artifactContentHash, createRuntimeArtifactDefinition, createSkillArtifactDefinition, normalizeArtifactContent } from './artifact-definition.mjs'
import { artifactPackageHash, MAX_ARTIFACT_PACKAGE_BYTES, MAX_ARTIFACT_PACKAGE_FILES, normalizeArtifactPackage } from './artifact-package.mjs'
import { EvaluationError, optionalString, requiredString } from './errors.mjs'
import { boundedResponseBytes, boundedResponseText } from './response-limit.mjs'

export const MAX_SKILL_BYTES = 256_000
const MAX_GITHUB_JSON_BYTES = 8_000_000

const stopWords = new Set([
  'about', 'after', 'also', 'and', 'are', 'been', 'before', 'being', 'can', 'codex', 'claude',
  'does', 'each', 'file', 'for', 'from', 'have', 'into', 'its', 'more', 'must', 'not', 'only',
  'other', 'should', 'skill', 'skills', 'that', 'the', 'their', 'then', 'these', 'this', 'through',
  'use', 'used', 'user', 'using', 'when', 'where', 'which', 'will', 'with', 'you', 'your',
])

function frontmatter(text, key) {
  const block = text.startsWith('---') ? text.split(/^---\s*$/m)[1] ?? '' : ''
  const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  const value = match?.[1]?.trim()
  if (!value) return undefined
  return value.replace(/^['"]|['"]$/g, '').trim()
}

function headingList(text) {
  return [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map((match) => match[1].trim()).slice(0, 24)
}

function stripFrontmatter(text) {
  return text.startsWith('---') ? text.replace(/^---\s*[\s\S]*?^---\s*$/m, '') : text
}

export function parseSkillDefinition(contents, fallbackName, metadata = {}) {
  if (typeof contents !== 'string' || !contents.trim()) throw new EvaluationError('The selected SKILL.md is empty.', 422)
  if (Buffer.byteLength(contents, 'utf8') > MAX_SKILL_BYTES) throw new EvaluationError('The selected SKILL.md exceeds the 256 KB evaluation limit.', 413)
  const normalizedContents = normalizeArtifactContent(contents)
  const definition = {
    skillId: frontmatter(contents, 'name') || fallbackName || 'unnamed-skill',
    skillVersion: frontmatter(contents, 'version') || metadata.skillVersion || 'unversioned',
    description: frontmatter(contents, 'description') || metadata.description,
    headings: headingList(contents),
    contents: normalizedContents,
    ...metadata,
    contentHash: metadata.contentHash || artifactContentHash(normalizedContents),
  }
  definition.artifact = createSkillArtifactDefinition(definition, metadata.sourceUrl ? 'github' : 'local-scan')
  return definition
}

function githubCoordinates(sourceUrl) {
  let url
  try {
    url = new URL(sourceUrl)
  } catch {
    throw new EvaluationError('Enter a valid public GitHub URL.')
  }
  if (url.protocol !== 'https:') throw new EvaluationError('Candidate URLs must use HTTPS.')
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (url.hostname === 'raw.githubusercontent.com') {
    if (parts.length < 4 || parts.at(-1) !== 'SKILL.md') throw new EvaluationError('The raw GitHub URL must point to a SKILL.md file.')
    return {
      owner: parts[0],
      repo: parts[1],
      repository: `https://github.com/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`,
      branch: parts[2],
      directPath: parts.slice(3).join('/'),
    }
  }
  if (url.hostname !== 'github.com' || parts.length < 2) {
    throw new EvaluationError('Candidate discovery currently supports public github.com repositories and raw SKILL.md URLs.')
  }
  const [owner, repo] = parts
  const repository = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  if (parts[2] === 'blob') {
    const directPath = parts.slice(4).join('/')
    if (!parts[3] || path.posix.basename(directPath) !== 'SKILL.md') throw new EvaluationError('The GitHub file URL must point to a SKILL.md file.')
    return { owner, repo, repository, branch: parts[3], directPath }
  }
  if (parts[2] === 'tree' && !parts[3]) throw new EvaluationError('The GitHub tree URL is missing a branch.')
  return {
    owner,
    repo,
    repository,
    branch: parts[2] === 'tree' ? parts[3] : undefined,
    prefix: parts[2] === 'tree' ? parts.slice(4).join('/') : '',
  }
}

export async function remoteRequest(url, options = {}, fetchImpl = fetch, timeoutMs = 20_000, consume = (response) => response) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal })
      return await consume(response)
    } catch (error) {
      if (error instanceof EvaluationError) throw error
      lastError = controller.signal.aborted
        ? new EvaluationError('The remote request timed out.', 504)
        : new EvaluationError(error instanceof Error ? `Remote request failed: ${error.message}` : 'Remote request failed.', 502)
      if (attempt === 1) throw lastError
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

async function githubJson(url, fetchImpl) {
  return remoteRequest(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'SkillOps-local-evaluator',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  }, fetchImpl, 20_000, async (response) => {
    if (!response.ok) throw new EvaluationError(`GitHub returned ${response.status} while discovering candidate Skills.`, response.status === 404 ? 404 : 502)
    const text = await boundedResponseText(response, MAX_GITHUB_JSON_BYTES, 'The GitHub discovery response exceeds the safe evaluation limit.')
    try { return JSON.parse(text) } catch { throw new EvaluationError('GitHub returned invalid discovery data.', 502) }
  })
}


export async function discoverGithubSkill(sourceUrl, candidatePath, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const source = requiredString(sourceUrl, 'Candidate URL', 2_000)
  const coordinates = githubCoordinates(source)
  let branch = coordinates.branch
  if (!branch) {
    const repository = await githubJson(`https://api.github.com/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}`, fetchImpl)
    branch = repository.default_branch
  }
  if (typeof branch !== 'string' || !branch) throw new EvaluationError('GitHub did not return a default branch.', 502)
  const revision = await githubJson(`https://api.github.com/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}/commits/${encodeURIComponent(branch)}`, fetchImpl)
  const commit = typeof revision.sha === 'string' ? revision.sha.toLowerCase() : ''
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new EvaluationError('GitHub did not resolve the selected revision to an immutable commit.', 502)
  const tree = await githubJson(`https://api.github.com/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}/git/trees/${commit}?recursive=1`, fetchImpl)
  if (tree.truncated) throw new EvaluationError('This repository tree is too large for safe candidate discovery. Link to a smaller Skill repository.', 422)
  const entries = Array.isArray(tree.tree) ? tree.tree : []
  const rawUrl = (sourcePath) => `https://raw.githubusercontent.com/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}/${commit}/${sourcePath.split('/').map(encodeURIComponent).join('/')}`
  const safeBlob = (entry) => entry?.type === 'blob'
    && typeof entry.path === 'string'
    && ['100644', '100755'].includes(entry.mode)
  let refs
  if (coordinates.directPath) {
    const entry = entries.find((item) => safeBlob(item) && item.path === coordinates.directPath)
    refs = entry ? [{ sourcePath: entry.path, sha: entry.sha, downloadUrl: rawUrl(entry.path) }] : []
  } else {
    const prefix = coordinates.prefix ? `${coordinates.prefix.replace(/\/+$/, '')}/` : ''
    refs = entries
      .filter((entry) => safeBlob(entry) && path.posix.basename(entry.path) === 'SKILL.md' && (!prefix || entry.path.startsWith(prefix)))
      .map((entry) => ({ sourcePath: entry.path, sha: entry.sha, downloadUrl: rawUrl(entry.path) }))
      .sort((left, right) => left.sourcePath.split('/').length - right.sourcePath.split('/').length || left.sourcePath.localeCompare(right.sourcePath))
      .slice(0, 40)
  }
  if (!refs.length) throw new EvaluationError('No SKILL.md files were found at this GitHub location.', 404)
  const selected = candidatePath ? refs.find((item) => item.sourcePath === candidatePath) : refs[0]
  if (!selected) throw new EvaluationError('The selected candidate is not present at this GitHub location.', 404)
  const packageDirectory = path.posix.dirname(selected.sourcePath)
  const packagePrefix = packageDirectory === '.' ? '' : `${packageDirectory}/`
  const packageEntries = entries.filter((entry) => typeof entry?.path === 'string' && (!packagePrefix || entry.path.startsWith(packagePrefix)))
  if (packageEntries.some((entry) => entry.type !== 'tree' && !safeBlob(entry))) {
    throw new EvaluationError('Artifact packages may contain only regular files.', 422)
  }
  const blobs = packageEntries.filter(safeBlob)
  if (blobs.length > MAX_ARTIFACT_PACKAGE_FILES) {
    throw new EvaluationError(`Artifact packages may contain at most ${MAX_ARTIFACT_PACKAGE_FILES} files.`, 413)
  }
  const declaredBytes = blobs.reduce((total, entry) => total + (Number.isFinite(entry.size) ? entry.size : 0), 0)
  if (declaredBytes > MAX_ARTIFACT_PACKAGE_BYTES) throw new EvaluationError('Artifact package exceeds the 10 MB limit.', 413)
  const definitionSize = blobs.find((entry) => entry.path === selected.sourcePath)?.size
  if (Number.isFinite(definitionSize) && definitionSize > MAX_SKILL_BYTES) {
    throw new EvaluationError('The selected SKILL.md exceeds the 256 KB evaluation limit.', 413)
  }
  const files = []
  let downloadedBytes = 0
  for (const entry of blobs) {
    const definitionEntry = entry.path === selected.sourcePath
    const remainingBytes = MAX_ARTIFACT_PACKAGE_BYTES - downloadedBytes
    const contents = await remoteRequest(rawUrl(entry.path), {
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'SkillOps-local-evaluator' },
    }, fetchImpl, 20_000, async (response) => {
      if (!response.ok) throw new EvaluationError(`GitHub returned ${response.status} while reading the candidate Skill package.`, response.status === 404 ? 404 : 502)
      return boundedResponseBytes(
        response,
        definitionEntry ? Math.min(MAX_SKILL_BYTES, remainingBytes) : remainingBytes,
        definitionEntry ? 'The selected SKILL.md exceeds the 256 KB evaluation limit.' : 'Artifact package exceeds the 10 MB limit.',
      )
    })
    downloadedBytes += contents.byteLength
    files.push({
      relativePath: packagePrefix ? entry.path.slice(packagePrefix.length) : entry.path,
      mode: entry.mode === '100755' ? 0o755 : 0o644,
      contents,
    })
  }
  const packageFiles = normalizeArtifactPackage(files)
  const definitionFile = packageFiles.find((file) => file.relativePath === (packagePrefix ? selected.sourcePath.slice(packagePrefix.length) : selected.sourcePath))
  if (!definitionFile) throw new EvaluationError('The selected SKILL.md is missing from its immutable package.', 404)
  const contents = new TextDecoder().decode(definitionFile.contents)
  const skillLabel = (sourcePath) => {
    const directory = path.posix.dirname(sourcePath)
    return directory === '.' ? coordinates.repo : path.posix.basename(directory)
  }
  const immutableSourceUrl = `${coordinates.repository}/blob/${commit}/${selected.sourcePath.split('/').map(encodeURIComponent).join('/')}`
  const definition = parseSkillDefinition(contents, skillLabel(selected.sourcePath), {
    sourceUrl: immutableSourceUrl,
    sourcePath: selected.sourcePath,
    sha: selected.sha,
    gitCommit: commit,
    repository: coordinates.repository,
    packageFiles,
    packageFileCount: packageFiles.length,
    contentHash: artifactPackageHash(packageFiles),
  })
  return {
    definition,
    candidates: refs.map((item) => ({
      sourcePath: item.sourcePath,
      sha: item.sha,
      label: skillLabel(item.sourcePath),
    })),
  }
}

export const githubCandidateSourceAdapter = Object.freeze({
  id: 'github',
  kind: 'skill',
  discover(request, options = {}) {
    return discoverGithubSkill(request.sourceUrl, request.candidatePath, options)
  },
})

export async function discoverCandidateArtifact(request, options = {}) {
  const adapter = options.candidateSourceAdapter || githubCandidateSourceAdapter
  if (!adapter || typeof adapter.discover !== 'function') throw new EvaluationError('The candidate source adapter is unavailable.', 422)
  const result = await adapter.discover(request, options)
  if (!result?.definition?.artifact) throw new EvaluationError('The candidate source did not return an Artifact definition.', 502)
  return result
}

function wordTokens(text) {
  const normalized = String(text || '').toLowerCase()
  const tokens = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}._-]{1,}/gu) || []
  const result = new Set(tokens.filter((token) => token.length > 2 && !stopWords.has(token)))
  for (const sequence of normalized.match(/[\p{Script=Han}]{2,}/gu) || []) {
    for (let index = 0; index < sequence.length - 1; index += 1) result.add(sequence.slice(index, index + 2))
  }
  return result
}

function ngrams(text) {
  const normalized = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  if (!normalized) return new Set()
  if (normalized.length < 3) return new Set([normalized])
  return new Set(Array.from({ length: normalized.length - 2 }, (_, index) => normalized.slice(index, index + 3)))
}

function diceCoefficient(left, right) {
  if (!left.size && !right.size) return 0
  let intersection = 0
  for (const item of left) if (right.has(item)) intersection += 1
  return (2 * intersection) / (left.size + right.size)
}

function sharedTerms(left, right) {
  return [...left].filter((token) => right.has(token) && token.length > 2).sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 6)
}

export function compareSkillDefinitions(candidate, baseline) {
  const candidateDescription = wordTokens(candidate.description || '')
  const baselineDescription = wordTokens(baseline.description || '')
  const candidateBody = wordTokens(`${candidate.description || ''}\n${candidate.headings?.join('\n') || ''}\n${stripFrontmatter(candidate.contents || '')}`)
  const baselineBody = wordTokens(`${baseline.description || ''}\n${baseline.headings?.join('\n') || ''}\n${stripFrontmatter(baseline.contents || '')}`)
  const nameScore = diceCoefficient(ngrams(candidate.skillId), ngrams(baseline.skillId))
  const descriptionScore = diceCoefficient(candidateDescription, baselineDescription)
  const bodyScore = diceCoefficient(candidateBody, baselineBody)
  const exactNameBoost = candidate.skillId.toLowerCase() === baseline.skillId.toLowerCase() ? 0.18 : 0
  const similarity = Math.min(100, Math.round((nameScore * 0.38 + descriptionScore * 0.27 + bodyScore * 0.35 + exactNameBoost) * 100))
  return {
    similarity,
    relationship: similarity >= 65 ? 'Likely update' : similarity >= 25 ? 'Overlapping purpose' : 'Distinct purpose',
    sharedSignals: sharedTerms(candidateBody, baselineBody),
  }
}

export async function installedDefinitions(options = {}) {
  const scan = options.scanInstalledSkills || scanInstalledSkills
  const read = options.readFile || readFile
  const skills = (await scan()).filter((skill) => skill.kind === 'skill' && skill.enabled !== false)
  return (await Promise.all(skills.map(async (skill) => {
    try {
      const contents = await read(skill.sourcePath, 'utf8')
      return parseSkillDefinition(contents, skill.skillId, skill)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.status === 413) return null
      throw error
    }
  }))).filter(Boolean)
}

export async function installedArtifactDefinitions(options = {}) {
  const scan = options.scanInstalledSkills || scanInstalledSkills
  const read = options.readFile || readFile
  const artifacts = (await scan()).filter((item) => ['skill', 'command', 'rules', 'agent'].includes(item.kind) && item.enabled !== false)
  return (await Promise.all(artifacts.map(async (item) => {
    try {
      if (item.kind === 'skill') return parseSkillDefinition(await read(item.sourcePath, 'utf8'), item.skillId, item)
      const contents = normalizeArtifactContent(await read(item.sourcePath, 'utf8'))
      if (!contents.trim()) return null
      if (Buffer.byteLength(contents, 'utf8') > MAX_SKILL_BYTES) throw new EvaluationError('The selected runtime Artifact exceeds the 256 KB evaluation limit.', 413)
      const definition = { ...item, contents, headings: headingList(contents), contentHash: artifactContentHash(contents) }
      definition.artifact = createRuntimeArtifactDefinition(definition)
      return definition
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.status === 413) return null
      throw error
    }
  }))).filter(Boolean)
}

function publicCandidate(definition) {
  return {
    skillId: definition.skillId,
    skillVersion: definition.skillVersion,
    description: definition.description,
    headings: definition.headings,
    sourceUrl: definition.sourceUrl,
    sourcePath: definition.sourcePath,
    sha: definition.sha,
    contentHash: definition.contentHash,
  }
}

function publicMatch(definition, comparison) {
  return {
    skillId: definition.skillId,
    skillVersion: definition.skillVersion,
    description: definition.description,
    runtime: definition.runtime,
    source: definition.source,
    sourcePath: definition.sourcePath,
    provider: definition.provider,
    ...comparison,
  }
}

export async function analyzeCandidateSkill(body, options = {}) {
  if (!body || typeof body !== 'object') throw new EvaluationError('A JSON request body is required.')
  const [remote, installed] = await Promise.all([
    discoverCandidateArtifact({ sourceUrl: body.sourceUrl, candidatePath: optionalString(body.candidatePath) }, options),
    installedDefinitions(options),
  ])
  const matches = installed
    .map((definition) => publicMatch(definition, compareSkillDefinitions(remote.definition, definition)))
    .sort((left, right) => right.similarity - left.similarity || left.skillId.localeCompare(right.skillId))
    .slice(0, 6)
  const best = matches[0]
  return {
    candidate: publicCandidate(remote.definition),
    candidates: remote.candidates,
    matches,
    recommendation: !best
      ? 'No enabled local Skills were available for comparison.'
      : best.similarity >= 65
        ? `Treat ${best.skillId} as the baseline and run an A/B evaluation before replacing it.`
        : best.similarity >= 25
          ? `Review ${best.skillId} as a possible overlap, then use an A/B task to test the boundary.`
          : 'This candidate appears distinct from the enabled local inventory.',
  }
}
