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
  const { data: change } = await db
    .from('change_requests')
    .select('id, pipeline_status, input_hash, draft_plan, phase_timings')
    .eq('id', changeId)
    .single()
  if (!change) throw new Error(`Change not found: ${changeId}`)

  // Precondition: pipeline_status must be 'draft_planned'
  if (change.pipeline_status !== 'draft_planned') {
    throw new Error(`Cannot start impact analysis: expected pipeline_status 'draft_planned', got '${change.pipeline_status}'`)
  }

  // Precondition: draft_plan must exist and be valid
  const dp = change.draft_plan as Record<string, unknown> | null
  if (!dp) throw new Error('Cannot start impact analysis: draft_plan is missing — re-run draft plan phase')
  if (!Array.isArray(dp.component_names) || dp.component_names.length === 0) {
    throw new Error('Cannot start impact analysis: draft_plan.component_names is empty or invalid — re-run draft plan phase')
  }
  if (!Array.isArray(dp.new_file_paths)) {
    throw new Error('Cannot start impact analysis: draft_plan.new_file_paths is invalid — re-run draft plan phase')
  }
  if (typeof dp.confidence !== 'number') {
    throw new Error('Cannot start impact analysis: draft_plan.confidence is invalid — re-run draft plan phase')
  }
  if ((dp as any).input_hash !== change.input_hash) {
    throw new Error('Cannot start impact analysis: draft_plan is stale (hash mismatch) — re-run draft plan phase')
  }

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
    const draftPlan = {
      new_file_paths: dp.new_file_paths as string[],
      component_names: dp.component_names as string[],
      assumptions: Array.isArray(dp.assumptions) ? dp.assumptions as string[] : [],
    }

    // runImpactAnalysis handles its own status updates and writes
    // change_impacts / change_impact_components / change_risk_factors
    await runImpactAnalysis(changeId, db, ai, draftPlan)

    const completedAt = new Date().toISOString()
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime()

    await db.from('change_requests').update({
      pipeline_status: 'impact_analyzed',
      phase_timings: {
        ...(change as any).phase_timings,
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
