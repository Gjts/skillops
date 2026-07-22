import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { EvaluationError } from './evaluations/errors.mjs'
import { computeEvaluationEvidenceHash } from './evaluations/evaluation-store.mjs'
import { withGovernanceFileLock } from './governance/skeleton-lock.mjs'

const execute = promisify(execFile)
const LOCK_PATH = '.skillops/team-template.lock.json'
const MODES = new Set(['greenfield', 'adopt-existing', 'migration'])
const HASH = /^[a-f0-9]{64}$/
const REVISION = /^[a-f0-9]{40,64}$/
const MAX_FILES = 500
const MAX_FILE_BYTES = 1_048_576
const VERIFIED_MANIFEST = Symbol('verifiedTeamTemplateManifest')

function text(value, label, maximum = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new EvaluationError(`${label} is invalid.`, 422)
  }
  return value.trim()
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hash(value, label) {
  const normalized = text(value, label, 64).toLowerCase()
  if (!HASH.test(normalized)) throw new EvaluationError(`${label} must be a SHA-256 hash.`, 422)
  return normalized
}

function relativePath(value, label = 'Template file path') {
  const file = text(value, label, 500)
  if (file.includes('\\') || path.posix.isAbsolute(file) || path.posix.normalize(file) !== file || file === '.' || file.split('/').some((part) => !part || part === '..')) {
    throw new EvaluationError(`${label} must be a normalized relative POSIX path.`, 422)
  }
  if (file === LOCK_PATH) throw new EvaluationError(`${label} is reserved by SkillOps.`, 422)
  return file
}

function normalizeFile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError('Template file is invalid.', 422)
  const file = relativePath(value.path)
  if (typeof value.content !== 'string' || Buffer.byteLength(value.content, 'utf8') > MAX_FILE_BYTES) {
    throw new EvaluationError(`Template file ${file} must contain at most 1 MiB of UTF-8 text.`, 422)
  }
  const mode = value.mode === undefined ? 0o644 : Number(value.mode)
  if (![0o644, 0o755].includes(mode)) throw new EvaluationError(`Template file ${file} mode must be 0644 or 0755.`, 422)
  return { path: file, content: value.content, sourceRef: text(value.sourceRef, `Template file ${file} source`, 2_000), contentHash: digest(Buffer.from(value.content, 'utf8')), mode }
}

function normalizeAsset(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError('Template asset is invalid.', 422)
  return {
    kind: text(value.kind, 'Template asset kind', 50),
    id: text(value.id, 'Template asset ID', 200),
    version: text(value.version, 'Template asset version', 100),
    sourceRef: text(value.sourceRef, 'Template asset source', 2_000),
    contentHash: hash(value.contentHash, 'Template asset content hash'),
    evidenceHash: hash(value.evidenceHash, 'Template asset evidence hash'),
    approvalId: text(value.approvalId, 'Template asset approval ID', 200),
  }
}

function normalizeSuite(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError('Template evaluation suite is invalid.', 422)
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > MAX_FILES) throw new EvaluationError('Template evaluation suite files are invalid.', 422)
  const files = value.files.map((pattern) => text(pattern, 'Template evaluation file pattern', 500))
  return {
    id: text(value.id, 'Template evaluation suite ID', 200),
    files: [...new Set(files)].sort(),
    baselineRef: typeof value.baselineRef === 'string' ? text(value.baselineRef, 'Template evaluation baseline', 2_000) : undefined,
    candidateRef: text(value.candidateRef, 'Template evaluation candidate', 2_000),
    deterministic: value.deterministic === true,
  }
}

function templatePayload(value) {
  const files = (Array.isArray(value?.files) ? value.files : []).map(normalizeFile).sort((left, right) => left.path.localeCompare(right.path))
  const assets = (Array.isArray(value?.assets) ? value.assets : []).map(normalizeAsset).sort((left, right) => `${left.kind}:${left.id}:${left.version}`.localeCompare(`${right.kind}:${right.id}:${right.version}`))
  const evaluationSuites = (Array.isArray(value?.evaluationSuites) ? value.evaluationSuites : []).map(normalizeSuite).sort((left, right) => left.id.localeCompare(right.id))
  return {
    schemaVersion: value?.schemaVersion,
    id: value?.id,
    version: value?.version,
    source: value?.source,
    files: files.map(({ content: _content, ...file }) => file),
    assets,
    evaluationSuites,
  }
}

export function computeTeamTemplateHash(value) {
  return digest(JSON.stringify(templatePayload(value)))
}

