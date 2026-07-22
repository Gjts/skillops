// @vitest-environment node
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeTeamTemplateHash, createProjectTemplateManager, loadTeamTemplate, verifyTeamTemplateGovernance } from './project-template.mjs'
import { computeEvaluationEvidenceHash } from './evaluations/evaluation-store.mjs'

const execute = promisify(execFile)
const temporaryDirectories = []
const hash = (value) => value.repeat(64)
const contentHash = (value) => createHash('sha256').update(value).digest('hex')

async function git(root, ...args) {
  const result = await execute('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
  return result.stdout.trim()
}

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillops-template-'))
  temporaryDirectories.push(root)
  return root
}

function teamTemplate(version, files, options = {}) {
  const revision = options.revision || hash(version === '1.0.0' ? 'a' : 'b')
  const assetContentHash = options.assetContentHash || hash('c')
  const candidateRef = options.candidateRef || `git:v1:${hash('f')}:${revision}:skills%2Freview%2FSKILL.md:${assetContentHash}`
  const manifest = {
    schemaVersion: 1,
    id: 'team-default',
    version,
    source: { kind: 'git', repository: options.repository || 'https://example.invalid/acme/templates', revision, manifestPath: 'templates/team-default.json' },
    files: Object.entries(files).map(([file, content]) => ({ path: file, content, sourceRef: `git:${revision}:${file}`, ...(options.fileModes?.[file] ? { mode: options.fileModes[file] } : {}) })),
    assets: [{ kind: 'skill', id: 'review', version: '2.0.0', sourceRef: `git:${revision}:skills/review/SKILL.md`, contentHash: assetContentHash, evidenceHash: hash('d'), approvalId: 'approval-review-2' }],
    evaluationSuites: [{ id: 'template-smoke', files: options.suiteFiles || ['**'], candidateRef }],
  }
  const templateHash = computeTeamTemplateHash(manifest)
  return {
    ...manifest,
    release: {
      channel: options.channel || 'stable',
      evidence: { runId: `run-${version}`, suiteId: 'template-smoke', gateResult: options.releaseGate || 'passed', evidenceHash: hash('e'), templateHash },
      approval: { id: `approval-${version}`, submitterId: 'user:author', reviewerId: 'user:reviewer', decision: 'approved', evidenceHash: hash('e'), templateHash },
    },
  }
}

function createUnverifiedManager(options) {
  return createProjectTemplateManager({ ...options, allowUnverifiedManifest: true })
}

const passedEvaluation = vi.fn(async (suite) => ({ id: 'run-project-smoke', suiteId: suite.id, status: 'completed', gateResult: 'passed', evidenceHash: hash('f') }))

