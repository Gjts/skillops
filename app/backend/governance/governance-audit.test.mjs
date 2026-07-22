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
    const recovered = await audit.append({ action: 'approval.decided', actor: 'Reviewer', capability, fromStage: 'ready', toStage: 'approved' })

    expect(await audit.list({ capabilityId: capability.id })).toEqual([recovered, first])
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
})
