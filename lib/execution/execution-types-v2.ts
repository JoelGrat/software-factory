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
  'baseline.started', 'baseline.clean', 'baseline.pre_existing', 'baseline.tsc_pre_existing',
  'baseline.repair.started', 'baseline.repaired', 'baseline.blocked',
  'repair.inline.started', 'repair.inline.succeeded', 'repair.inline.failed',
  'repair.phase.started', 'repair.phase.succeeded', 'repair.phase.failed',
  'repair.escalated',
  'commit.green', 'commit.wip', 'commit.skipped', 'commit.failed',
  'infra.retrying',
  'log.info', 'log.success', 'log.error',
  'task.started', 'task.files_written',
  'task.validation_started', 'task.validation_passed', 'task.validation_failed',
  'task.repair_started', 'task.repair_completed',
  'task.completed', 'task.failed', 'task.blocked',
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

export type TestabilityStatus =
  | 'full'               // tests ran normally, clean baseline
  | 'full_repaired'      // baseline was broken, we fixed it, tests ran normally
  | 'partial'            // pre-existing assertion failures filtered out; new failures checked
  | 'blocked'            // test infrastructure unresolvable; tests never ran

// Outcome category is more nuanced than status:
//   partial_success = files generated + some progress + still failing at end
export type OutcomeCategory = 'success' | 'partial_success' | 'failure' | 'blocked' | 'cancelled'

export interface ConfidenceDimensions {
  /** Did the agent generate feature files without type errors? */
  featureGeneration: ConfidenceLabel
  /** Are feature files type-clean? (ignores test-file errors) */
  typeSafety: ConfidenceLabel
  /** Did tests pass (or was testability clean)? */
  testValidity: ConfidenceLabel
  /** Aggregate across all three dimensions */
  overall: ConfidenceLabel
}

export interface ExecutionSummary {
  status: 'success' | 'wip' | 'budget_exceeded' | 'blocked' | 'cancelled'
  outcomeCategory: OutcomeCategory
  iterationsUsed: number
  repairsAttempted: number
  filesChanged: string[]
  finalFailureType: string | null
  commitOutcome: CommitOutcome
  durationMs: number
  testabilityStatus: TestabilityStatus
  /** Errors present in iteration 1 that were gone by the final iteration */
  resolvedErrors: string[]
  /** Errors still present at the end of the last iteration */
  unresolvedErrors: string[]
  /** Per-dimension confidence breakdown */
  confidence: ConfidenceDimensions
  /** Task-level summary (populated when using task-based execution) */
  taskRunSummary?: TaskRunSummary
}

// ── Task-based execution summary ───────────────────────────────────────────────

export interface TaskRunSummary {
  completedTasks: string[]   // task IDs
  failedTasks: string[]
  blockedTasks: string[]
  skippedTasks: string[]
  totalTasks: number
  durationMs: number
  finalStatus: 'success' | 'partial' | 'failed'
}

export interface TaskBudget {
  maxInlineRepairs: number
  maxRepairPhaseAttempts: number
}

export const DEFAULT_TASK_BUDGET: TaskBudget = {
  maxInlineRepairs: 3,
  maxRepairPhaseAttempts: 2,
}

// ── Stuck detector ─────────────────────────────────────────────────────────────

export type StuckReason =
  | 'same_errors_repeated'        // identical sigs repeated across iterations
  | 'new_errors_after_partial_fix' // prev errors resolved but new ones surfaced (net increase)
  | 'validation_regressed'         // error count increased AND prev errors still present
  | 'oscillating_errors'           // A→B→A pattern across last 3 iterations
  | 'same_file_repeated'           // same file patched 3+ times with no improvement
  | 'no_diff_after_repair'         // repair produced no file changes
  | 'max_attempts_reached'         // exhausted repair budget
  | 'timeout_no_evidence'          // tests timed out after repair attempts — no diagnostic evidence

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
  /** Errors resolved since the previous iteration (sigs that disappeared) */
  resolvedCount: number
  /** New errors introduced this iteration (sigs not seen before) */
  newCount: number
  /** Files patched by any repair in this iteration */
  repairedFiles: string[]
}
