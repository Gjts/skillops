import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeEvaluationSuite } from './suite-schema.mjs'
import { redactEvaluationText, redactEvaluationVariables } from './evaluation-redaction.mjs'
import { createSuiteRegistry } from './suite-registry.mjs'

const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function validSuite(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'safe-suite',
    name: 'Safe suite',
    version: '1.0.0',
    owner: 'test-team',
    sensitivity: 'synthetic',
    artifactKind: 'skill',
    repeats: 1,
    cases: [{ id: 'case-1', input: 'Return JSON.', assertions: [{ type: 'is-json' }] }],
    ...overrides,
  }
}

async function fixtureRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'skillops-suites-'))
  roots.push(root)
  await mkdir(path.join(root, 'suites'), { recursive: true })
  await mkdir(path.join(root, 'datasets'), { recursive: true })
  return root
}

describe('Suite Schema v1', () => {
  it('rejects executable configuration and file-like inputs', () => {
    expect(() => normalizeEvaluationSuite({ ...validSuite(), providers: ['exec:whoami'] })).toThrow('unsupported field: providers')
    expect(() => normalizeEvaluationSuite(validSuite({
      cases: [{ id: 'case-1', input: 'file://C:/secret', assertions: [{ type: 'contains', value: 'x' }] }],
    }))).toThrow('forbidden executable source')
    expect(() => normalizeEvaluationSuite(validSuite({
      cases: [{ id: 'case-1', input: 'x', assertions: [{ type: 'javascript', value: 'return true' }] }],
    }))).toThrow('not allowed')
  })

  it('accepts suites for every governed Artifact kind', () => {
    for (const artifactKind of ['skill', 'prompt', 'workflow', 'rules', 'agent', 'evaluation-suite', 'policy-pack']) {
      expect(normalizeEvaluationSuite(validSuite({ artifactKind })).artifactKind).toBe(artifactKind)
    }
  })

  it('rejects duplicate IDs, oversized suites, and complex regular expressions', () => {
    const duplicate = { id: 'same', input: 'x', assertions: [{ type: 'contains', value: 'x' }] }
    expect(() => normalizeEvaluationSuite(validSuite({ cases: [duplicate, duplicate] }))).toThrow('Duplicate suite case ID')
    expect(() => normalizeEvaluationSuite(validSuite({ cases: Array.from({ length: 201 }, (_, index) => ({ id: `case-${index}`, input: 'x', assertions: [{ type: 'contains', value: 'x' }] })) }))).toThrow('200-case limit')
    expect(() => normalizeEvaluationSuite(validSuite({ cases: [{ id: 'case-1', input: 'x', assertions: [{ type: 'regex', value: '(a+)+$' }] }] }))).toThrow('too complex')
  })

  it('accepts a bounded model matrix and rejects excessive evaluation cells', () => {
    expect(normalizeEvaluationSuite(validSuite({
      matrix: { models: [{ id: 'fast', model: 'gpt-fast' }, { id: 'strong', model: 'gpt-strong' }] },
    })).matrix.models).toEqual([
      { id: 'fast', model: 'gpt-fast' },
      { id: 'strong', model: 'gpt-strong' },
    ])
    expect(() => normalizeEvaluationSuite(validSuite({
      repeats: 5,
      matrix: { models: [{ id: 'one', model: 'gpt-1' }, { id: 'two', model: 'gpt-2' }] },
      cases: Array.from({ length: 101 }, (_, index) => ({ id: `case-${index}`, input: 'x', assertions: [{ type: 'contains', value: 'x' }] })),
    }))).toThrow('2,000-cell limit')
  })

  it('rejects traversal and absolute dataset paths', () => {
    expect(() => normalizeEvaluationSuite({ ...validSuite(), cases: undefined, dataset: '../../secrets.json' })).toThrow('inside evals/datasets')
    expect(() => normalizeEvaluationSuite({ ...validSuite(), cases: undefined, dataset: 'C:\\secrets.json' })).toThrow('inside evals/datasets')
  })

  it('normalizes scoped redaction rules and applies literal replacements', () => {
    const suite = normalizeEvaluationSuite(validSuite({
      redaction: {
        task: [{ pattern: 'TASK-[0-9]+', replacement: '[TASK]' }],
        input: [{ pattern: 'secret', replacement: '$&-removed' }],
        output: [{ pattern: 'token-[a-z]+', replacement: '[TOKEN]' }],
      },
    }))
    expect(redactEvaluationText('TASK-42 token-abc', [...suite.redaction.task, ...suite.redaction.output])).toBe('[TASK] [TOKEN]')
    expect(redactEvaluationVariables({ text: 'secret', count: 2 }, suite.redaction.input)).toEqual({ text: '$&-removed', count: 2 })
    expect(() => normalizeEvaluationSuite(validSuite({
      redaction: { output: [{ pattern: '(a+)+$', replacement: '[REDACTED]' }] },
    }))).toThrow('too complex')
  })
})

describe('suite registry', () => {
  it('lists metadata without returning complete case inputs', async () => {
    const registry = createSuiteRegistry()
    const list = await registry.list()
    expect(list).toContainEqual(expect.objectContaining({ id: 'example-skill-quality', caseCount: 1, sensitivity: 'synthetic' }))
    expect(JSON.stringify(list)).not.toContain('lifecycle completion')
    const suite = await registry.get('example-skill-quality')
    expect(suite.cases[0].id).toBe('concise-answer')
    expect(suite.suiteHash).toMatch(/^[a-f0-9]{64}$/)
    expect(suite.datasetHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects a dataset path that resolves through a symlink outside evals/datasets', async () => {
    const root = await fixtureRoot()
    const outside = await mkdtemp(path.join(tmpdir(), 'skillops-suite-outside-'))
    roots.push(outside)
    await writeFile(path.join(outside, 'cases.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'outside-cases',
      cases: [{ id: 'case-1', input: 'x', assertions: [{ type: 'contains', value: 'x' }] }],
    }))
    await symlink(outside, path.join(root, 'datasets', 'linked'), 'junction')
    await writeFile(path.join(root, 'suites', 'unsafe.json'), JSON.stringify({ ...validSuite(), cases: undefined, dataset: 'linked/cases.json' }))
    await expect(createSuiteRegistry({ evalsRoot: root }).list()).rejects.toThrow('escapes its allowed directory')
  })

  it('rejects a suite directory that is a symlink or junction', async () => {
    const root = await fixtureRoot()
    const outside = await mkdtemp(path.join(tmpdir(), 'skillops-suite-dir-outside-'))
    roots.push(outside)
    await writeFile(path.join(outside, 'unsafe.json'), JSON.stringify(validSuite()))
    await rm(path.join(root, 'suites'), { recursive: true, force: true })
    await symlink(outside, path.join(root, 'suites'), 'junction')
    await expect(createSuiteRegistry({ evalsRoot: root }).list()).rejects.toThrow('non-symlink directory')
  })
})
