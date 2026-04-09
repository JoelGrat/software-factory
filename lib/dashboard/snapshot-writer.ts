// lib/dashboard/snapshot-writer.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AnalysisResultSnapshotData } from './event-types'

/**
 * Step 1 of stub-first completion: write a minimal snapshot row immediately.
 * This is the canonical completion signal. If this fails, do NOT proceed to
 * mark the change as completed — keep it running and retry.
 */
export async function writeStub(
  db: SupabaseClient,
  changeId: string,
  version: number,
  executionOutcome: 'success' | 'failure',
  analysisStatus: 'completed' | 'failed' | 'stalled'
): Promise<void> {
  const { error } = await db.from('analysis_result_snapshot').insert({
    change_id: changeId,
    version,
    execution_outcome: executionOutcome,
    snapshot_status: 'pending_enrichment',
    minimal: true,
    analysis_status: analysisStatus,
    stages_completed: [],
    files_modified: [],
    components_affected: [],
    completed_at: new Date().toISOString(),
  })
  if (error) throw error
}

/**
 * Step 2 (background): write the full analysis fields and mark the snapshot as enriched.
 * If this fails, snapshot_status becomes 'enrichment_failed' — the stub remains and the
 * UI shows a "details loading" banner. execution_outcome is never altered here.
 */
export async function enrichSnapshot(
  db: SupabaseClient,
  changeId: string,
  data: Partial<AnalysisResultSnapshotData>
): Promise<void> {
  const { error } = await db
    .from('analysis_result_snapshot')
    .update({
      snapshot_status: 'ok',
      minimal: false,
      stages_completed: data.stagesCompleted ?? [],
      files_modified: data.filesModified ?? [],
      components_affected: data.componentsAffected ?? [],
      jaccard_accuracy: data.jaccardAccuracy ?? null,
      miss_rate: data.missRate ?? null,
      model_miss: data.modelMiss ?? null,
      failure_cause: data.failureCause ?? null,
      duration_ms: data.durationMs ?? null,
    })
    .eq('change_id', changeId)
  if (error) throw error
}

/**
 * Called when enrichment fails after all retries — marks snapshot so UI can
 * show a banner without blocking the completed state.
 */
export async function markEnrichmentFailed(
  db: SupabaseClient,
  changeId: string
): Promise<void> {
  await db
    .from('analysis_result_snapshot')
    .update({ snapshot_status: 'enrichment_failed' })
    .eq('change_id', changeId)
}