function normalizeManifest(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) throw new EvaluationError('Team Template Manifest schemaVersion must be 1.', 422)
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > MAX_FILES) throw new EvaluationError('Team Template Manifest files are invalid.', 422)
  if (!Array.isArray(value.assets) || !value.assets.length || value.assets.length > MAX_FILES) throw new EvaluationError('Team Template Manifest assets are invalid.', 422)
  if (!Array.isArray(value.evaluationSuites) || !value.evaluationSuites.length) throw new EvaluationError('Team Template Manifest evaluation suites are required.', 422)
  const source = value.source
  if (!source || source.kind !== 'git') throw new EvaluationError('Team Template Manifest source must be Git.', 422)
  const revision = text(source.revision, 'Team Template Git revision', 64).toLowerCase()
  if (!REVISION.test(revision)) throw new EvaluationError('Team Template Git revision must be an immutable commit hash.', 422)
  const normalized = {
    schemaVersion: 1,
    id: text(value.id, 'Team Template ID', 200),
    version: text(value.version, 'Team Template version', 100),
    source: {
      kind: 'git',
      repository: text(source.repository, 'Team Template repository', 2_000),
      revision,
      manifestPath: relativePath(source.manifestPath, 'Team Template manifest path'),
    },
    files: value.files.map(normalizeFile).sort((left, right) => left.path.localeCompare(right.path)),
    assets: value.assets.map(normalizeAsset).sort((left, right) => `${left.kind}:${left.id}:${left.version}`.localeCompare(`${right.kind}:${right.id}:${right.version}`)),
    evaluationSuites: value.evaluationSuites.map(normalizeSuite).sort((left, right) => left.id.localeCompare(right.id)),
  }
  if (new Set(normalized.files.map((file) => file.path)).size !== normalized.files.length) throw new EvaluationError('Team Template Manifest contains duplicate file paths.', 422)
  if (new Set(normalized.assets.map((asset) => `${asset.kind}:${asset.id}:${asset.version}`)).size !== normalized.assets.length) throw new EvaluationError('Team Template Manifest contains duplicate asset versions.', 422)
  if (new Set(normalized.evaluationSuites.map((suite) => suite.id)).size !== normalized.evaluationSuites.length) throw new EvaluationError('Team Template Manifest contains duplicate evaluation suites.', 422)
  for (const file of normalized.files) {
    if (file.sourceRef !== `git:${revision}:${file.path}`) throw new EvaluationError(`Template file ${file.path} source does not match the immutable Git revision.`, 422)
  }
  for (const asset of normalized.assets) {
    const prefix = `git:${revision}:`
    if (!asset.sourceRef.startsWith(prefix) || asset.sourceRef !== `${prefix}${relativePath(asset.sourceRef.slice(prefix.length), `Template asset ${asset.id} source path`)}`) {
      throw new EvaluationError(`Template asset ${asset.id} source does not match the immutable Git revision.`, 422)
    }
  }
  const templateHash = computeTeamTemplateHash(normalized)
  const release = value.release
  if (!release || release.channel !== 'stable') throw new EvaluationError('Only a Stable Team Template may be applied.', 409)
  if (!release.evidence || release.evidence.gateResult !== 'passed') throw new EvaluationError('Stable Team Template evaluation evidence is missing or failed.', 409)
  const evidenceHash = hash(release.evidence.evidenceHash, 'Team Template evidence hash')
  const evidenceSuiteId = text(release.evidence.suiteId, 'Team Template evidence suite ID', 200)
  if (!normalized.evaluationSuites.some((suite) => suite.id === evidenceSuiteId)) throw new EvaluationError('Stable Team Template release evidence suite is not in the manifest.', 409)
  if (hash(release.evidence.templateHash, 'Team Template evidence template hash') !== templateHash) throw new EvaluationError('Team Template evidence hash does not match its content hash.', 409)
  const releaseEvidence = { runId: text(release.evidence.runId, 'Team Template evidence run ID', 200), suiteId: evidenceSuiteId, gateResult: 'passed', evidenceHash, templateHash }
  if (options.approvalRequired === false) {
    return { ...normalized, templateHash, release: { channel: 'stable', evidence: releaseEvidence, approval: null } }
  }
  const approval = release.approval
  if (!approval || approval.decision !== 'approved') throw new EvaluationError('Stable Team Template approval is missing.', 409)
  const submitterId = text(approval.submitterId, 'Team Template submitter', 200)
  const reviewerId = text(approval.reviewerId, 'Team Template reviewer', 200)
  if (submitterId === reviewerId) throw new EvaluationError('Stable Team Template submitter and reviewer must be separate.', 409)
  if (hash(approval.evidenceHash, 'Team Template approval evidence hash') !== evidenceHash || hash(approval.templateHash, 'Team Template approval content hash') !== templateHash) {
    throw new EvaluationError('Team Template approval is stale for this exact content and evidence hash.', 409)
  }
  return {
    ...normalized,
    templateHash,
    release: {
      channel: 'stable',
      evidence: releaseEvidence,
      approval: { id: text(approval.id, 'Team Template approval ID', 200), submitterId, reviewerId, decision: 'approved', evidenceHash, templateHash },
    },
  }
}

