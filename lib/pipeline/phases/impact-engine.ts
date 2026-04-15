// lib/pipeline/phases/impact-engine.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import { runImpactAnalysis } from '@/lib/impact/impact-analyzer'
import { extractPlanSeeds } from '@/lib/planning/impact-seeder'
import type { DetailedPlan } from '@/lib/planning/types'

export async function runImpactEnginePhase(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider
): Promise<void> {
  const startedAt = new Date().toISOString()

  const { data: change, error } = await db
    .from('change_requests')
    .select('id, pipeline_status, phase_timings')
    .eq('id', changeId)
    .single()
  if (error || !change) throw new Error(`Change not found: ${changeId}`)

  if (change.pipeline_status !== 'plan_generated') {
    throw new Error(
      `Cannot start impact analysis: expected pipeline_status 'plan_generated', got '${change.pipeline_status}'`
    )
  }

  // Load plan_json to extract seeds
  const { data: planRow } = await db
    .from('change_plans')
    .select('plan_json')
    .eq('change_id', changeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const planJson = planRow?.plan_json as DetailedPlan | null
  const seeds = planJson
    ? extractPlanSeeds(planJson)
    : { filePaths: [], componentHints: [], hasMigration: false, commands: [] }

  // Guarded status transition
  const { data: transitioned } = await db
    .from('change_requests')
    .update({ pipeline_status: 'impact_analyzing' })
    .eq('id', changeId)
    .eq('pipeline_status', 'plan_generated')
    .select('id')
  if (!transitioned?.length) {
    throw new Error('Impact analysis transition failed: concurrent execution detected')
  }

  try {
    await runImpactAnalysis(changeId, db, ai, {
      new_file_paths: seeds.filePaths,
      component_names: seeds.componentHints,
      assumptions: [],
    })

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
      pipeline_status: 'failed',
      failed_stage: 'impact',
    }).eq('id', changeId)
    throw err
  }
}
