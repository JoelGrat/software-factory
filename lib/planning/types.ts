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

export interface CodeSnippet {
  file: string
  language: string
  purpose: string
  content: string
}

export interface Playbook {
  implementation_notes: string[]
  commands: string[]
  expected_outputs: string[]
  code_snippets: CodeSnippet[]
  temporary_failures_allowed: string[]
  commit: string
  rollback: string[]
  methodology?: 'test_first' | 'standard'
}

export interface Task {
  id: string
  title: string
  description?: string
  type: TaskType
  files: string[]
  depends_on: string[]
  substeps: Substep[]
  validation: ValidationCheck[]
  expected_result: string
  playbook: Playbook
  retryable?: boolean
  parallelizable?: boolean
}

export interface Phase {
  id: string
  title: string
  depends_on: string[]   // phase ids
  tasks: Task[]
}

export interface PlanSummary {
  architecture: string
  tech_stack: string[]
  spec_ref: string
}

export interface PlanFileMap {
  create: string[]
  rewrite: string[]
  delete: string[]
}

export interface DetailedPlan {
  schema_version: 2
  planner_version: number
  goal: string
  summary: PlanSummary
  file_map: PlanFileMap
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