export async function readTeamTemplateDraft(file) {
  const manifestFile = path.resolve(text(file, 'Team Template Manifest path', 2_000))
  let parsed
  try {
    const info = await stat(manifestFile)
    if (!info.isFile() || info.size > 16 * MAX_FILE_BYTES) throw new EvaluationError('Team Template Manifest must be a regular JSON file no larger than 16 MiB.', 422)
    parsed = JSON.parse(await readFile(manifestFile, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') throw new EvaluationError('Team Template Manifest was not found.', 404)
    if (error instanceof SyntaxError) throw new EvaluationError('Team Template Manifest must contain valid JSON.', 422)
    throw error
  }
  return parsed
}

function canonicalRepository(value) {
  return String(value).trim().replace(/\.git\/?$/i, '').replace(/\/$/, '')
}

async function verifyTeamTemplateProvenance(manifestFile, manifest) {
  try {
    const manifestRealPath = await realpath(manifestFile)
    const gitRoot = await realpath(path.resolve((await defaultGit(path.dirname(manifestRealPath), ['rev-parse', '--show-toplevel'])).trim()))
    const manifestPath = path.relative(gitRoot, manifestRealPath).replace(/\\/g, '/')
    if (relativePath(manifestPath, 'Team Template manifest path') !== manifest.source.manifestPath) {
      throw new EvaluationError('Team Template manifest path does not match its Git source.', 409)
    }
    const [head, repository, committedBlob, workingBlob] = await Promise.all([
      defaultGit(gitRoot, ['rev-parse', 'HEAD']),
      defaultGit(gitRoot, ['config', '--get', 'remote.origin.url']),
      defaultGit(gitRoot, ['rev-parse', `HEAD:${manifestPath}`]),
      defaultGit(gitRoot, ['hash-object', '--path', manifestPath, manifestRealPath]),
    ])
    if (canonicalRepository(repository) !== canonicalRepository(manifest.source.repository)) {
      throw new EvaluationError('Team Template repository does not match the configured Git origin.', 409)
    }
    if (committedBlob.trim() !== workingBlob.trim()) throw new EvaluationError('Team Template manifest has uncommitted changes.', 409)
    await defaultGit(gitRoot, ['merge-base', '--is-ancestor', manifest.source.revision, head.trim()])
    for (const file of manifest.files) {
      const contents = await defaultGitBuffer(gitRoot, ['show', `${manifest.source.revision}:${file.path}`])
      if (digest(contents) !== file.contentHash) throw new EvaluationError(`Template file ${file.path} does not match its claimed Git commit.`, 409)
    }
    const prefix = `git:${manifest.source.revision}:`
    for (const asset of manifest.assets) {
      const sourcePath = asset.sourceRef.slice(prefix.length)
      const contents = await defaultGitBuffer(gitRoot, ['show', `${manifest.source.revision}:${sourcePath}`])
      if (digest(contents) !== asset.contentHash) throw new EvaluationError(`Template asset ${asset.id} does not match its claimed Git commit.`, 409)
    }
    return { manifestCommit: head.trim(), manifestDigest: digest(JSON.stringify(manifest)) }
  } catch (error) {
    if (error instanceof EvaluationError) throw error
    throw new EvaluationError('Team Template Git provenance could not be verified.', 409)
  }
}

export async function loadTeamTemplate(file) {
  const manifestFile = path.resolve(text(file, 'Team Template Manifest path', 2_000))
  const manifest = normalizeManifest(await readTeamTemplateDraft(manifestFile))
  const provenance = await verifyTeamTemplateProvenance(manifestFile, manifest)
  Object.defineProperty(manifest, VERIFIED_MANIFEST, { value: provenance })
  return manifest
}

export async function loadTeamTemplateNomination(file) {
  const manifestFile = path.resolve(text(file, 'Team Template Manifest path', 2_000))
  const manifest = normalizeManifest(await readTeamTemplateDraft(manifestFile), { approvalRequired: false })
  const provenance = await verifyTeamTemplateProvenance(manifestFile, manifest)
  Object.defineProperty(manifest, VERIFIED_MANIFEST, { value: provenance })
  return manifest
}

function trustedAssurance(value) {
  return typeof value === 'string' && value.length > 0 && value !== 'unverified-legacy'
}

function sameArtifactIdentity(left, right, revision) {
  return left?.kind === right.kind
    && left?.artifactId === right.id
    && left?.version === right.version
    && left?.contentHash === right.contentHash
    && left?.gitCommit === revision
}

async function verifyTemplateEvaluation(manifest, runId, suiteId, evidenceHash, services) {
  const run = await services.evaluationStore?.getRun?.(runId)
  if (!run) throw new EvaluationError(`Team Template evaluation run ${runId} was not found.`, 409)
  if (run.subjectHash !== manifest.templateHash) throw new EvaluationError('Team Template evaluation subject does not match the exact template content.', 409)
  if (run.suiteId !== suiteId || run.status !== 'completed' || run.gateResult !== 'passed') {
    throw new EvaluationError('Team Template evaluation run did not pass the declared Suite.', 409)
  }
  if (!HASH.test(String(run.policyHash || '')) || run.evidenceHash !== evidenceHash || run.evidenceHash !== computeEvaluationEvidenceHash({ ...run, evidenceHash: null })) {
    throw new EvaluationError('Team Template evaluation evidence is missing, stale, or invalid.', 409)
  }
  const suite = manifest.evaluationSuites.find((item) => item.id === suiteId)
  if (!suite || run.candidate?.sourceRef !== suite.candidateRef) {
    throw new EvaluationError(`Team Template Suite ${suiteId} did not evaluate its declared candidate reference.`, 409)
  }
  const scopedAsset = manifest.assets.find((asset) => sameArtifactIdentity(run.candidate, asset, manifest.source.revision)
    && canonicalRepository(run.candidate.repository) === canonicalRepository(manifest.source.repository))
  if (!scopedAsset) throw new EvaluationError(`Team Template Suite ${suiteId} did not evaluate its declared candidate asset.`, 409)
  if (suite.baselineRef && run.baseline?.sourceRef !== suite.baselineRef) {
    throw new EvaluationError(`Team Template Suite ${suiteId} did not evaluate its declared baseline reference.`, 409)
  }
  return run
}

export async function verifyTeamTemplateNomination(value, services = {}) {
  const manifest = normalizeManifest(value, { approvalRequired: false })
  if (!services.evaluationStore?.getRun || !services.capabilityRegistry?.list || !services.auditLog?.list) {
    throw new EvaluationError('Team Template governance stores are required before use.', 409)
  }
  const run = await verifyTemplateEvaluation(
    manifest,
    manifest.release.evidence.runId,
    manifest.release.evidence.suiteId,
    manifest.release.evidence.evidenceHash,
    services,
  )
  const [capabilities, audits] = await Promise.all([
    services.capabilityRegistry.list(),
    services.auditLog.list({ limit: 1_000 }),
  ])
  for (const asset of manifest.assets) {
    const capability = capabilities.find((item) => item.stage === 'stable'
      && sameArtifactIdentity(item.artifact, asset, manifest.source.revision)
      && canonicalRepository(item.artifact.repository) === canonicalRepository(manifest.source.repository)
      && item.evidence?.candidateHash === asset.contentHash
      && item.evidence?.evidenceHash === asset.evidenceHash
      && trustedAssurance(item.ownerIdentityAssurance)
      && item.approvals?.some((approval) => approval.decision === 'approved'
        && approval.evidenceHash === asset.evidenceHash
        && trustedAssurance(approval.identityAssurance)))
    if (!capability) throw new EvaluationError(`Template asset ${asset.id} is not an exact approved Stable capability.`, 409)
    const approval = audits.find((entry) => entry.id === asset.approvalId
      && entry.outcome === 'committed'
      && entry.action === 'approval.decided'
      && entry.capabilityId === capability.id
      && entry.toStage === 'approved'
      && entry.evidenceHash === asset.evidenceHash
      && sameArtifactIdentity(entry.artifact, asset, manifest.source.revision))
    if (!approval) throw new EvaluationError(`Template asset ${asset.id} approval record was not found.`, 409)
  }
  return { verified: true, manifest, run }
}

export async function verifyTeamTemplateGovernance(value, services = {}) {
  if (!services.templateApprovals?.get) throw new EvaluationError('Team Template approval store is required before use.', 409)
  const manifest = normalizeManifest(value)
  const verified = await verifyTeamTemplateNomination(manifest, services)
  const expected = manifest.release.approval
  const approval = await services.templateApprovals.get(expected.id)
  if (!approval
    || approval.status !== 'approved'
    || approval.templateId !== manifest.id
    || approval.version !== manifest.version
    || approval.templateHash !== manifest.templateHash
    || approval.runId !== manifest.release.evidence.runId
    || approval.suiteId !== manifest.release.evidence.suiteId
    || approval.evidenceHash !== manifest.release.evidence.evidenceHash
    || approval.submitterId !== expected.submitterId
    || approval.reviewerId !== expected.reviewerId
    || !trustedAssurance(approval.submitterAssurance)
    || !trustedAssurance(approval.reviewerAssurance)) {
    throw new EvaluationError('Stable Team Template approval does not resolve to an exact trusted approval record.', 409)
  }
  return { ...verified, manifest, approval }
}

function lineCount(contents) {
  return contents.length ? contents.replace(/\r\n?/g, '\n').split('\n').length : 0
}

function diffSummary(before, after) {
  const left = before.replace(/\r\n?/g, '\n').split('\n')
  const right = after.replace(/\r\n?/g, '\n').split('\n')
  const length = Math.max(left.length, right.length)
  let changedLines = 0
  for (let index = 0; index < length; index += 1) if (left[index] !== right[index]) changedLines += 1
  return { beforeLines: lineCount(before), afterLines: lineCount(after), changedLines }
}

function inside(root, target) {
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new EvaluationError('Template target escapes the project root.', 422)
}

async function ensureRoot(targetRoot) {
  await mkdir(targetRoot, { recursive: true })
  const root = await realpath(targetRoot)
  if (!(await stat(root)).isDirectory()) throw new EvaluationError('Template target root is unavailable.', 409)
  return root
}

async function safePath(root, relative, createParents = false) {
  const file = relative === LOCK_PATH ? LOCK_PATH : relativePath(relative)
  const parts = file.split('/')
  let current = root
  for (let index = 0; index < parts.length - 1; index += 1) {
    const next = path.join(current, parts[index])
    let info = await lstat(next).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (!info && createParents) {
      await mkdir(next).catch((error) => { if (error?.code !== 'EEXIST') throw error })
      info = await lstat(next)
    }
    if (!info) return path.join(current, ...parts.slice(index))
    if (!info.isDirectory() || info.isSymbolicLink()) throw new EvaluationError(`Template target parent for ${file} is unsafe.`, 409)
    current = await realpath(next)
    inside(root, current)
  }
  const target = path.join(current, parts.at(-1))
  inside(root, target)
  const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new EvaluationError(`Template target ${file} is not a regular file.`, 409)
  return target
}

async function inspectFile(root, relative) {
  const target = await safePath(root, relative)
  const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (!info) return { exists: false, target, contents: Buffer.alloc(0), contentHash: null, mode: null }
  if (!info.isFile() || info.isSymbolicLink()) throw new EvaluationError(`Template target ${relative} is not a regular file.`, 409)
  const contents = await readFile(target)
  return { exists: true, target, contents, contentHash: digest(contents), mode: info.mode & 0o777 }
}

function modeMatches(actual, expected) {
  return process.platform === 'win32' || actual === expected
}

function normalizeLock(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || !value.template || !Array.isArray(value.files)) throw new EvaluationError('Project Team Template lock is invalid.', 409)
  return {
    ...value,
    template: { ...value.template, id: text(value.template.id, 'Locked Team Template ID', 200), version: text(value.template.version, 'Locked Team Template version', 100), templateHash: hash(value.template.templateHash, 'Locked Team Template hash') },
    files: value.files.map((file) => ({ path: relativePath(file.path), contentHash: hash(file.contentHash, `Locked file ${file.path} hash`), sourceRef: text(file.sourceRef, `Locked file ${file.path} source`, 2_000), mode: [0o644, 0o755].includes(Number(file.mode)) ? Number(file.mode) : 0o644 })),
    previousStableCommit: value.previousStableCommit === null || value.previousStableCommit === undefined ? null : text(value.previousStableCommit, 'Previous Stable commit', 64).toLowerCase(),
  }
}

async function readLock(root) {
  const lock = await inspectFile(root, LOCK_PATH)
  if (!lock.exists) return null
  try {
    return normalizeLock(JSON.parse(lock.contents.toString('utf8')))
  } catch (error) {
    if (error instanceof SyntaxError) throw new EvaluationError('Project Team Template lock must contain valid JSON.', 409)
    throw error
  }
}

export async function inspectProjectTemplateAdoption(targetRoot, candidate = null) {
  const projectRoot = await realpath(path.resolve(targetRoot)).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (!projectRoot || !(await stat(projectRoot)).isDirectory()) {
    return { state: 'unmanaged', adoptionRate: 0, currentVersion: null, candidateVersion: candidate?.version || null, drift: [], pendingUpgrade: false }
  }
  const lock = await readLock(projectRoot)
  if (!lock) return { state: 'unmanaged', adoptionRate: 0, currentVersion: null, candidateVersion: candidate?.version || null, drift: [], pendingUpgrade: false }
  const drift = []
  for (const file of lock.files) {
    const current = await inspectFile(projectRoot, file.path)
    if (!current.exists || current.contentHash !== file.contentHash || !modeMatches(current.mode, file.mode)) {
      drift.push({ path: file.path, expectedHash: file.contentHash, currentHash: current.contentHash, expectedMode: file.mode, currentMode: current.mode })
    }
  }
  const pendingUpgrade = Boolean(candidate && (candidate.id !== lock.template.id || candidate.version !== lock.template.version))
  return {
    state: drift.length ? 'drifted' : pendingUpgrade ? 'upgrade-available' : 'current',
    adoptionRate: 1,
    templateId: lock.template.id,
    currentVersion: lock.template.version,
    candidateVersion: candidate?.version || lock.template.version,
    drift,
    pendingUpgrade,
  }
}

function matchesSuite(suite, changedFiles) {
  return changedFiles.some((file) => suite.files.some((pattern) => path.matchesGlob(file, pattern)))
}

function planChange(file, action, current) {
  const before = current.contents.toString('utf8')
  const after = file?.content || ''
  return {
    path: file?.path || current.path,
    action,
    currentHash: current.contentHash,
    candidateHash: file?.contentHash || null,
    currentMode: current.mode,
    candidateMode: file?.mode ?? null,
    sourceRef: file?.sourceRef || null,
    diff: diffSummary(before, after),
  }
}

async function defaultGit(root, args) {
  const result = await execute('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  return result.stdout
}

async function defaultGitBuffer(root, args) {
  const result = await execute('git', ['-C', root, ...args], { encoding: 'buffer', windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  return result.stdout
}

export function createProjectTemplateManager(options = {}) {
  const manifest = normalizeManifest(options.manifest)
  const provenance = options.manifest?.[VERIFIED_MANIFEST]
  if (!options.allowUnverifiedManifest && (!provenance || provenance.manifestDigest !== digest(JSON.stringify(manifest)))) {
    throw new EvaluationError('Team Template Git provenance must be verified before use.', 409)
  }
  const targetRoot = path.resolve(options.targetRoot || process.cwd())
  const evaluateSuite = typeof options.evaluateSuite === 'function'
    ? options.evaluateSuite
    : async () => { throw new EvaluationError('A project-template evaluation runner is required.', 409) }
  const now = options.now || (() => new Date())
  const git = options.runGit || ((args) => defaultGit(targetRoot, args))
  const governance = options.governance

  const removeBackup = options.removeBackup || ((file) => rm(file, { force: true }))
  async function root() {
    return ensureRoot(targetRoot)
  }

  async function withProjectLock(projectRoot, operation) {
    let lockFile
    try {
      const gitPath = (await git(['rev-parse', '--git-path', 'skillops-team-template.lock'])).trim()
      lockFile = path.resolve(projectRoot, gitPath)
    } catch {
      lockFile = path.join(projectRoot, '.skillops', 'team-template.transaction.lock')
    }
    return withGovernanceFileLock(lockFile, operation, 60_000)
  }

  async function gitState(projectRoot) {
    try {
      const gitRoot = path.resolve((await git(['rev-parse', '--show-toplevel'])).trim())
      if (path.relative(await realpath(gitRoot), projectRoot)) return { available: false, clean: false, branch: null, defaultBranch: null, isDefaultBranch: false, head: null }
      const [branchOutput, headOutput, changes, defaultBranchOutput] = await Promise.all([
        git(['branch', '--show-current']),
        git(['rev-parse', 'HEAD']).catch(() => null),
        git(['status', '--porcelain=v1', '--untracked-files=all']),
        git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => null),
      ])
      const branch = branchOutput.trim() || null
      const defaultBranch = defaultBranchOutput?.trim().replace(/^origin\//, '') || null
      const head = headOutput?.trim() || null
      const isDefaultBranch = Boolean(branch && defaultBranch && branch === defaultBranch)
      return { available: true, clean: !changes.trim(), branch, defaultBranch, isDefaultBranch, head }
    } catch {
      return { available: false, clean: false, branch: null, defaultBranch: null, isDefaultBranch: false, head: null }
    }
  }

  function makeLock(mode, previousStableCommit, evaluations) {
    return {
      schemaVersion: 1,
      template: { id: manifest.id, version: manifest.version, templateHash: manifest.templateHash, source: { ...manifest.source, manifestCommit: provenance?.manifestCommit || null } },
      mode,
      files: manifest.files.map(({ path: file, contentHash, sourceRef, mode: fileMode }) => ({ path: file, contentHash, sourceRef, mode: fileMode })),
      assets: manifest.assets,
      release: { evidenceHash: manifest.release.evidence.evidenceHash, approvalId: manifest.release.approval.id },
      evaluations: evaluations.map((result) => ({ suiteId: result.suiteId, runId: result.runId || result.id || null, evidenceHash: result.evidenceHash })),
      previousStableCommit,
      appliedAt: now().toISOString(),
    }
  }

  async function inspectManaged(projectRoot, files) {
    const result = new Map()
    for (const file of files) result.set(file.path, await inspectFile(projectRoot, file.path))
    return result
  }

  async function preview(mode = 'greenfield') {
    if (!MODES.has(mode)) throw new EvaluationError('Template mode must be greenfield, adopt-existing, or migration.', 422)
    const projectRoot = await root()
    const [lock, repository] = await Promise.all([readLock(projectRoot), gitState(projectRoot)])
    const conflicts = []
    const changes = []
    if (mode === 'migration' && !lock) conflicts.push({ path: LOCK_PATH, reason: 'template-lock-required' })
    if (mode !== 'migration' && lock) conflicts.push({ path: LOCK_PATH, reason: 'template-already-managed' })
    if (lock && lock.template.id !== manifest.id) conflicts.push({ path: LOCK_PATH, reason: 'different-template' })

    const currentFiles = await inspectManaged(projectRoot, manifest.files)
    if (mode === 'migration' && lock) {
      const previous = new Map(lock.files.map((file) => [file.path, file]))
      for (const oldFile of lock.files) {
        const current = currentFiles.get(oldFile.path) || await inspectFile(projectRoot, oldFile.path)
        current.path = oldFile.path
        if (!current.exists || current.contentHash !== oldFile.contentHash || !modeMatches(current.mode, oldFile.mode)) conflicts.push({ path: oldFile.path, reason: 'managed-file-drift', expectedHash: oldFile.contentHash, currentHash: current.contentHash, expectedMode: oldFile.mode, currentMode: current.mode })
      }
      for (const file of manifest.files) {
        const current = currentFiles.get(file.path)
        current.path = file.path
        const oldFile = previous.get(file.path)
        if (!oldFile && current.exists) conflicts.push({ path: file.path, reason: 'existing-content', currentHash: current.contentHash, candidateHash: file.contentHash })
        else if (!current.exists) changes.push(planChange(file, 'create', current))
        else if (current.contentHash !== file.contentHash || !modeMatches(current.mode, file.mode)) changes.push(planChange(file, 'update', current))
      }
      for (const oldFile of lock.files) {
        if (manifest.files.some((file) => file.path === oldFile.path)) continue
        const current = currentFiles.get(oldFile.path) || await inspectFile(projectRoot, oldFile.path)
        current.path = oldFile.path
        changes.push(planChange(null, 'delete', current))
      }
    } else {
      for (const file of manifest.files) {
        const current = currentFiles.get(file.path)
        current.path = file.path
        if (!current.exists) changes.push(planChange(file, 'create', current))
        else if (current.contentHash !== file.contentHash) conflicts.push({ path: file.path, reason: 'existing-content', currentHash: current.contentHash, candidateHash: file.contentHash })
        else if (!modeMatches(current.mode, file.mode)) changes.push(planChange(file, 'update', current))
      }
    }
    changes.sort((left, right) => left.path.localeCompare(right.path))
    const lockState = await inspectFile(projectRoot, LOCK_PATH)
    changes.push(planChange({ path: LOCK_PATH, content: '', contentHash: null, sourceRef: 'skillops:team-template-lock', mode: 0o644 }, lockState.exists ? 'update' : 'create', lockState))
    const changedFiles = mode === 'migration' ? changes.filter((change) => change.path !== LOCK_PATH).map((change) => change.path) : manifest.files.map((file) => file.path)
    const affectedSuites = manifest.evaluationSuites.filter((suite) => suite.id === manifest.release.evidence.suiteId || matchesSuite(suite, changedFiles)).map((suite) => suite.id)
    const reviewBlocked = mode === 'migration' && (!repository.available || !repository.clean || !repository.branch || !repository.defaultBranch || repository.isDefaultBranch)
    return {
      operation: mode === 'migration' ? 'upgrade' : 'initialize',
      mode,
      template: { id: manifest.id, version: manifest.version, contentHash: manifest.templateHash, source: manifest.source },
      changes,
      conflicts,
      affectedSuites,
      canApply: conflicts.length === 0 && !reviewBlocked,
      review: {
        required: mode === 'migration',
        branch: repository.branch,
        defaultBranch: repository.defaultBranch,
        isDefaultBranch: repository.isDefaultBranch,
        clean: repository.clean,
        head: repository.head,
        command: 'git add --intent-to-add . && git diff HEAD -- . && git reset -- .',
      },
    }
  }

  function planFingerprint(plan) {
    return JSON.stringify({ mode: plan.mode, changes: plan.changes.map(({ path: file, action, currentHash, candidateHash, currentMode, candidateMode }) => ({ path: file, action, currentHash, candidateHash, currentMode, candidateMode })), conflicts: plan.conflicts, review: plan.review })
  }

  async function transaction(projectRoot, mutations) {
    const token = randomUUID()
    const records = []

    async function quarantine(file) {
      const target = `${file}.skillops-conflict-${token}-${randomUUID()}`
      await rename(file, target)
      return target
    }

    async function restore(record) {
      if (record.placed) {
        const current = await lstat(record.target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
        if (current) {
          const currentHash = digest(await readFile(record.target))
          if (currentHash === record.candidateHash) await rm(record.target, { force: true })
          else await quarantine(record.target)
        }
      }
      if (record.backupMoved) {
        const current = await lstat(record.target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
        if (current) await quarantine(record.target)
        await rename(record.backup, record.target)
        record.backupMoved = false
      }
    }

    try {
      for (const mutation of mutations) {
        const current = await inspectFile(projectRoot, mutation.path)
        if (current.contentHash !== mutation.expectedHash || !modeMatches(current.mode, mutation.expectedMode)) throw new EvaluationError(`Template target ${mutation.path} changed after preview.`, 409)
        const target = await safePath(projectRoot, mutation.path, true)
        const record = {
          ...mutation,
          target,
          backup: `${target}.skillops-backup-${token}`,
          temporary: `${target}.skillops-tmp-${token}`,
          hadCurrent: current.exists,
          previousContents: current.contents,
          previousMode: current.mode,
          candidateHash: mutation.content === null ? null : digest(Buffer.from(mutation.content, 'utf8')),
          backupMoved: false,
          placed: false,
        }
        if (mutation.content !== null) await writeFile(record.temporary, mutation.content, { encoding: 'utf8', flag: 'wx', mode: mutation.mode || 0o644 })
        records.push(record)
      }
      if (typeof options.beforeCommit === 'function') await options.beforeCommit()
      for (const record of records) {
        const current = await inspectFile(projectRoot, record.path)
        if (current.contentHash !== record.expectedHash || !modeMatches(current.mode, record.expectedMode)) throw new EvaluationError(`Template target ${record.path} changed after preview.`, 409)
        if (record.hadCurrent) {
          await rename(record.target, record.backup)
          record.backupMoved = true
          const backupInfo = await lstat(record.backup)
          if (digest(await readFile(record.backup)) !== record.expectedHash || !modeMatches(backupInfo.mode & 0o777, record.expectedMode)) {
            await quarantine(record.backup)
            record.backupMoved = false
            const raced = await lstat(record.target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
            if (raced) await quarantine(record.target)
            await writeFile(record.target, record.previousContents, { flag: 'wx', mode: record.previousMode || 0o644 })
            throw new EvaluationError(`Template target ${record.path} changed after preview; concurrent content was preserved beside it.`, 409)
          }
        }
        if (record.content !== null) {
          try {
            await link(record.temporary, record.target)
            record.placed = true
          } catch (error) {
            if (error?.code !== 'EEXIST') throw error
            throw new EvaluationError(`Template target ${record.path} changed after preview.`, 409)
          }
        }
      }
    } catch (error) {
      const recoveryFailures = []
      for (const record of [...records].reverse()) {
        try { await restore(record) } catch (failure) { recoveryFailures.push(failure) }
      }
      if (recoveryFailures.length) throw new EvaluationError('Template transaction recovery was incomplete; target-adjacent recovery files were preserved.', 500)
      throw error
    } finally {
      await Promise.all(records.map((record) => rm(record.temporary, { force: true }).catch(() => undefined)))
    }
    await Promise.allSettled(records.filter((record) => record.backupMoved).map((record) => Promise.resolve().then(() => removeBackup(record.backup))))
  }

  async function apply(mode = 'greenfield') {
    const projectRoot = await root()
    const plan = await preview(mode)
    if (!plan.canApply) {
      if (mode === 'migration' && (!plan.review.branch || !plan.review.defaultBranch || plan.review.isDefaultBranch)) throw new EvaluationError('Template migrations require a resolved default branch and a non-default review branch.', 409)
      if (mode === 'migration' && !plan.review.clean) throw new EvaluationError('Template migrations require a clean Git worktree.', 409)
      throw new EvaluationError('Template initialization has a conflict and will not overwrite existing files.', 409)
    }
    if (!options.allowUnverifiedManifest || governance) await verifyTeamTemplateGovernance(manifest, governance)
    const evaluations = []
    for (const suiteId of plan.affectedSuites) {
      const suite = manifest.evaluationSuites.find((item) => item.id === suiteId)
      const result = await evaluateSuite(suite, { manifest, mode, currentLock: await readLock(projectRoot) })
      if (!result || result.status !== 'completed' || result.gateResult !== 'passed' || !HASH.test(String(result.evidenceHash || ''))) {
        throw new EvaluationError(`Template quality gate failed for ${suiteId}; the previous Stable remains unchanged.`, 409)
      }
      const verifiedResult = governance
        ? await verifyTemplateEvaluation(manifest, result.runId || result.id, suiteId, result.evidenceHash, governance)
        : result
      evaluations.push(verifiedResult)
    }
    return withProjectLock(projectRoot, async () => {
      const verified = await preview(mode)
      if (!verified.canApply || planFingerprint(verified) !== planFingerprint(plan)) throw new EvaluationError('Template project state changed during evaluation; preview again.', 409)
      const previousStableCommit = mode === 'migration' ? plan.review.head : null
      const lock = makeLock(mode, previousStableCommit, evaluations)
      const files = new Map(manifest.files.map((file) => [file.path, file]))
      const mutations = plan.changes.map((change) => {
        if (change.path === LOCK_PATH) return { path: LOCK_PATH, content: `${JSON.stringify(lock, null, 2)}\n`, mode: 0o644, expectedHash: change.currentHash, expectedMode: change.currentMode }
        const file = files.get(change.path)
        return { path: change.path, content: change.action === 'delete' ? null : file.content, mode: file?.mode || 0o644, expectedHash: change.currentHash, expectedMode: change.currentMode }
      })
      await transaction(projectRoot, mutations)
      return { ...plan, applied: true, evaluations, adoption: await status() }
    })
  }

  async function status() {
    const projectRoot = await root()
    const lock = await readLock(projectRoot)
    if (!lock) return { state: 'unmanaged', adoptionRate: 0, currentVersion: null, candidateVersion: manifest.version, drift: [], pendingUpgrade: false }
    const drift = []
    for (const file of lock.files) {
      const current = await inspectFile(projectRoot, file.path)
      if (!current.exists || current.contentHash !== file.contentHash || !modeMatches(current.mode, file.mode)) drift.push({ path: file.path, expectedHash: file.contentHash, currentHash: current.contentHash, expectedMode: file.mode, currentMode: current.mode })
    }
    const pendingUpgrade = lock.template.id !== manifest.id || lock.template.templateHash !== manifest.templateHash
    return {
      state: drift.length ? 'drifted' : pendingUpgrade ? 'upgrade-available' : 'current',
      adoptionRate: 1,
      templateId: lock.template.id,
      currentVersion: lock.template.version,
      candidateVersion: manifest.version,
      drift,
      pendingUpgrade,
    }
  }

  async function showAtCommit(commit, file) {
    try {
      return await git(['show', `${commit}:${file}`])
    } catch {
      throw new EvaluationError(`Previous Stable file ${file} is unavailable from Git.`, 409)
    }
  }

  async function previewRollback() {
    const projectRoot = await root()
    const [currentLock, repository] = await Promise.all([readLock(projectRoot), gitState(projectRoot)])
    if (!currentLock?.previousStableCommit || !REVISION.test(currentLock.previousStableCommit)) throw new EvaluationError('No previous Stable template commit is available for rollback.', 409)
    let previousLock
    try {
      previousLock = normalizeLock(JSON.parse(await showAtCommit(currentLock.previousStableCommit, LOCK_PATH)))
    } catch (error) {
      if (error instanceof SyntaxError) throw new EvaluationError('Previous Stable template lock is invalid.', 409)
      throw error
    }
    const conflicts = []
    for (const file of currentLock.files) {
      const current = await inspectFile(projectRoot, file.path)
      if (!current.exists || current.contentHash !== file.contentHash || !modeMatches(current.mode, file.mode)) conflicts.push({ path: file.path, reason: 'managed-file-drift', expectedHash: file.contentHash, currentHash: current.contentHash, expectedMode: file.mode, currentMode: current.mode })
    }
    const previous = new Map(previousLock.files.map((file) => [file.path, file]))
    const current = new Map(currentLock.files.map((file) => [file.path, file]))
    const changes = []
    for (const file of [...new Set([...previous.keys(), ...current.keys()])].sort()) {
      const currentState = await inspectFile(projectRoot, file)
      currentState.path = file
      if (previous.has(file) && !current.has(file) && currentState.exists) {
        conflicts.push({ path: file, reason: 'unmanaged-file-collision', expectedHash: null, currentHash: currentState.contentHash, expectedMode: null, currentMode: currentState.mode })
      }
      if (!previous.has(file)) changes.push(planChange(null, 'delete', currentState))
      else {
        const oldFile = previous.get(file)
        const content = await showAtCommit(currentLock.previousStableCommit, file)
        if (digest(Buffer.from(content, 'utf8')) !== oldFile.contentHash) throw new EvaluationError(`Previous Stable file ${file} does not match its lock hash.`, 409)
        changes.push(planChange({ ...oldFile, content }, currentState.exists ? 'update' : 'create', currentState))
      }
    }
    const lockState = await inspectFile(projectRoot, LOCK_PATH)
    changes.push(planChange({ path: LOCK_PATH, content: '', contentHash: null, sourceRef: 'skillops:team-template-lock', mode: 0o644 }, 'update', lockState))
    const reviewBlocked = !repository.available || !repository.clean || !repository.branch || !repository.defaultBranch || repository.isDefaultBranch
    return {
      operation: 'rollback',
      fromVersion: currentLock.template.version,
      toVersion: previousLock.template.version,
      commit: currentLock.previousStableCommit,
      changes,
      conflicts,
      canApply: !conflicts.length && !reviewBlocked,
      review: { required: true, branch: repository.branch, defaultBranch: repository.defaultBranch, isDefaultBranch: repository.isDefaultBranch, clean: repository.clean, head: repository.head, command: 'git add --intent-to-add . && git diff HEAD -- . && git reset -- .' },
      previousLock,
    }
  }

  async function rollback() {
    const projectRoot = await root()
    return withProjectLock(projectRoot, async () => {
      const plan = await previewRollback()
      if (!plan.canApply) {
        if (!plan.review.branch || !plan.review.defaultBranch || plan.review.isDefaultBranch) throw new EvaluationError('Template rollback requires a resolved default branch and a non-default review branch.', 409)
        if (!plan.review.clean) throw new EvaluationError('Template rollback requires a clean Git worktree.', 409)
        throw new EvaluationError('Template rollback has managed-file drift and will not overwrite it.', 409)
      }
      const previousFiles = new Map(plan.previousLock.files.map((file) => [file.path, file]))
      const mutations = []
      for (const change of plan.changes) {
        if (change.path === LOCK_PATH) {
          const contents = await showAtCommit(plan.commit, LOCK_PATH)
          mutations.push({ path: LOCK_PATH, content: `${contents.replace(/\n?$/, '\n')}`, mode: 0o644, expectedHash: change.currentHash, expectedMode: change.currentMode })
        } else if (change.action === 'delete') mutations.push({ path: change.path, content: null, mode: 0o644, expectedHash: change.currentHash, expectedMode: change.currentMode })
        else {
          const file = previousFiles.get(change.path)
          mutations.push({ path: change.path, content: await showAtCommit(plan.commit, change.path), mode: file.mode, expectedHash: change.currentHash, expectedMode: change.currentMode })
        }
      }
      await transaction(projectRoot, mutations)
      return {
        rolledBack: true,
        fromVersion: plan.fromVersion,
        toVersion: plan.toVersion,
        review: plan.review,
        adoption: { state: 'current', adoptionRate: 1, templateId: plan.previousLock.template.id, currentVersion: plan.previousLock.template.version, candidateVersion: plan.previousLock.template.version, drift: [], pendingUpgrade: false },
      }
    })
  }

  return { preview, apply, status, previewRollback, rollback }
}