afterEach(async () => {
  passedEvaluation.mockClear()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Team project templates', () => {
  it('previews and applies a governed greenfield template without persisting file bodies in its lock', async () => {
    const root = await workspace()
    const manifest = teamTemplate('1.0.0', {
      'AGENTS.md': '# Team rules\n',
      '.github/workflows/quality.yml': 'name: quality\n',
      'prompts.lock.json': '{"schemaVersion":1}\n',
    })
    const manager = createUnverifiedManager({ targetRoot: root, manifest, evaluateSuite: passedEvaluation })

    const preview = await manager.preview('greenfield')
    expect(preview).toMatchObject({ mode: 'greenfield', canApply: true, conflicts: [], template: { id: 'team-default', version: '1.0.0' }, affectedSuites: ['template-smoke'] })
    expect(preview.changes.map(({ path: file, action }) => [file, action])).toEqual([
      ['.github/workflows/quality.yml', 'create'],
      ['AGENTS.md', 'create'],
      ['prompts.lock.json', 'create'],
      ['.skillops/team-template.lock.json', 'create'],
    ])

    const applied = await manager.apply('greenfield')
    expect(applied).toMatchObject({ applied: true, adoption: { state: 'current', adoptionRate: 1, pendingUpgrade: false } })
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('# Team rules\n')
    const lock = await readFile(path.join(root, '.skillops/team-template.lock.json'), 'utf8')
    expect(lock).toContain('git:')
    expect(lock).toContain('run-project-smoke')
    expect(lock).not.toContain('# Team rules')
    expect(passedEvaluation).toHaveBeenCalledTimes(1)
    await expect(manager.status()).resolves.toMatchObject({ state: 'current', adoptionRate: 1, drift: [], pendingUpgrade: false })
  })
  it('always gates an apply with the Stable release Suite', async () => {
    const root = await workspace()
    const manifest = teamTemplate('1.0.0', { 'AGENTS.md': '# Team rules\n' }, { suiteFiles: ['unrelated/**'] })
    await createUnverifiedManager({ targetRoot: root, manifest, evaluateSuite: passedEvaluation }).apply('greenfield')
    expect(passedEvaluation).toHaveBeenCalledWith(expect.objectContaining({ id: 'template-smoke' }), expect.objectContaining({ mode: 'greenfield' }))
  })


  it('adopts identical files but blocks divergent existing content without overwriting it', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'AGENTS.md'), '# Local rules\n', 'utf8')
    const manifest = teamTemplate('1.0.0', { 'AGENTS.md': '# Team rules\n', 'CLAUDE.md': '# Claude rules\n' })
    const manager = createUnverifiedManager({ targetRoot: root, manifest, evaluateSuite: passedEvaluation })

    const preview = await manager.preview('adopt-existing')
    expect(preview.canApply).toBe(false)
    expect(preview.conflicts).toEqual([expect.objectContaining({ path: 'AGENTS.md', reason: 'existing-content' })])
    await expect(manager.apply('adopt-existing')).rejects.toThrow('conflict')
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('# Local rules\n')
    await expect(readFile(path.join(root, 'CLAUDE.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('does not overwrite a file created after preview while the transaction is staging', async () => {
    const root = await workspace()
    const manifest = teamTemplate('1.0.0', { 'AGENTS.md': '# Team rules\n' })
    const manager = createUnverifiedManager({
      targetRoot: root,
      manifest,
      evaluateSuite: passedEvaluation,
      beforeCommit: async () => writeFile(path.join(root, 'AGENTS.md'), '# Concurrent writer\n', 'utf8'),
    })

    await expect(manager.apply('greenfield')).rejects.toThrow('changed after preview')
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('# Concurrent writer\n')
    await expect(readFile(path.join(root, '.skillops/team-template.lock.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes competing template commits across manager instances', async () => {
    const root = await workspace()
    const manifest = teamTemplate('1.0.0', { 'AGENTS.md': '# Team rules\n' })
    let active = 0
    let maximum = 0
    const beforeCommit = async () => {
      maximum = Math.max(maximum, ++active)
      await new Promise((resolve) => setTimeout(resolve, 30))
      active -= 1
    }
    const first = createUnverifiedManager({ targetRoot: root, manifest, evaluateSuite: passedEvaluation, beforeCommit })
    const second = createUnverifiedManager({ targetRoot: root, manifest, evaluateSuite: passedEvaluation, beforeCommit })

    const results = await Promise.allSettled([first.apply('greenfield'), second.apply('greenfield')])
    expect(results.map((item) => item.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(maximum).toBe(1)
  })

  it('does not roll back a committed template when backup cleanup fails', async () => {
    const root = await workspace()
    await git(root, 'init', '-b', 'main')
    await createUnverifiedManager({ targetRoot: root, manifest: teamTemplate('1.0.0', { 'AGENTS.md': '# v1\n' }), evaluateSuite: passedEvaluation }).apply('greenfield')
    await git(root, 'add', '.')
    await git(root, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'stable template v1')
    await git(root, 'branch', '-m', 'trunk')
    await git(root, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD')
    await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    await git(root, 'switch', '-c', 'template-v2')
    const removeBackup = vi.fn(async () => { throw new Error('cleanup failed') })
    const manager = createUnverifiedManager({
      targetRoot: root,
      manifest: teamTemplate('2.0.0', { 'AGENTS.md': '# v2\n' }),
      evaluateSuite: passedEvaluation,
      removeBackup,
    })

    await expect(manager.apply('migration')).resolves.toMatchObject({ applied: true })
    expect(removeBackup).toHaveBeenCalled()
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('# v2\n')
    expect(JSON.parse(await readFile(path.join(root, '.skillops/team-template.lock.json'), 'utf8')).template.version).toBe('2.0.0')
  })

  it.runIf(process.platform !== 'win32')('reports executable-mode drift', async () => {
    const root = await workspace()
    const manifest = teamTemplate('1.0.0', { 'scripts/check.sh': '#!/bin/sh\nexit 0\n' }, { fileModes: { 'scripts/check.sh': 0o755 } })
    const manager = createUnverifiedManager({ targetRoot: root, manifest, evaluateSuite: passedEvaluation })
    await manager.apply('greenfield')
    await chmod(path.join(root, 'scripts', 'check.sh'), 0o644)

    await expect(manager.status()).resolves.toMatchObject({
      state: 'drifted',
      drift: [expect.objectContaining({ path: 'scripts/check.sh', expectedMode: 0o755, currentMode: 0o644 })],
    })
  })


  it('runs affected suites before a branch-only migration and keeps the previous Stable on gate failure', async () => {
    const root = await workspace()
    await git(root, 'init', '-b', 'main')
    const first = createUnverifiedManager({ targetRoot: root, manifest: teamTemplate('1.0.0', { 'AGENTS.md': '# v1\n', 'obsolete.txt': 'old\n' }), evaluateSuite: passedEvaluation })
    await first.apply('greenfield')
    await git(root, 'add', '.')
    await git(root, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'stable template v1')
    const secondManifest = teamTemplate('2.0.0', { 'AGENTS.md': '# v2\n', 'new.txt': 'new\n' })
    const failingEvaluation = vi.fn(async () => ({ suiteId: 'template-smoke', status: 'completed', gateResult: 'failed', evidenceHash: hash('1') }))
    await git(root, 'switch', '-c', 'template-without-default')
    const unknownDefault = createUnverifiedManager({ targetRoot: root, manifest: secondManifest, evaluateSuite: failingEvaluation })
    await expect(unknownDefault.preview('migration')).resolves.toMatchObject({
      canApply: false,
      review: { branch: 'template-without-default', defaultBranch: null, isDefaultBranch: false },
    })
    await expect(unknownDefault.apply('migration')).rejects.toThrow('resolved default branch')
    await git(root, 'switch', 'main')
    await git(root, 'branch', '-D', 'template-without-default')

    await git(root, 'branch', '-m', 'trunk')
    await git(root, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD')
    await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    const onDefault = createUnverifiedManager({ targetRoot: root, manifest: secondManifest, evaluateSuite: failingEvaluation })
    await expect(onDefault.apply('migration')).rejects.toThrow('review branch')

    await git(root, 'switch', '-c', 'template-v2')
    await writeFile(path.join(root, 'unrelated.txt'), 'local work\n')
    await expect(createUnverifiedManager({ targetRoot: root, manifest: secondManifest, evaluateSuite: failingEvaluation }).preview('migration'))
      .resolves.toMatchObject({ canApply: false, review: { clean: false, defaultBranch: 'trunk' } })
    await rm(path.join(root, 'unrelated.txt'))
    const upgrading = createUnverifiedManager({ targetRoot: root, manifest: secondManifest, evaluateSuite: failingEvaluation })
    const preview = await upgrading.preview('migration')
    expect(preview).toMatchObject({ canApply: true, review: { required: true, branch: 'template-v2' } })
    expect(preview.review.command).toBe('git add --intent-to-add . && git diff HEAD -- . && git reset -- .')
    expect(preview.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'AGENTS.md', action: 'update' }),
      expect.objectContaining({ path: 'new.txt', action: 'create' }),
      expect.objectContaining({ path: 'obsolete.txt', action: 'delete' }),
    ]))

    await expect(upgrading.apply('migration')).rejects.toThrow('quality gate')
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('# v1\n')
    expect(await readFile(path.join(root, 'obsolete.txt'), 'utf8')).toBe('old\n')
    expect(await git(root, 'status', '--porcelain')).toBe('')
  })

  it('records pending upgrades and restores the complete previous template version from Git', async () => {
    const root = await workspace()
    await git(root, 'init', '-b', 'main')
    const v1 = teamTemplate('1.0.0', { 'AGENTS.md': '# v1\n', 'obsolete.txt': 'old\n' })
    await createUnverifiedManager({ targetRoot: root, manifest: v1, evaluateSuite: passedEvaluation }).apply('greenfield')
    await git(root, 'add', '.')
    await git(root, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'stable template v1')
    await git(root, 'branch', '-m', 'trunk')
    await git(root, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD')
    await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    await git(root, 'switch', '-c', 'template-v2')

    const v2 = teamTemplate('2.0.0', { 'AGENTS.md': '# v2\n', 'new.txt': 'new\n' })
    const manager = createUnverifiedManager({ targetRoot: root, manifest: v2, evaluateSuite: passedEvaluation })
    await expect(manager.status()).resolves.toMatchObject({ state: 'upgrade-available', adoptionRate: 1, currentVersion: '1.0.0', candidateVersion: '2.0.0', pendingUpgrade: true })
    await manager.apply('migration')
    await git(root, 'add', '.')
    await git(root, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'stable template v2')
    await git(root, 'update-ref', 'refs/remotes/origin/template-v2', 'HEAD')
    await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/template-v2')
    await expect(manager.previewRollback()).resolves.toMatchObject({ canApply: false, review: { defaultBranch: 'template-v2', isDefaultBranch: true } })
    await expect(manager.rollback()).rejects.toThrow('non-default review branch')
    await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')

    const rollbackPreview = await manager.previewRollback()
    expect(rollbackPreview).toMatchObject({ canApply: true, fromVersion: '2.0.0', toVersion: '1.0.0', commit: expect.stringMatching(/^[a-f0-9]{40,64}$/) })
    const rolledBack = await manager.rollback()
    expect(rolledBack).toMatchObject({ rolledBack: true, adoption: { state: 'current', currentVersion: '1.0.0' } })
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('# v1\n')
    expect(await readFile(path.join(root, 'obsolete.txt'), 'utf8')).toBe('old\n')
    await expect(readFile(path.join(root, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('blocks rollback when a previous-only path was recreated by the user', async () => {
    const root = await workspace()
    await git(root, 'init', '-b', 'main')
    await createUnverifiedManager({
      targetRoot: root,
      manifest: teamTemplate('1.0.0', { 'AGENTS.md': '# v1\n', 'obsolete.txt': 'old\n' }),
      evaluateSuite: passedEvaluation,
    }).apply('greenfield')
    await git(root, 'add', '.')
    await git(root, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'stable template v1')
    await git(root, 'branch', '-m', 'trunk')
    await git(root, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD')
    await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    await git(root, 'switch', '-c', 'template-v2')

    const manager = createUnverifiedManager({
      targetRoot: root,
      manifest: teamTemplate('2.0.0', { 'AGENTS.md': '# v2\n' }),
      evaluateSuite: passedEvaluation,
    })
    await manager.apply('migration')
    await writeFile(path.join(root, 'obsolete.txt'), 'user-owned\n', 'utf8')
    await git(root, 'add', '.')
    await git(root, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'template v2 and user file')

    await expect(manager.previewRollback()).resolves.toMatchObject({
      canApply: false,
      conflicts: [expect.objectContaining({ path: 'obsolete.txt', reason: 'unmanaged-file-collision' })],
    })
    await expect(manager.rollback()).rejects.toThrow('will not overwrite')
    expect(await readFile(path.join(root, 'obsolete.txt'), 'utf8')).toBe('user-owned\n')
  })

  it('accepts only committed manifests whose file and asset hashes resolve at the claimed Git revision', async () => {
    const source = await workspace()
    await git(source, 'init', '-b', 'main')
    await git(source, 'config', 'remote.origin.url', 'acme/templates')
    await mkdir(path.join(source, 'skills', 'review'), { recursive: true })
    await writeFile(path.join(source, 'AGENTS.md'), '# governed\n')
    const skillContents = '# Review Skill\n'
    await writeFile(path.join(source, 'skills', 'review', 'SKILL.md'), skillContents)
    await git(source, 'add', '.')
    await git(source, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'template assets')
    const revision = await git(source, 'rev-parse', 'HEAD')
    const manifestFile = path.join(source, 'templates', 'team-default.json')
    await mkdir(path.dirname(manifestFile), { recursive: true })
    const governed = teamTemplate('1.0.0', { 'AGENTS.md': '# governed\n' }, {
      revision,
      repository: 'acme/templates',
      assetContentHash: contentHash(skillContents),
    })
    await writeFile(manifestFile, `${JSON.stringify(governed, null, 2)}\n`)
    await git(source, 'add', '.')
    await git(source, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'governed release')

    const aliasParent = await workspace()
    const aliasRoot = path.join(aliasParent, 'repository-alias')
    await symlink(source, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir')
    const verified = await loadTeamTemplate(path.join(aliasRoot, 'templates', 'team-default.json'))
    expect(() => createProjectTemplateManager({ targetRoot: source, manifest: verified, evaluateSuite: passedEvaluation })).not.toThrow()
    expect(() => createProjectTemplateManager({ targetRoot: source, manifest: governed, evaluateSuite: passedEvaluation })).toThrow('provenance')

    const forged = teamTemplate('1.0.1', { 'AGENTS.md': '# unreviewed replacement\n' }, {
      revision,
      repository: 'acme/templates',
      assetContentHash: contentHash(skillContents),
    })
    await writeFile(manifestFile, `${JSON.stringify(forged, null, 2)}\n`)
    await git(source, 'add', '.')
    await git(source, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'forged release')
    await expect(loadTeamTemplate(manifestFile)).rejects.toThrow('AGENTS.md')
  })

  it('rejects Candidate, stale-evidence, and same-person approvals as non-Stable templates', async () => {
    const root = await workspace()
    const candidate = teamTemplate('1.0.0', { 'AGENTS.md': '# v1\n' }, { channel: 'candidate' })
    expect(() => createUnverifiedManager({ targetRoot: root, manifest: candidate, evaluateSuite: passedEvaluation })).toThrow('Stable')

    const stale = teamTemplate('1.0.0', { 'AGENTS.md': '# v1\n' })
    stale.files[0].content = '# changed\n'
    expect(() => createUnverifiedManager({ targetRoot: root, manifest: stale, evaluateSuite: passedEvaluation })).toThrow('hash')

    const missingReleaseSuite = teamTemplate('1.0.0', { 'AGENTS.md': '# v1\n' })
    missingReleaseSuite.release.evidence.suiteId = 'missing-suite'
    expect(() => createUnverifiedManager({ targetRoot: root, manifest: missingReleaseSuite, evaluateSuite: passedEvaluation })).toThrow('release evidence suite')

    const selfApproved = teamTemplate('1.0.0', { 'AGENTS.md': '# v1\n' })
    selfApproved.release.approval.reviewerId = selfApproved.release.approval.submitterId
    expect(() => createUnverifiedManager({ targetRoot: root, manifest: selfApproved, evaluateSuite: passedEvaluation })).toThrow('separate')
  })
  it('resolves exact stored evaluation and approval records before trusting a Stable template', async () => {
    const manifest = teamTemplate('1.0.0', { 'AGENTS.md': '# governed\n' })
    manifest.assets[0].evidenceHash = hash('5')
    manifest.templateHash = computeTeamTemplateHash(manifest)
    manifest.release.evidence.templateHash = manifest.templateHash
    manifest.release.approval.templateHash = manifest.templateHash
    const suite = manifest.evaluationSuites[0]
    let run = {
      id: manifest.release.evidence.runId,
      mode: 'suite',
      status: 'completed',
      subjectHash: manifest.release.evidence.templateHash,
      suiteId: suite.id,
      suiteVersion: '1.0.0',
      suiteHash: hash('1'),
      datasetHash: null,
      baseline: { kind: 'skill', artifactId: 'baseline', version: '1.0.0', source: 'local-scan', sourceRef: `local-scan:codex:sha256:${hash('2')}`, contentHash: hash('2') },
      candidate: { kind: 'skill', artifactId: 'review', version: '2.0.0', source: 'git', sourceRef: suite.candidateRef, repository: manifest.source.repository, gitCommit: manifest.source.revision, contentHash: manifest.assets[0].contentHash },
      engine: { name: 'promptfoo', version: '0.121.19' },
      provider: { id: 'openai', model: 'gpt-test' },
      metrics: null,
      policyHash: hash('4'),
      gates: [{ id: 'pass-rate', status: 'passed', blocking: true }],
      evidenceHash: null,
      gateResult: 'passed',
      requestedBy: 'user:author',
      requestedAt: '2026-07-21T00:00:00.000Z',
      startedAt: '2026-07-21T00:00:01.000Z',
      completedAt: '2026-07-21T00:00:02.000Z',
      errorCode: null,
    }
    run.evidenceHash = computeEvaluationEvidenceHash(run)
    manifest.release.evidence.evidenceHash = run.evidenceHash
    manifest.release.approval.evidenceHash = run.evidenceHash
    const capability = {
      id: 'cap-review',
      stage: 'stable',
      ownerIdentityAssurance: 'local-os-account',
      artifact: { kind: 'skill', artifactId: 'review', version: '2.0.0', source: 'git', sourceRef: 'git:v1:source', repository: manifest.source.repository, gitCommit: manifest.source.revision, contentHash: manifest.assets[0].contentHash },
      evidence: { candidateHash: manifest.assets[0].contentHash, evidenceHash: manifest.assets[0].evidenceHash },
      approvals: [{ decision: 'approved', evidenceHash: manifest.assets[0].evidenceHash, identityAssurance: 'local-os-account' }],
    }
    const governance = {
      evaluationStore: { getRun: vi.fn(async () => run) },
      capabilityRegistry: { list: vi.fn(async () => [capability]) },
      auditLog: { list: vi.fn(async () => [{
        id: manifest.assets[0].approvalId,
        outcome: 'committed',
        action: 'approval.decided',
        actor: 'user:asset-reviewer',
        capabilityId: capability.id,
        evidenceHash: manifest.assets[0].evidenceHash,
        toStage: 'approved',
        artifact: { kind: 'skill', artifactId: 'review', version: '2.0.0', source: 'git', contentHash: manifest.assets[0].contentHash, gitCommit: manifest.source.revision },
      }]) },
      templateApprovals: { get: vi.fn(async () => ({
        id: manifest.release.approval.id,
        status: 'approved',
        templateId: manifest.id,
        version: manifest.version,
        templateHash: manifest.templateHash,
        runId: run.id,
        suiteId: suite.id,
        evidenceHash: run.evidenceHash,
        submitterId: manifest.release.approval.submitterId,
        reviewerId: manifest.release.approval.reviewerId,
        submitterAssurance: 'local-os-account',
        reviewerAssurance: 'local-os-account',
      })) },
    }

    await expect(verifyTeamTemplateGovernance(manifest, governance)).resolves.toMatchObject({ verified: true })
    run = { ...run, subjectHash: hash('9') }
    run.evidenceHash = computeEvaluationEvidenceHash(run)
    await expect(verifyTeamTemplateGovernance(manifest, governance)).rejects.toThrow('subject')
    run = {
      ...run,
      subjectHash: manifest.templateHash,
      candidate: { ...run.candidate, artifactId: 'unrelated' },
    }
    run.evidenceHash = computeEvaluationEvidenceHash(run)
    manifest.release.evidence.evidenceHash = run.evidenceHash
    manifest.release.approval.evidenceHash = run.evidenceHash
    await expect(verifyTeamTemplateGovernance(manifest, governance)).rejects.toThrow('declared candidate')
  })

})
