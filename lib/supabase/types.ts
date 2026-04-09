// lib/supabase/types.ts

// ── Shared enums ──────────────────────────────────────────────────────────────

export type ScanStatus         = 'pending' | 'scanning' | 'ready' | 'failed'
export type ComponentType      = 'service' | 'module' | 'api' | 'db' | 'ui'
export type ComponentStatus    = 'stable' | 'unstable'
export type AssignmentStatus   = 'assigned' | 'unassigned'
export type EdgeType           =
  | 'static' | 're-export'
  | 'dynamic-static-string' | 'dynamic-template' | 'dynamic-computed'
export type DependencyType     = 'sync' | 'async' | 'data' | 'api'
export type EvolutionSignalType = 'split' | 'merge'

export type ChangeType         = 'bug' | 'feature' | 'refactor' | 'hotfix'
export type ChangePriority     = 'low' | 'medium' | 'high'
export type ChangeStatus       =
  | 'open' | 'analyzing' | 'analyzing_mapping'
  | 'analyzing_propagation' | 'analyzing_scoring'
  | 'analyzed' | 'planned' | 'executing' | 'review' | 'done' | 'failed'
export type RiskLevel          = 'low' | 'medium' | 'high'
export type AnalysisQuality    = 'high' | 'medium' | 'low'
export type DecisionStage      = 'analysis' | 'planning' | 'execution'
export type PlanStatus         = 'draft' | 'approved' | 'rejected'
export type PlanTaskStatus     = 'pending' | 'done' | 'failed'
export type TerminationReason  = 'passed' | 'max_iterations' | 'cancelled' | 'error'
export type ContextMode        = 'symbol' | 'multi-symbol' | 'file'
export type FailureType        = 'syntax' | 'type' | 'runtime' | 'test' | 'timeout'
export type ExecutionStrategy  = 'initial' | 'escalated' | 'propagation'
export type DeploymentEnv      = 'staging' | 'prod'
export type AnalysisStatus     = 'pending' | 'running' | 'completed' | 'failed' | 'stalled'
export type DeploymentStatus   = 'pending' | 'deployed' | 'failed'
export type ProductionEventType     = 'error' | 'performance' | 'usage'
export type ProductionEventSeverity = 'low' | 'high' | 'critical'
export type EventRelationType  = 'caused_by' | 'resolved_by'
export type ImpactSource       = 'directly_mapped' | 'via_dependency' | 'via_file'
export type TriggeredBy        = 'user' | 'system' | 'production_event'

// ── Project ───────────────────────────────────────────────────────────────────

export interface Project {
  id:           string
  name:         string
  owner_id:     string
  repo_url:     string | null
  repo_token:   string | null
  scan_status:  ScanStatus
  scan_error:   string | null
  lock_version: number
  created_at:   string
}

// ── System model ──────────────────────────────────────────────────────────────

export interface ProjectFile {
  id:         string
  project_id: string
  path:       string
  hash:       string | null
}

export interface SystemComponent {
  id:                 string
  project_id:         string
  name:               string
  type:               ComponentType
  exposed_interfaces: string[]
  status:             ComponentStatus
  is_anchored:        boolean
  scan_count:         number
  last_updated:       string
  deleted_at:         string | null
}

export interface ComponentAssignment {
  file_id:            string
  component_id:       string | null
  confidence:         number
  is_primary:         boolean
  status:             AssignmentStatus
  reassignment_count: number
  last_validated_at:  string
  last_moved_at:      string
}

export interface ComponentDependency {
  from_id:    string
  to_id:      string
  type:       DependencyType
  deleted_at: string | null
}

export interface SystemComponentVersion {
  id:           string
  component_id: string
  version:      number
  snapshot:     Record<string, unknown>
  created_at:   string
}

export interface ComponentTest {
  id:           string
  component_id: string
  test_path:    string
}

export interface TestCoverageMap {
  test_path: string
  file_id:   string
}

export interface ComponentGraphEdge {
  from_file_id: string
  to_file_id:   string
  project_id:   string
  edge_type:    EdgeType
}

