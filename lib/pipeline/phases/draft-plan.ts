// lib/pipeline/phases/draft-plan.ts
import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import { runDraftPlan } from '@/lib/planning/draft-planner'

const PROMPT_VERSION = 'draft-plan-v1'
const DRAFT_PLAN_VERSION = 1

// Statuses that indicate the pipeline has progressed past plan generation.
// At these states, re-running the draft plan would cascade-delete downstream work.
// Callers must pass force_reset to override.
const LOCKED_STATUSES = new Set([
  'plan_generated', 'awaiting_approval', 'ready_for_execution',
  'executing', 'review', 'done',
])

export async function runDraftPlanPhase(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider,
  opts: { forceReset?: boolean } = {}
): Promise<void> {
  const startedAt = new Date().toISOString()

  // Load change
  const { data: change } = await db
    .from('change_requests')
    .select('id, title, intent, type, pipeline_status, pipeline_run_id, input_hash, draft_plan, phase_timings')
    .eq('id', changeId)
    .single()
  if (!change) throw new Error(`Change not found: ${changeId}`)

  const inputHash = createHash('sha256')
    .update(`${change.title}|${change.intent}|${change.type}`)
    .digest('hex')

  // Idempotency check — skip if already valid with same hash
  if (change.input_hash === inputHash && change.draft_plan) {
    const dp = change.draft_plan as Record<string, unknown>
    const isValid =
      Array.isArray(dp.component_names) &&
      Array.isArray(dp.new_file_paths) &&
      typeof dp.confidence === 'number'
    if (isValid) return  // already done
  }

  // Guard: if hash changed and pipeline is locked, require explicit reset
  if (change.input_hash && change.input_hash !== inputHash && LOCKED_STATUSES.has(change.pipeline_status ?? '')) {
    if (!opts.forceReset) {
      throw new Error(
        `Pipeline has progressed beyond plan generation — pass force_reset: true to restart from scratch`
      )
    }
  }

  // Guarded status transition: only proceed if status is 'validated'
  const { data: transitioned } = await db
    .from('change_requests')
    .update({ pipeline_status: 'draft_planning' })
    .eq('id', changeId)
    .eq('pipeline_status', 'validated')
    .select('id')

  if (!transitioned?.length) {
    throw new Error(`Cannot start draft plan phase: expected pipeline_status 'validated', got '${change.pipeline_status}'`)
  }

  try {
    // If hash changed, cascade-reset downstream data
    if (change.input_hash && change.input_hash !== inputHash) {
      await db.from('change_plans').delete().eq('change_id', changeId)  // tasks cascade
      await db.from('change_risk_factors').delete().eq('change_id', changeId)
      await db.from('change_impacts').delete().eq('change_id', changeId)  // components cascade
    }

    // Run AI
    const result = await runDraftPlan(change, ai)
    const completedAt = new Date().toISOString()
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime()

    // Persist
    const runId = crypto.randomUUID()
    await db.from('change_requests').update({
      pipeline_run_id: runId,
      input_hash: inputHash,
      draft_plan: {
        new_file_paths: result.new_file_paths,
        component_names: result.component_names,
        assumptions: result.assumptions,
        confidence: result.confidence,
        created_at: completedAt,
        model_version: 'claude-sonnet-4-6',
        prompt_version: PROMPT_VERSION,
        draft_plan_version: DRAFT_PLAN_VERSION,
        input_hash: inputHash,
      },
      pipeline_status: 'draft_planned',
      phase_timings: {
        ...(change as any).phase_timings,
        draft_plan: { started_at: startedAt, completed_at: completedAt, duration_ms: durationMs },
      },
    }).eq('id', changeId)

  } catch (err) {
    await db.from('change_requests').update({
      pipeline_status: 'failed_at_draft_plan',
      failed_phase: 'draft_plan',
    }).eq('id', changeId)
    throw err
  }
}
