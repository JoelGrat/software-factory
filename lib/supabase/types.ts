export type RequirementStatus =
  | 'draft'
  | 'analyzing'
  | 'incomplete'
  | 'review_required'
  | 'ready_for_dev'
  | 'blocked'

export type GapSeverity = 'critical' | 'major' | 'minor'
export type GapCategory = 'missing' | 'ambiguous' | 'conflicting' | 'incomplete'
export type GapSource = 'rule' | 'ai' | 'pattern'
export type NfrCategory = 'security' | 'performance' | 'auditability'
export type TargetRole = 'ba' | 'architect' | 'po' | 'dev'
export type TaskStatus = 'open' | 'in-progress' | 'resolved' | 'dismissed'
export type QuestionStatus = 'open' | 'answered' | 'dismissed'
export type ItemType = 'functional' | 'non-functional' | 'constraint' | 'assumption'

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
  question_generated: boolean
  merged_into: string | null
  resolved_at: string | null
  resolution_source: 'question_answered' | 'task_resolved' | 'decision_recorded' | null
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
  action: 'created' | 'updated' | 'deleted' | 'analyzed' | 'scored'
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

export interface CompletenessScore {
  id: string
  requirement_id: string
  overall_score: number
  completeness: number
  nfr_score: number
  confidence: number
  breakdown: ScoreBreakdown
  scored_at: string
}

export interface ScoreBreakdown {
  completeness: number
  nfr_score: number
  overall: number
  confidence: number
  gap_counts: { critical: number; major: number; minor: number }
  nfr_coverage: { security: boolean; performance: boolean; auditability: boolean }
}

export interface GapPattern {
  id: string
  project_id: string | null
  category: GapCategory
  severity: GapSeverity
  description_template: string
  occurrence_count: number
  last_seen_at: string
  created_at: string
}

export interface ResolutionPattern {
  id: string
  gap_pattern_id: string
  project_id: string | null
  resolution_summary: string
  source_decision_id: string | null
  use_count: number
  created_at: string
}

export interface DomainTemplate {
  id: string
  project_id: string | null
  domain: string
  name: string
  requirement_areas: RequirementAreas
  created_at: string
}

export interface RequirementAreas {
  functional: string[]
  nfr: NfrCategory[]
}

export interface RequirementSummary {
  critical_count: number
  major_count: number
  minor_count: number
  completeness: number
  confidence: number
  overall_score: number
  status: RequirementStatus
  blocked_reason: string | null
}