export interface ComponentEvolutionSignal {
  id:                  string
  component_id:        string
  type:                EvolutionSignalType
  target_component_id: string | null
  confidence:          number
  created_at:          string
  expires_at:          string
}

// ── Change layer ──────────────────────────────────────────────────────────────

export interface ConfidenceBreakdown {
  mapping_confidence:    number
  model_completeness:    number
  dependency_coverage:   number
}

export interface ChangeRequest {
  id:                   string
  project_id:           string
  title:                string
  intent:               string
  type:                 ChangeType
  priority:             ChangePriority
  status:               ChangeStatus
  risk_level:           RiskLevel | null
  confidence_score:     number | null
  confidence_breakdown: ConfidenceBreakdown | null
  analysis_quality:     AnalysisQuality | null
  lock_version:         number
  execution_group:      string | null
  created_by:           string | null
  triggered_by:         TriggeredBy
  tags:                 string[]
  created_at:           string
  updated_at:           string
}

export interface ChangeRequestComponent {
  change_id:    string
  component_id: string
}

export interface ChangeRequestFile {
  change_id: string
  file_id:   string
}

export interface ChangeRiskFactor {
  id:        string
  change_id: string
  factor:    string
  weight:    number
}

export interface ChangeDecision {
  id:              string
  change_id:       string
  stage:           DecisionStage
  decision_type:   string
  rationale:       string | null
  input_snapshot:  Record<string, unknown> | null
  output_snapshot: Record<string, unknown> | null
  created_at:      string
}

export interface ChangeSystemSnapshotComponent {
  change_id:            string
  component_version_id: string
}

export interface ChangeImpact {
  id:                   string
  change_id:            string
  risk_score:           number
  blast_radius:         number
  primary_risk_factor:  string | null
  analysis_quality:     AnalysisQuality
  requires_migration:   boolean
  requires_data_change: boolean
}

export interface ChangeImpactComponent {
  impact_id:     string
  component_id:  string
  impact_weight: number
  source:        ImpactSource
  source_detail: string | null
}

export interface ChangeImpactFile {
  impact_id: string
  file_id:   string
}

export interface ChangePlan {
  id:              string
  change_id:       string
  status:          PlanStatus
  spec_markdown:   string | null
  estimated_tasks: number | null
  estimated_files: number | null
  created_at:      string
  approved_at:     string | null
}

export interface ChangePlanTask {
  id:          string
  plan_id:     string
  component_id: string | null
  description: string
  order_index: number
  status:      PlanTaskStatus
}

// ── Execution layer ───────────────────────────────────────────────────────────

export interface ExecutionSnapshot {
  id:                 string
  change_id:          string
  iteration:          number
  files_modified:     string[]
  tests_run:          string[]
  tests_passed:       number
  tests_failed:       number
  error_summary:      string | null
  diff_summary:       string | null
  duration_ms:        number | null
  retry_count:        number
  ai_cost:            number | null
  environment:        string | null
  termination_reason: TerminationReason | null
}

export interface FileLock {
  file_id:   string
  change_id: string
  locked_at: string
}

// ── Outcome + deployment ──────────────────────────────────────────────────────

export interface ChangeCommit {
  id:          string
  change_id:   string
  branch_name: string
  commit_hash: string
  created_at:  string
}

export interface ChangeOutcome {
  change_id:            string
  success:              boolean
  regressions_detected: boolean
  rollback_triggered:   boolean
  user_feedback:        string | null
  created_at:           string
}

export interface Deployment {
  id:          string
  project_id:  string
  change_id:   string
  environment: DeploymentEnv
  status:      DeploymentStatus
  commit_hash: string | null
  deployed_at: string | null
}

// ── Production layer ──────────────────────────────────────────────────────────

export interface ProductionEvent {
  id:         string
  project_id: string
  type:       ProductionEventType
  source:     string
  severity:   ProductionEventSeverity
  payload:    Record<string, unknown>
  created_at: string
}

export interface ProductionEventComponent {
  event_id:     string
  component_id: string
}

export interface ProductionEventLink {
  event_id:      string
  change_id:     string
  relation_type: EventRelationType
}
