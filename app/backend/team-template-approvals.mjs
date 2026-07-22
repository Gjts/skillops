import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { EvaluationError } from './evaluations/errors.mjs'
import { withGovernanceFileLock } from './governance/skeleton-lock.mjs'

const HASH = /^[a-f0-9]{64}$/

function text(value, label, maximum = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new EvaluationError(`${label} is invalid.`, 422)
  }
  return value.trim()
}

function hash(value, label) {
  const normalized = text(value, label, 64).toLowerCase()
  if (!HASH.test(normalized)) throw new EvaluationError(`${label} must be a SHA-256 hash.`, 422)
  return normalized
}

function principal(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError(`${label} is unavailable.`, 403)
  const assurance = text(value.assurance, `${label} assurance`, 100)
  if (assurance === 'unverified-legacy') throw new EvaluationError(`${label} must be authenticated.`, 403)
  return { id: text(value.id, label), assurance }
}

export function createTeamTemplateApprovalStore(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.SKILLOPS_DATA_DIR || path.join(process.cwd(), 'data'))
  const file = path.join(dataDir, 'team-template-approvals.json')
  const lock = path.join(dataDir, 'team-template-approvals.lock')
  const now = options.now || (() => new Date())

  async function read() {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'))
      if (!Array.isArray(value)) throw new Error('not an array')
      return value
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw new EvaluationError('Team Template approval store is invalid.', 500)
    }
  }

  async function write(records) {
    await mkdir(dataDir, { recursive: true })
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
  }

  return {
    file,
    async get(id) {
      const approvalId = text(id, 'Team Template approval ID')
      return (await read()).find((record) => record.id === approvalId) || null
    },
    async nominate(value) {
      const submitter = principal(value?.submitter, 'Team Template submitter')
      const candidate = {
        templateId: text(value?.templateId, 'Team Template ID'),
        version: text(value?.version, 'Team Template version', 100),
        templateHash: hash(value?.templateHash, 'Team Template content hash'),
        runId: text(value?.runId, 'Team Template evidence run ID'),
        suiteId: text(value?.suiteId, 'Team Template evidence suite ID'),
        evidenceHash: hash(value?.evidenceHash, 'Team Template evidence hash'),
        submitterId: submitter.id,
        submitterAssurance: submitter.assurance,
      }
      return withGovernanceFileLock(lock, async () => {
        const records = await read()
        const existing = records.find((record) => record.status !== 'rejected' && Object.entries(candidate).every(([key, item]) => record[key] === item))
        if (existing) return existing
        const record = {
          schemaVersion: 1,
          id: `template-approval_${randomUUID()}`,
          ...candidate,
          status: 'pending',
          reviewerId: null,
          reviewerAssurance: null,
          createdAt: now().toISOString(),
          decidedAt: null,
        }
        await write([...records, record])
        return record
      })
    },
    async approve(id, value) {
      const approvalId = text(id, 'Team Template approval ID')
      const reviewer = principal(value?.reviewer, 'Team Template reviewer')
      return withGovernanceFileLock(lock, async () => {
        const records = await read()
        const index = records.findIndex((record) => record.id === approvalId)
        if (index < 0) throw new EvaluationError('Team Template approval was not found.', 404)
        const current = records[index]
        if (current.submitterId === reviewer.id) throw new EvaluationError('Team Template submitter and reviewer must be separate.', 409)
        if (current.status === 'approved') return current
        if (current.status !== 'pending') throw new EvaluationError('Team Template approval is no longer pending.', 409)
        const approved = {
          ...current,
          status: 'approved',
          reviewerId: reviewer.id,
          reviewerAssurance: reviewer.assurance,
          decidedAt: now().toISOString(),
        }
        records[index] = approved
        await write(records)
        return approved
      })
    },
  }
}
