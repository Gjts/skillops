export type ArtifactKind = 'skill' | 'prompt' | 'workflow'
export type ArtifactSource = 'local-scan' | 'github' | 'prompt-registry'
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
  baseline: ArtifactDefinition
  candidate: ArtifactDefinition
  engine: { name: 'skillops-legacy' | 'promptfoo'; version: string }
  provider: { id: string; model: string }
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
  caseCount: number
  suiteHash: string
  datasetHash: string | null
  datasetId: string | null
}

export type CapabilityStage = 'candidate' | 'evaluating' | 'blocked' | 'ready' | 'approved' | 'canary' | 'stable' | 'superseded' | 'rolled-back'

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
  note?: string
  evidenceHash: string
  decidedAt: string
}

export interface Capability {
  id: string
  artifact: ArtifactDefinition
  baseline: ArtifactDefinition | null
  owner: string
  targetSkeleton: string
  stage: CapabilityStage
  policyId: string
  latestEvidenceRunId?: string | null
  evidence: CapabilityEvidence | null
  approvals: CapabilityApproval[]
  evidenceStale: boolean
  reviewerIdentityAssurance: 'locally-declared'
  createdAt: string
  updatedAt: string
}

export interface SkeletonChangePreview {
  previewToken: string
  capabilityId: string
  source: string
  target: string
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
export const ARTIFACT_SOURCES: readonly ArtifactSource[]
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
