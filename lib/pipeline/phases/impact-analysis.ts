// lib/pipeline/phases/impact-analysis.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import { runImpactAnalysis } from '@/lib/impact/impact-analyzer'

export async function runImpactAnalysisPhase(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider
): Promise<void> {
  const startedAt = new Date().toISOString()

  // Load change to check preconditions
  const { data: change, error: loadErr } = await db
    .from('change_requests')
    .select('id, pipeline_status, input_hash, draft_plan, phase_timings')
    .eq('id', changeId)
    .single()
  if (loadErr) throw new Error(`Failed to load change ${changeId}: ${loadErr.message}`)
  if (!change) throw new Error(`Change not found: ${changeId}`)

  // Precondition: pipeline_status must be 'draft_planned'
  if (change.pipeline_status !== 'draft_planned') {
    throw new Error(`Cannot start impact analysis: expected pipeline_status 'draft_planned', got '${change.pipeline_status}'`)
  }

  // Read draft_plan if present — tolerate missing (pre-pipeline changes or manual re-trigger)
  const dp = change.draft_plan as Record<string, unknown> | null
  const draftPlanValid =
    dp !== null &&
    Array.isArray(dp.component_names) &&
    dp.component_names.length > 0 &&
    Array.isArray(dp.new_file_paths) &&
    typeof dp.confidence === 'number'

  // Guarded status transition
  const { data: transitioned } = await db
    .from('change_requests')
    .update({ pipeline_status: 'impact_analyzing' })
    .eq('id', changeId)
    .eq('pipeline_status', 'draft_planned')
    .select('id')
  if (!transitioned?.length) {
    throw new Error(`Impact analysis status transition failed: concurrent execution detected`)
  }

  try {
    const draftPlan = draftPlanValid && dp ? {
      new_file_paths: dp.new_file_paths as string[],
      component_names: dp.component_names as string[],
      assumptions: Array.isArray(dp.assumptions) ? dp.assumptions as string[] : [],
    } : { new_file_paths: [], component_names: [], assumptions: [] }

    // runImpactAnalysis handles its own status updates and writes
    // change_impacts / change_impact_components / change_risk_factors
    await runImpactAnalysis(changeId, db, ai, draftPlan)

    const completedAt = new Date().toISOString()
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime()

    await db.from('change_requests').update({
      pipeline_status: 'impact_analyzed',
      phase_timings: {
        ...(change.phase_timings as Record<string, unknown> ?? {}),
        impact_analysis: { started_at: startedAt, completed_at: completedAt, duration_ms: durationMs },
      },
    }).eq('id', changeId)

  } catch (err) {
    await db.from('change_requests').update({
      pipeline_status: 'failed_at_impact_analysis',
      failed_phase: 'impact_analysis',
    }).eq('id', changeId)
    throw err
  }
}
