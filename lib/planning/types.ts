// lib/planning/types.ts

// ---- Spec ----

export interface ChangeSpec {
  problem: string
  goals: string[]
  architecture: string
  constraints: string[]
  data_model?: string
  ui_behavior?: string
  policies?: string[]
  out_of_scope: string[]
}

// ---- Plan ----

export type ValidationCheck =
  | { type: 'command'; command: string; success_contains?: string }
  | { type: 'file_exists'; target: string }
  | { type: 'schema'; table: string; expected_columns?: string[] }
  | { type: 'test_pass'; pattern?: string }

export type SubstepAction =
  | 'write_file'
  | 'modify_file'
  | 'run_command'
  | 'verify_schema'
  | 'run_test'
  | 'insert_row'

export interface Substep {
  id: string
  action: SubstepAction
  target?: string    // file path or schema name
  command?: string
  expected?: string[]
}

export type TaskType =
  | 'backend'
  | 'frontend'
  | 'database'
  | 'testing'
  | 'infra'
  | 'api'
  | 'refactor'

export interface Task {
  id: string
  title: string
  description?: string   // optional long-form for UI and human review
  type: TaskType
  files: string[]
  depends_on: string[]   // task ids within the plan
  substeps: Substep[]    // execute in array order; future scheduler may override
  validation: ValidationCheck[]
  expected_result: string
  retryable?: boolean
  parallelizable?: boolean  // task may run alongside others; does NOT affect substep ordering
}

export interface Phase {
  id: string
  title: string
  depends_on: string[]   // phase ids
  tasks: Task[]
}

export interface DetailedPlan {
  schema_version: 1
  planner_version: number
  goal: string
  // branch_name lives as a top-level column on change_plans — not stored here
  phases: Phase[]
}

// ---- Failure ----

export interface PlannerDiagnostics {
  summary: string
  issues: string[]   // first 10 only
  truncated: boolean
}

export type PlannerStage = 'spec' | 'plan' | 'projection' | 'impact' | 'risk' | 'policy'

export interface PlannerFailure {
  stage: PlannerStage
  retryable: boolean
  reason: string
  diagnostics: PlannerDiagnostics
  failed_at: string   // ISO timestamp
}

// ---- Impact seeding ----

export interface PlanSeeds {
  filePaths: string[]
  componentHints: string[]
  hasMigration: boolean
  commands: string[]
}
