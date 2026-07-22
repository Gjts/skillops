export type Runtime = 'codex' | 'claude-code' | 'cursor'
export type ConnectionStatus = 'checking' | 'installed' | 'not-installed' | 'broken' | 'preview' | 'error' | 'unavailable'

export interface RuntimeConnection {
  runtime: Runtime
  status: ConnectionStatus
  checkedAt?: string
  eventCount?: number
  lastEventAt?: string
}
export type EventName =
  | 'skill.discovered'
  | 'skill.matched'
  | 'skill.started'
  | 'skill.completed'
  | 'skill.failed'
  | 'skill.skipped'
  | 'session.started'
  | 'session.completed'
  | 'turn.completed'
  | 'prompt.submitted'
  | 'tool.started'
  | 'tool.completed'
  | 'subagent.started'
  | 'subagent.completed'

export type Outcome = 'success' | 'failed' | 'unknown'
export type DetectionMethod =
  | 'explicit_prompt'
  | 'slash_command'
  | 'skill_tool'
  | 'skill_path'
  | 'manual'
  | 'hook'

export interface SkillEvent {
  id: string
  event: EventName
  skillId?: string
  skillVersion?: string
  runtime: Runtime
  timestamp: string
  durationMs?: number
  costUsd?: number
  tokens?: number
  sessionId?: string
  project?: string
  sourcePath?: string
  source?: 'global' | 'project' | 'plugin'
  provider?: string
  kind?: 'skill' | 'command' | 'rules' | 'agent'
  enabled?: boolean
  description?: string
  tags?: string[]
  error?: string
  turnId?: string
  promptId?: string
  model?: string
  toolName?: string
  toolUseId?: string
  subagentType?: string
  subagentId?: string
  permissionMode?: string
  outcome?: Outcome
  detectionMethod?: DetectionMethod
  confidence?: number
  promptLength?: number
  skillArgsLength?: number
  commandSource?: string
  reason?: string
  startSource?: string
}

export type DefinitionStatus = 'active' | 'disabled' | 'shadowed' | 'inactive' | 'missing'
export type ConfigurationSource = 'user' | 'project' | 'local' | 'managed' | 'plugin' | 'admin'

export interface InstalledSkill {
  skillId: string
  skillVersion: string
  runtime: Runtime
  source: 'global' | 'project' | 'plugin'
  sourcePath: string
  provider: string
  kind: 'skill' | 'command' | 'rules' | 'agent'
  enabled: boolean
  disabledReason?: 'plugin' | 'skill-config' | 'plugin-and-skill-config'
  status?: DefinitionStatus
  shadowedBy?: string
  configurationSource?: ConfigurationSource
  scope?: ConfigurationSource
  originConfigs?: string[]
  projectRoot?: string
  contentHash?: string
  description?: string
  tags?: string[]
}

export interface SkillScanMetadata {
  id: string
  projectStart?: string
  projectRoot: string
  startedAt: string
  completedAt: string
  durationMs: number
  coverage: Array<{
    runtime: Runtime
    directory: string
    source: InstalledSkill['source']
    configurationSource: ConfigurationSource
    state: 'scanned' | 'missing' | 'inaccessible' | 'error'
  }>
  errors: Array<{ code: string; path: string; runtime: Runtime; message: string }>
  observability: Array<{ runtime: Runtime; state: 'complete' | 'partial'; reason?: string }>
}

export interface SkillScanResponse {
  definitions: Array<Partial<InstalledSkill>>
  scan: SkillScanMetadata
}

export interface SkillMetric {
  key: string
  skillId: string
  version: string
  runtime: Runtime
  runs: number
  successes: number
  knownOutcomes: number
  successRate: number | null
  lifecycleOnly: boolean
  cost: number
  avgDuration: number
  trend: number[]
  latestRunId: string
  latestRunAt: string
}

export type PageId = 'overview' | 'skills' | 'runs' | 'evaluations' | 'registry' | 'governance' | 'team' | 'settings'

export type {
  ArtifactDefinition,
  ArtifactInstallationRecord,
  ArtifactRecord,
  ArtifactRegistrySnapshot,
  ArtifactStatus,
  ArtifactVersionRecord,
  CompatibilityStatus,
  ArtifactKind,
  ArtifactSource,
  Capability,
  CapabilityApproval,
  CapabilityEvidence,
  CapabilityStage,
  CandidateAnalysis,
  CandidateRef,
  CandidateSummary,
  EvaluationVariant,
  EvaluationRunSummary,
  EvaluationSuiteMetadata,
  QuickEvaluationMode,
  QuickEvaluationResult,
  QuickEvaluationWinner,
  SkillMatch,
  SkeletonChangePreview,
} from '../../../shared/evaluation-schema.mjs'
