// lib/dashboard/event-types.ts

export type DashboardEventType =
  | 'queued'
  | 'started'
  | 'progress'
  | 'completed'
  | 'stalled'
  | 'resync_required'

export type DashboardEventScope = 'analysis' | 'execution' | 'system'

export interface DashboardEvent {
  type: DashboardEventType
  scope: DashboardEventScope
  changeId: string
  projectId: string
  /** Per-run counter from change_requests — discard events where this !== currentRunVersion */
  analysisVersion: number
  /** Project-level monotonic counter — used for dedup and replay ordering */
  version: number
  /** Present only on reconstructed lifecycle events — absent on real events */
  synthetic?: true
  payload: Record<string, unknown>
}

export interface ProgressPayload {
  stage: string
  pct: number
}

export interface CompletedPayload {
  outcome: 'success' | 'failure'
  /** Full snapshot included as optimization — client should not rely on this across sessions */
  snapshot?: AnalysisResultSnapshotData
}

export interface AnalysisResultSnapshotData {
  changeId: string
  version: number
  executionOutcome: 'success' | 'failure'
  snapshotStatus: 'pending_enrichment' | 'ok' | 'enrichment_failed'
  minimal: boolean
  analysisStatus: 'completed' | 'failed' | 'stalled'
  stagesCompleted: string[]
  filesModified: string[]
  componentsAffected: string[]
  jaccard_accuracy: number | null
  miss_rate: number | null
  modelMiss: {
    missed: Array<{ component_id: string; name: string }>
    overestimated: Array<{ component_id: string; name: string }>
    confidence_gap: { predicted: number; actual_severity: 'HIGH' | 'MEDIUM' | 'LOW' } | null
  } | null
  failureCause: {
    error_type: string
    component_id: string | null
    parse_confidence: number
    cascade: string[]
  } | null
  duration_ms: number | null
  completed_at: string
}
