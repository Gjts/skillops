import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTeamTemplateApprovalStore } from './team-template-approvals.mjs'

const directories = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function store() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-template-approvals-'))
  directories.push(dataDir)
  return createTeamTemplateApprovalStore({ dataDir })
}

const principal = (id) => ({ id, assurance: 'local-os-account' })

describe('Team Template approval store', () => {
  it('binds a stable approval ID to exact evidence and separate trusted identities', async () => {
    const approvals = await store()
    const nominated = await approvals.nominate({
      templateId: 'typescript-service',
      version: '1.0.0',
      templateHash: 'a'.repeat(64),
      runId: 'run-1',
      suiteId: 'suite-1',
      evidenceHash: 'b'.repeat(64),
      submitter: principal('user:submitter'),
    })

    await expect(approvals.approve(nominated.id, { reviewer: principal('user:submitter') })).rejects.toThrow('separate')
    const approved = await approvals.approve(nominated.id, { reviewer: principal('user:reviewer') })
    expect(approved).toEqual(expect.objectContaining({
      id: nominated.id,
      status: 'approved',
      templateHash: 'a'.repeat(64),
      evidenceHash: 'b'.repeat(64),
      submitterId: 'user:submitter',
      reviewerId: 'user:reviewer',
    }))
    expect(await approvals.get(nominated.id)).toEqual(approved)
  })
})
