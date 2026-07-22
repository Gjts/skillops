// @vitest-environment node
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitArtifactSource } from './git-artifact-source.mjs'
import { createArtifactResolver } from './artifact-resolver.mjs'

const execute = promisify(execFile)
const roots = []

async function git(root, ...args) {
  const result = await execute('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
  return result.stdout.trim()
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'skillops-git-artifacts-'))
  roots.push(root)
  const files = {
    'skills/review/SKILL.md': '---\nname: review\nversion: 1.0.0\ndescription: Reviews changes.\n---\n# Review\nReview carefully.\n',
    'skills/review/scripts/check.mjs': 'export const verdict = "safe"\n',
    'prompts/review.prompt.json': '{"schemaVersion":1,"id":"prompthub-4948","name":"Review","template":"Review {{input}}","model":{"provider":"openai","name":"gpt-5.6-sol"},"variables":["input"]}\n',
    'workflows/release.md': '---\nname: release\nversion: 1.0.0\n---\n# Release\nRun checks, then release.\n',
    'AGENTS.md': '# Rules\nRun tests.\n',
    '.claude/agents/reviewer.md': '---\nname: reviewer\nversion: 1.0.0\n---\n# Reviewer\nReview code.\n',
    '.codex/agents/codex-reviewer.toml': 'name = "codex_reviewer"\ndescription = "Reviews changes with Codex."\ndeveloper_instructions = """\nReview code carefully.\n"""\n',
    'evals/suites/quality.json': '{"schemaVersion":1,"id":"quality","name":"Quality","version":"1.0.0"}\n',
    'policies/secure.json': '{"schemaVersion":1,"id":"secure","name":"Secure","version":"1.0.0"}\n',
  }
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, contents, 'utf8')
  }
  await git(root, 'init', '-b', 'main')
  await git(root, 'add', '.')
  await git(root, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'assets')
  const commit = await git(root, 'rev-parse', 'HEAD')
  return { root, commit, source: createGitArtifactSource({ artifactWorkspace: root }) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('generic Git Artifact source', () => {
  it('discovers every Git-managed Artifact kind at an immutable commit', async () => {
    const { commit, source } = await fixture()
    const snapshot = await source.list()

    expect(snapshot.commit).toBe(commit)
    expect(new Set(snapshot.items.map((item) => item.artifact.kind))).toEqual(new Set([
      'skill', 'prompt', 'workflow', 'rules', 'agent', 'evaluation-suite', 'policy-pack',
    ]))
    expect(snapshot.items.every((item) => item.artifact.source === 'git' && item.artifact.gitCommit === commit)).toBe(true)
    expect(snapshot.items.find((item) => item.artifact.kind === 'rules')?.artifact.runtimeTargets).toEqual(['codex'])
    expect(snapshot.items.find((item) => item.relativePath === 'AGENTS.md')?.artifact.artifactId).toBe('AGENTS')
    expect(snapshot.items.find((item) => item.relativePath === '.claude/agents/reviewer.md')?.artifact.runtimeTargets).toEqual(['claude-code'])
    expect(snapshot.items.find((item) => item.relativePath === '.codex/agents/codex-reviewer.toml')).toEqual(expect.objectContaining({
      id: 'codex_reviewer',
      name: 'codex_reviewer',
      artifact: expect.objectContaining({
        kind: 'agent',
        description: 'Reviews changes with Codex.',
        runtimeTargets: ['codex'],
      }),
    }))
    expect(snapshot.items.find((item) => item.artifact.kind === 'prompt')?.artifact.componentHashes?.prompt).toMatch(/^[a-f0-9]{64}$/)
  })

  it('resolves committed content without trusting the working tree', async () => {
    const { root, source } = await fixture()
    const listed = await source.list()
    const workflow = listed.items.find((item) => item.artifact.kind === 'workflow')
    await writeFile(path.join(root, 'workflows/release.md'), '# uncommitted replacement\n', 'utf8')

    const resolved = await source.resolveArtifact(workflow.artifact.sourceRef)
    expect(resolved.contents).toContain('Run checks, then release.')
    expect(resolved.artifact).toEqual(workflow.artifact)
    const resolver = createArtifactResolver({ gitArtifactSource: source })
    expect((await resolver.resolve(workflow.artifact.sourceRef, {
      expectedContentHash: workflow.artifact.contentHash,
    })).artifact).toEqual(workflow.artifact)
    await expect(resolver.resolve(workflow.artifact.sourceRef, {
      expectedContentHash: '0'.repeat(64),
    })).rejects.toThrow('recorded content hash')
    await expect(source.resolveArtifact(workflow.artifact.sourceRef.replace(/.$/, '0'))).rejects.toThrow('content')
  })

  it('binds every file in a Skill directory to one immutable package hash', async () => {
    const { root, source } = await fixture()
    const before = (await source.list()).items.find((item) => item.relativePath === 'skills/review/SKILL.md')
    const resolved = await source.resolveArtifact(before.artifact.sourceRef)

    expect(resolved.packageFiles.map((file) => file.relativePath)).toEqual(['SKILL.md', 'scripts/check.mjs'])
    expect(resolved.packageFiles.find((file) => file.relativePath === 'scripts/check.mjs')?.contents.toString('utf8')).toContain('"safe"')

    await writeFile(path.join(root, 'skills/review/scripts/check.mjs'), 'export const verdict = "unsafe"\n')
    await git(root, 'add', '.')
    await git(root, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'change Skill support file')
    const after = (await source.list()).items.find((item) => item.relativePath === 'skills/review/SKILL.md')

    expect(after.artifact.contentHash).not.toBe(before.artifact.contentHash)
    expect((await source.resolveArtifact(before.artifact.sourceRef)).artifact.contentHash).toBe(before.artifact.contentHash)
  })
})
