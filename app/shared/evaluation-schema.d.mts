export type ArtifactKind = 'skill' | 'prompt' | 'workflow' | 'rules' | 'agent' | 'evaluation-suite' | 'policy-pack'
export type ArtifactSource = 'local-scan' | 'git' | 'github' | 'prompt-registry' | 'prompthub'
export type QuickEvaluationMode = 'prompt-only' | 'agent'
export type QuickEvaluationWinner = 'baseline' | 'candidate' | 'tie'
export type EvaluationStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type EvaluationRunMode = 'quick' | 'suite' | 'redteam'

export interface ArtifactDefinition {
  kind: ArtifactKind
  artifactId: string
  version: string
  description?: string
  source: ArtifactSource
  sourceRef: string
  contentHash: string
  providerHint?: string
  modelHint?: string
  variables?: string[]
  componentHashes?: Partial<Record<'system' | 'prompt' | 'model' | 'configuration' | 'variables', string>>
  gitCommit?: string
  repository?: string
  dependencies?: string[]
  runtimeTargets?: RuntimeTarget[]
  compatibility?: Partial<Record<RuntimeTarget, CompatibilityStatus>>
  schemaVersion?: number
  createdAt?: string
}

export type ArtifactStatus = 'draft' | 'candidate' | 'ready' | 'canary' | 'stable' | 'deprecated' | 'blocked'
export type RuntimeTarget = 'codex' | 'claude-code' | 'cursor'
export type CompatibilityStatus = 'supported' | 'preview' | 'unsupported'

export interface ArtifactRecord {
  id: string
  artifactId: string
  kind: ArtifactKind
  name: string
  owner: string
  repository?: string
  status: ArtifactStatus
  description?: string
  createdAt: string | null
  updatedAt: string | null
  versionIds: string[]
}

export interface ArtifactVersionRecord {
  id: string
  artifactId: string
  sourceArtifactId: string
  kind: ArtifactKind
  version: string
  contentHash: string
  gitCommit: string | null
  repository?: string
  schemaVersion: number
  runtimeTargets: RuntimeTarget[]
  compatibility: Record<RuntimeTarget, CompatibilityStatus>
  dependencies: string[]
  source: ArtifactSource
  sourceRef: string
  description?: string
  componentHashes?: ArtifactDefinition['componentHashes']
  status: ArtifactStatus
  createdAt: string | null
}

export interface ArtifactInstallationRecord {
  id: string
  artifactId: string
  artifactVersionId?: string
  runtime: RuntimeTarget
  scope: string
  targetPath: string
  desiredState: 'present' | 'absent' | 'unmanaged'
  observedState: 'present' | 'missing' | 'drifted' | 'unmanaged'
  observedHash?: string
}

export interface ArtifactRegistrySnapshot {
  schemaVersion: 1
  generatedAt: string
  artifacts: ArtifactRecord[]
  versions: ArtifactVersionRecord[]
  installations: ArtifactInstallationRecord[]
  compatibility: Record<ArtifactKind, Record<RuntimeTarget, CompatibilityStatus>>
  warnings: Array<{ source: 'prompt-registry', code: 'PROMPT_SOURCE_UNAVAILABLE' }>
}

export interface CandidateRef {
  sourcePath: string
  sha?: string
  label: string
}

export interface CandidateSummary {
  skillId: string
  skillVersion: string
  description?: string
  headings: string[]
  sourceUrl: string
  sourcePath: string
  sha?: string
  contentHash: string
}

export interface SkillMatch {
  skillId: string
  skillVersion: string
  description?: string
  runtime: string
  source: string
  sourcePath: string
  provider: string
  similarity: number
  relationship: string
  sharedSignals: string[]
}

export interface CandidateAnalysis {
  candidate: CandidateSummary
  candidates: CandidateRef[]
  matches: SkillMatch[]
  recommendation: string
}

export interface EvaluationVariant {
  skillId: string
  skillVersion: string
  score: number
  durationMs: number
  tokens: number
  output: string
}

export interface QuickEvaluationResult {
  id: string
  createdAt: string
  mode: QuickEvaluationMode
  winner: QuickEvaluationWinner
  reason: string
  baseline: EvaluationVariant
  candidate: EvaluationVariant
  judge: { tokens: number; provider: string; model: string }
  privacy: string
  engine?: { name: 'skillops-legacy' | 'promptfoo'; version: string }
}

export interface EvaluationMetrics {
  baselineScore: number | null
  candidateScore: number | null
  scoreDeltaPp: number | null
  casesPassed: number
  casesTotal: number
  passRatePct: number | null
  regressionRatePct: number | null
  baselineTokens: number | null
  candidateTokens: number | null
  baselineCostUsd: number | null
  candidateCostUsd: number | null
  costDeltaPct: number | null
  baselineP95LatencyMs: number | null
  candidateP95LatencyMs: number | null
  latencyDeltaPct: number | null
  attackSuccessRatePct?: number | null
  criticalFindings: number
  highFindings: number
}

export interface EvaluationGate {
  id: string
  status: 'passed' | 'failed' | 'not-available'
  blocking: boolean
}

