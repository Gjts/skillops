// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('production server binding', () => {
  it('rejects non-loopback hosts before opening the unauthenticated API', () => {
    const result = spawnSync(process.execPath, ['app/backend/server.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, SKILLOPS_HOST: '0.0.0.0' },
      encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('must remain a loopback hostname')
  })
})
