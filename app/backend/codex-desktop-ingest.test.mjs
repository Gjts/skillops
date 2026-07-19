import { describe, expect, it } from 'vitest'
import { parseCodexDesktopSession } from './codex-desktop-ingest.mjs'

const sessionId = 'desktop-session'
const turnId = 'desktop-turn'
const project = 'D:\\work\\skillops'
const grillPath = 'C:\\Users\\tester\\.agents\\skills\\grill-me\\SKILL.md'
const grillingPath = 'C:\\Users\\tester\\.agents\\skills\\grilling\\SKILL.md'
const secretPrompt = 'PRIVATE USER MESSAGE THAT MUST NOT BE STORED'

const skills = [
  {
    skillId: 'grill-me',
    skillVersion: 'unversioned',
    runtime: 'codex',
    source: 'global',
    sourcePath: grillPath,
    provider: 'Agents',
    kind: 'skill',
    enabled: true,
  },
  {
    skillId: 'grilling',
    skillVersion: '1.2.3',
    runtime: 'codex',
    source: 'global',
    sourcePath: grillingPath,
    provider: 'Agents',
    kind: 'skill',
    enabled: true,
  },
]

function record(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload })
}

function fixture(source = 'vscode') {
  const escapedGrillPath = grillPath.replaceAll('\\', '\\\\')
  const escapedGrillingPath = grillingPath.replaceAll('\\', '\\\\')
  return [
    record('2026-07-19T15:48:40.000Z', 'session_meta', { id: sessionId, source, cwd: project }),
    record('2026-07-19T15:48:41.000Z', 'event_msg', { type: 'task_started', turn_id: turnId, started_at: '2026-07-19T15:48:41.000Z' }),
    record('2026-07-19T15:48:41.100Z', 'turn_context', { turn_id: turnId, cwd: project, model: 'gpt-test', approval_policy: 'never' }),
    record('2026-07-19T15:48:42.000Z', 'event_msg', { type: 'user_message', message: secretPrompt }),
    record('2026-07-19T15:48:42.500Z', 'response_item', {
      type: 'custom_tool_call',
      name: 'exec',
      input: `const patch = "fixture path: ${escapedGrillPath}"; await tools.apply_patch(patch)`,
    }),
    record('2026-07-19T15:48:43.000Z', 'response_item', {
      type: 'custom_tool_call',
      name: 'exec',
      input: `await tools.exec_command({ cmd: "Get-Content -LiteralPath '${escapedGrillPath}'" })`,
    }),
    record('2026-07-19T15:48:44.000Z', 'response_item', {
      type: 'custom_tool_call',
      name: 'exec',
      input: `await tools.exec_command({ cmd: "Get-Content -LiteralPath '${escapedGrillingPath}'" })`,
    }),
    record('2026-07-19T15:48:49.000Z', 'event_msg', {
      type: 'task_complete',
      turn_id: turnId,
      completed_at: 1784476129,
      duration_ms: 8000,
    }),
  ].join('\n')
}

describe('Codex Desktop session ingestion', () => {
  it('records every Skill file actually read without persisting raw prompt or tool input', () => {
    const events = parseCodexDesktopSession(fixture(), skills)

    for (const skillId of ['grill-me', 'grilling']) {
      expect(events.filter((event) => event.skillId === skillId).map((event) => event.event))
        .toEqual(['skill.matched', 'skill.started', 'skill.completed'])
    }
    expect(events.filter((event) => event.event === 'skill.started')).toEqual([
      expect.objectContaining({
        sessionId,
        turnId,
        skillId: 'grill-me',
        sourcePath: grillPath,
        detectionMethod: 'skill_path',
        confidence: 0.92,
      }),
      expect.objectContaining({
        sessionId,
        turnId,
        skillId: 'grilling',
        sourcePath: grillingPath,
        skillVersion: '1.2.3',
      }),
    ])
    expect(events).toContainEqual(expect.objectContaining({
      event: 'skill.completed',
      skillId: 'grill-me',
      durationMs: 6000,
      timestamp: '2026-07-19T15:48:49.000Z',
    }))
    expect(events).toContainEqual(expect.objectContaining({
      event: 'turn.completed',
      sessionId,
      turnId,
      outcome: 'unknown',
    }))

    const persisted = JSON.stringify(events)
    expect(persisted).not.toContain(secretPrompt)
    expect(persisted).not.toContain('Get-Content')
  })

  it('ignores Codex CLI rollouts because hooks already record those sessions', () => {
    expect(parseCodexDesktopSession(fixture('exec'), skills)).toEqual([])
  })
})
