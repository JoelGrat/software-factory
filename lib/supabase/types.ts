export type RequirementStatus =
  | 'draft'
  | 'analyzing'
  | 'incomplete'
  | 'review_required'
  | 'ready_for_dev'
  | 'blocked'

export type RequirementDomain = 'saas' | 'fintech' | 'workflow' | 'general'

export type GapSeverity  = 'critical' | 'major' | 'minor'
export type GapCategory  = 'missing' | 'ambiguous' | 'conflicting' | 'incomplete'
export type GapSource    = 'rule' | 'ai' | 'relation'
export type RelationType = 'depends_on' | 'conflicts_with' | 'refines'
export type NfrCategory  = 'security' | 'performance' | 'auditability'
export type TargetRole   = 'ba' | 'architect' | 'po' | 'dev'
export type TaskStatus   = 'open' | 'in-progress' | 'resolved' | 'dismissed'
export type QuestionStatus = 'open' | 'answered' | 'dismissed'
export type ItemType     = 'functional' | 'non-functional' | 'constraint' | 'assumption'

export interface Project {
  id: string
  name: string
  owner_id: string
  created_at: string
}

export interface Requirement {
  id: string
  project_id: string
  title: string
  raw_input: string
  domain: RequirementDomain | null
  status: RequirementStatus
  blocked_reason: string | null
  created_at: string
  updated_at: string
}

export interface RequirementItem {
  id: string
  requirement_id: string
  type: ItemType
  title: string
  description: string
  priority: 'high' | 'medium' | 'low'
  source_text: string | null
  nfr_category: NfrCategory | null
  created_at: string
}

export interface RequirementRelation {
  id: string
  source_id: string
  target_id: string
  type: RelationType
  detected_by: 'rule' | 'ai'
  created_at: string
}

export interface Gap {
  id: string
  requirement_id: string
  item_id: string | null
  severity: GapSeverity
  category: GapCategory
  description: string
  source: GapSource
  rule_id: string | null
  priority_score: number
  confidence: number
  validated: boolean
  validated_by: string | null
  question_generated: boolean
  merged_into: string | null
  resolved_at: string | null
  resolution_source:
    | 'question_answered'
    | 'task_resolved'
    | 'decision_recorded'
    | 'risk_accepted'
    | 'dismissed'
    | null
  created_at: string
}

export interface RiskAcceptance {
  id: string
  gap_id: string
  accepted_by: string
  rationale: string
  expires_at: string | null
  created_at: string
}

export interface Question {
  id: string
  gap_id: string
  requirement_id: string
  question_text: string
  target_role: TargetRole
  status: QuestionStatus
  answer: string | null
  answered_at: string | null
  created_at: string
}

export interface InvestigationTask {
  id: string
  requirement_id: string
  linked_gap_id: string | null
  title: string
  description: string
  priority: 'high' | 'medium' | 'low'
  status: TaskStatus
  created_at: string
}

export interface AuditLog {
  id: string
  entity_type: string
  entity_id: string
  action: 'created' | 'updated' | 'deleted' | 'analyzed' | 'scored' | 'risk_accepted'
  actor_id: string | null
  diff: Record<string, unknown> | null
  created_at: string
}

export interface DecisionLog {
  id: string
  requirement_id: string
  related_gap_id: string | null
  related_question_id: string | null
  decision: string
  rationale: string
  decided_by: string
  created_at: string
}

export interface AiUsageLog {
  id: string
  requirement_id: string | null
  pipeline_step: string
  provider: string
  model: string
  input_tokens: number
  output_tokens: number
  latency_ms: number
  retry_count: number
  created_at: string
}

export interface KnowledgeCase {
  id: string
  project_id: string | null
  requirement_item_snapshot: Record<string, unknown>
  gap_snapshot: Record<string, unknown>
  resolution_snapshot: Record<string, unknown>
  context_tags: string[]
  embedding: number[] | null
  created_at: string
}

export interface CaseFeedback {
  id: string
  case_id: string
  user_id: string
  helpful: boolean
  used: boolean
  overridden: boolean
  created_at: string
}

export interface CompletenessScore {
  id: string
  requirement_id: string
  // Primary signals (shown in UI)
  blocking_count: number
  high_risk_count: number
  coverage_pct: number
  // Secondary (internal)
  internal_score: number
  nfr_score: number
  // Risk
  complexity_score: number
  risk_flags: string[]
  // Metadata
  gap_density: number
  breakdown: ScoreBreakdown
  scored_at: string
}

export interface ScoreBreakdown {
  blocking_count: number
  high_risk_count: number
  coverage_pct: number
  internal_score: number
  nfr_score: number
  gap_density: number
  complexity_score: number
  risk_flags: string[]
  gap_counts: { critical: number; major: number; minor: number; unvalidated: number }
  nfr_coverage: { security: boolean; performance: boolean; auditability: boolean }
}

export interface RequirementSummary {
  blocking_count: number
  high_risk_count: number
  coverage_pct: number
  unvalidated_count: number
  internal_score: number
  complexity_score: number
  risk_flags: string[]
  status: RequirementStatus
  blocked_reason: string | null
}