export interface EvaluationRunSummary {
  id: string
  mode: EvaluationRunMode
  status: EvaluationStatus
  capabilityId?: string
  suiteId?: string
  suiteVersion?: string
  suiteHash: string | null
  datasetHash: string | null
  casesHash: string | null
  baseline: ArtifactDefinition
  candidate: ArtifactDefinition
  engine: { name: 'skillops-legacy' | 'promptfoo'; version: string }
  provider: { id: string; model: string; models?: string[]; configurationHash?: string }
  metrics: EvaluationMetrics | null
  policyHash: string | null
  gates: EvaluationGate[]
  evidenceHash: string | null
  gateResult: 'passed' | 'failed' | 'not-evaluated'
  requestedBy: string
  requestedAt: string
  startedAt: string | null
  completedAt: string | null
  errorCode: string | null
}

export interface EvaluationSuiteMetadata {
  id: string
  name: string
  version: string
  owner: string
  sensitivity: 'synthetic' | 'internal' | 'restricted'
  artifactKind: ArtifactKind
  repeats: number
  matrix?: { models: Array<{ id: string; model: string }> }
  caseCount: number
  suiteHash: string
  datasetHash: string | null
  datasetId: string | null
}

export type CapabilityStage = 'candidate' | 'evaluating' | 'blocked' | 'ready' | 'approved' | 'canary' | 'stable' | 'deprecated' | 'superseded' | 'rolled-back'

export interface CapabilityEvidence {
  qualityRunId: string
  redteamRunId?: string | null
  baselineHash: string
  candidateHash: string
  suiteHash: string
  datasetHash?: string | null
  policyHash: string
  qualityEvidenceHash: string
  redteamEvidenceHash?: string | null
  evidenceHash: string
  boundAt: string
}

export interface CapabilityApproval {
  reviewer: string
  decision: 'approved' | 'rejected'
  evidenceHash: string
  decidedAt: string
}

export interface Capability {
  id: string
  artifact: ArtifactDefinition
  baseline: ArtifactDefinition | null
  owner: string
  targetSkeleton: string
  projectId?: string | null
  projectRoot?: string | null
  targetKey?: string | null
  stage: CapabilityStage
  requalifiesStage?: 'deprecated' | 'superseded' | null
  policyId: string
  latestEvidenceRunId?: string | null
  evidence: CapabilityEvidence | null
  approvals: CapabilityApproval[]
  evidenceStale: boolean
  reviewerIdentityAssurance: string
  createdAt: string
  updatedAt: string
}

export interface SkeletonChangePreview {
  previewToken: string
  capabilityId: string
  source: string
  target: string
  projectRoot?: string
  currentHash: string | null
  candidateHash: string
  diff: { beforeLines: number; afterLines: number; changedLines: number }
  conflict: boolean
  backup: string
  rollbackPlan: string
  expiresAt: string
  restoredCapabilityId?: string
}

export const ARTIFACT_KINDS: readonly ArtifactKind[]
export const ARTIFACT_REFERENCE_ONLY_KINDS: readonly ArtifactKind[]
export const ARTIFACT_SOURCES: readonly ArtifactSource[]
export const ARTIFACT_STATUSES: readonly ArtifactStatus[]
export const ARTIFACT_RUNTIME_COMPATIBILITY: Readonly<Record<ArtifactKind, Readonly<Record<RuntimeTarget, CompatibilityStatus>>>>
export const QUICK_EVALUATION_MODES: readonly QuickEvaluationMode[]
export const QUICK_EVALUATION_WINNERS: readonly QuickEvaluationWinner[]
export const EVALUATION_STATUSES: readonly EvaluationStatus[]
export const EVALUATION_RUN_MODES: readonly EvaluationRunMode[]

export class EvaluationSchemaError extends Error {
  status: number
}

export function normalizeCandidateAnalysisRequest(value: unknown): {
  sourceUrl: string
  candidatePath?: string
}
export function normalizeQuickEvaluationRequest(value: unknown): {
  sourceUrl: string
  candidatePath?: string
  candidateContentHash: string
  baselineSourcePath: string
  task: string
  criteria: string
  mode: QuickEvaluationMode
  provider: {
    provider: string
    model?: string
    apiKey?: string
    baseUrl?: string
    endpoint?: string
    apiVersion?: string
    reasoningEffort?: string
  }
}
export function normalizeAssistantChatRequest(value: unknown): unknown
export function normalizeManagedEvaluationRunRequest(value: unknown): {
  mode: 'suite' | 'redteam'
  suiteId: string
  baselineRef: string
  candidateRef: string
  provider: Record<string, string | undefined>
  requestedBy: string
  clientRequestId?: string
  capabilityId?: string
}
export function normalizeEvaluationApiBody(pathname: string, value: unknown): unknown
export function normalizeArtifactDefinition(value: unknown): ArtifactDefinition
export function normalizeArtifactRecord(value: unknown): Omit<ArtifactRecord, 'versionIds'>
export function normalizeArtifactVersionRecord(value: unknown): ArtifactVersionRecord
export function normalizeInstallationRecord(value: unknown): ArtifactInstallationRecord
