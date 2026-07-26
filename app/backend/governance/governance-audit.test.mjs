import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGovernanceAuditLog } from './governance-audit.mjs'

const temporaryDirectories = []
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

const capability = {
  id: 'cap-1',
  artifact: {
    kind: 'skill', artifactId: 'review', version: '1.0.0', source: 'github',
    sourceRef: `github:https://github.com/acme/review/blob/${'a'.repeat(40)}/SKILL.md#SKILL.md`,
    contentHash: 'b'.repeat(64), gitCommit: 'a'.repeat(40),
  },
  evidence: { evidenceHash: 'c'.repeat(64) },
}

describe('governance audit log', () => {
  it('appends recoverable metadata-only state transitions and filters by capability', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-governance-audit-'))
    temporaryDirectories.push(dataDir)
    const audit = createGovernanceAuditLog({ dataDir })
    const first = await audit.append({ action: 'candidate.nominated', actor: 'Owner', capability, fromStage: null, toStage: 'candidate' })
    await audit.append({ action: 'evidence.bound', actor: 'Evaluator', capability: { ...capability, id: 'cap-2' }, fromStage: 'candidate', toStage: 'ready' })
    await appendFile(audit.file, '{"partial":', 'utf8')
    const partial = await readFile(audit.file, 'utf8')

    expect(await audit.list({ capabilityId: capability.id })).toEqual([first])
    expect(await audit.health()).toEqual({ sourceStatus: 'partial' })
    await expect(audit.append({ action: 'approval.decided', actor: 'Reviewer', capability, fromStage: 'ready', toStage: 'approved' })).rejects.toThrow('partial trailing record')
    expect(await readFile(audit.file, 'utf8')).toBe(partial)
    expect(first).toEqual(expect.objectContaining({
      action: 'candidate.nominated', actor: 'Owner', capabilityId: capability.id,
      artifact: expect.objectContaining({ artifactId: 'review', contentHash: 'b'.repeat(64) }),
      evidenceHash: 'c'.repeat(64), fromStage: null, toStage: 'candidate',
    }))
    const persisted = await readFile(audit.file, 'utf8')
    expect(persisted).not.toContain('sourceRef')
    expect(persisted).not.toContain('contents')
  })

  it('rejects unsupported fields instead of persisting accidental content', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-governance-audit-'))
    temporaryDirectories.push(dataDir)
    const audit = createGovernanceAuditLog({ dataDir })
    await expect(audit.append({ action: 'candidate.nominated', actor: 'Owner', capability, fromStage: null, toStage: 'candidate', contents: 'secret' })).rejects.toThrow('unsupported field')
  })

  it('stably paginates collapsed audit transactions with source health', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-governance-audit-'))
    temporaryDirectories.push(dataDir)
    const audit = createGovernanceAuditLog({ dataDir })
    const records = []
    for (let index = 0; index < 21; index += 1) {
      records.push(await audit.append({
        action: 'candidate.nominated',
        actor: `Owner-${index}`,
        capability,
        fromStage: null,
        toStage: 'candidate',
      }))
    }

    const expected = [...records].sort((left, right) => {
      if (left.at !== right.at) return left.at > right.at ? -1 : 1
      if (left.transactionId !== right.transactionId) return left.transactionId > right.transactionId ? -1 : 1
      return left.id > right.id ? -1 : left.id < right.id ? 1 : 0
    })
    expect(await audit.page({ page: 1, pageSize: 20 })).toEqual({
      items: expected.slice(0, 20),
      page: 1,
      pageSize: 20,
      totalItems: 21,
      totalPages: 2,
      hasPrevious: false,
      hasNext: true,
      sourceStatus: 'ok',
    })
    expect((await audit.page({ page: 2, pageSize: 20 })).items).toEqual(expected.slice(20))
  })

  it('rejects a fully written malformed record without changing the audit file', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-governance-audit-'))
    temporaryDirectories.push(dataDir)
    const audit = createGovernanceAuditLog({ dataDir })
    await audit.append({ action: 'candidate.nominated', actor: 'Owner', capability, fromStage: null, toStage: 'candidate' })
    await appendFile(audit.file, '{"malformed":}\n', 'utf8')
    const corrupted = await readFile(audit.file, 'utf8')

    await expect(audit.list()).rejects.toThrow('corrupted; no data was changed')
    await expect(audit.append({ action: 'approval.decided', actor: 'Reviewer', capability, fromStage: 'ready', toStage: 'approved' })).rejects.toThrow('corrupted; no data was changed')
    expect(await readFile(audit.file, 'utf8')).toBe(corrupted)
  })

  it.each(['{}', 'not-json'])('does not misclassify a complete invalid record without a newline as partial: %s', async (record) => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-governance-audit-'))
    temporaryDirectories.push(dataDir)
    const audit = createGovernanceAuditLog({ dataDir })
    await appendFile(audit.file, record, 'utf8')

    await expect(audit.health()).rejects.toThrow('corrupted; no data was changed')
  })
})
