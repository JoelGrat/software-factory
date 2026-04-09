// lib/dashboard/event-types.ts

import type { AnalysisStatus } from '@/lib/supabase/types'

export type DashboardEventType =
  | 'queued'
  | 'started'
  | 'progress'
  | 'completed'
  | 'stalled'
  | 'resync_required'

export type DashboardEventScope = 'analysis' | 'execution' | 'system'

/** Analysis statuses that can appear on a completed snapshot (never pending or running) */
export type TerminalAnalysisStatus = Exclude<AnalysisStatus, 'pending' | 'running'>

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
  /** Use PayloadFor<T> to narrow payload type by event type in consumers */
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

/** Maps each event type to its expected payload shape */
export type PayloadFor<T extends DashboardEventType> =
  T extends 'progress' ? ProgressPayload :
  T extends 'completed' ? CompletedPayload :
  Record<string, unknown>

export interface AnalysisResultSnapshotData {
  changeId: string
  version: number
  executionOutcome: 'success' | 'failure'
  snapshotStatus: 'pending_enrichment' | 'ok' | 'enrichment_failed'
  minimal: boolean
  analysisStatus: TerminalAnalysisStatus
  stagesCompleted: string[]
  filesModified: string[]
  componentsAffected: string[]
  jaccardAccuracy: number | null
  missRate: number | null
  modelMiss: {
    missed: Array<{ componentId: string; name: string }>
    overestimated: Array<{ componentId: string; name: string }>
    confidenceGap: { predicted: number; actualSeverity: 'HIGH' | 'MEDIUM' | 'LOW' } | null
  } | null
  failureCause: {
    error_type: string
    component_id: string | null
    parse_confidence: number
    cascade: string[]
  } | null
  durationMs: number | null
  completedAt: string
}
