// lib/execution/execution-types-v2.ts

// ── Event taxonomy ─────────────────────────────────────────────────────────────

export const EVENT_TYPES = [
  'execution.started', 'execution.completed',
  'execution.budget_exceeded', 'execution.blocked', 'execution.cancelled',
  'iteration.started', 'iteration.completed', 'iteration.stuck',
  'phase.static_validation.started', 'phase.static_validation.passed', 'phase.static_validation.failed',
  'phase.unit.started', 'phase.unit.passed', 'phase.unit.failed',
  'phase.integration.started', 'phase.integration.passed', 'phase.integration.failed',
  'phase.smoke.started', 'phase.smoke.passed', 'phase.smoke.failed',
  'phase.skipped',
  'repair.inline.started', 'repair.inline.succeeded', 'repair.inline.failed',
  'repair.phase.started', 'repair.phase.succeeded', 'repair.phase.failed',
  'repair.escalated',
  'commit.green', 'commit.wip', 'commit.skipped', 'commit.failed',
  'infra.retrying',
  'log.info', 'log.success', 'log.error',
] as const

export type EventType = typeof EVENT_TYPES[number]

// ── Budget ─────────────────────────────────────────────────────────────────────

export interface ExecutionBudget {
  global: {
    maxIterations: number
    maxRuntimeMs: number
  }
  perIteration: {
    maxInlineRepairs: number
    maxRepairPhaseAttempts: number
  }
}

export const DEFAULT_BUDGET: ExecutionBudget = {
  global: { maxIterations: 5, maxRuntimeMs: 600_000 },
  perIteration: { maxInlineRepairs: 3, maxRepairPhaseAttempts: 2 },
}

// ── Diagnostics ────────────────────────────────────────────────────────────────

export interface ExecutionDiagnostic {
  file: string
  line: number
  message: string
  code: string
}

export interface DiagnosticSet {
  diagnostics: ExecutionDiagnostic[]  // first 20
  totalCount: number
  truncated: boolean
}

// ── Repair ─────────────────────────────────────────────────────────────────────

export type ConfidenceLabel = 'high' | 'medium' | 'low'

export function toConfidenceLabel(score: number): ConfidenceLabel {
  if (score >= 0.75) return 'high'
  if (score >= 0.4)  return 'medium'
  return 'low'
}

export interface RepairAttempt {
  phase: 'inline' | 'repair_phase'
  filesPatched: string[]
  diagnosticsTargeted: string[]
  confidenceScore: number           // 0.0 – 1.0
  confidenceLabel: ConfidenceLabel
  rationale: string                 // max 140 chars
}

// ── Commit outcome ─────────────────────────────────────────────────────────────

export type CommitOutcome =
  | { type: 'green' }
  | { type: 'wip'; reason: string }
  | { type: 'no_commit'; reason: string }
  | { type: 'blocked' }

// ── Execution summary ──────────────────────────────────────────────────────────

export interface ExecutionSummary {
  status: 'success' | 'wip' | 'budget_exceeded' | 'blocked' | 'cancelled'
  iterationsUsed: number
  repairsAttempted: number
  filesChanged: string[]
  finalFailureType: string | null
  commitOutcome: CommitOutcome
  durationMs: number
}

// ── Stuck detector ─────────────────────────────────────────────────────────────

export type StuckReason =
  | 'repeated_diagnostic'
  | 'error_count_increased'
  | 'same_file_repeated'
  | 'alternating_diagnostic'
  | 'budget_hit'
  | 'no_repair_progress'

export interface StuckResult {
  stuck: boolean
  reason: StuckReason | null
}

// ── Test mode ──────────────────────────────────────────────────────────────────

export type TestMode = 'fail_fast' | 'collect_all'

// ── Per-iteration tracking ─────────────────────────────────────────────────────

export interface IterationRecord {
  iteration: number
  /** Diagnostic signatures from static validation (for stuck detection) */
  diagnosticSigs: string[]
  /** Error count from static validation */
  errorCount: number
  /** Files patched by any repair in this iteration */
  repairedFiles: string[]
}
