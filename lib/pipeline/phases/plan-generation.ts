// lib/pipeline/phases/plan-generation.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import { runPlanGeneration } from '@/lib/planning/plan-generator'
import { validateTasks } from '@/lib/planning/task-validator'
import type { ValidatableTask, ImpactedComponentForValidation } from '@/lib/planning/task-validator'

const RISK_QUALITY_CAPS: Record<string, number> = {
  low: 1.0,
  medium: 0.8,
  high: 0.6,
}

export async function runPlanGenerationPhase(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider
): Promise<void> {
  const startedAt = new Date().toISOString()

  const { data: change } = await db
    .from('change_requests')
    .select('id, pipeline_status, input_hash, draft_plan, risk_level, phase_timings')
    .eq('id', changeId)
    .single()
  if (!change) throw new Error(`Change not found: ${changeId}`)

  // Precondition: pipeline_status
  if (change.pipeline_status !== 'impact_analyzed') {
    throw new Error(`Cannot generate plan: expected pipeline_status 'impact_analyzed', got '${change.pipeline_status}'`)
  }

  // Precondition: draft_plan exists and hash matches
  const dp = change.draft_plan as Record<string, unknown> | null
  if (!dp) throw new Error('Cannot generate plan: draft_plan is missing')
  if (dp.input_hash !== change.input_hash) {
    throw new Error('Cannot generate plan: draft_plan is stale — re-run draft plan phase')
  }

  // Precondition: change_impacts exists
  const { data: impact } = await db
    .from('change_impacts')
    .select('id')
    .eq('change_id', changeId)
    .maybeSingle()
  if (!impact) throw new Error('Cannot generate plan: no impact analysis found — re-run impact analysis phase')

  // Guarded transition
  const { data: transitioned } = await db
    .from('change_requests')
    .update({ pipeline_status: 'plan_generating' })
    .eq('id', changeId)
    .eq('pipeline_status', 'impact_analyzed')
    .select('id')
  if (!transitioned?.length) {
    throw new Error('Plan generation status transition failed: concurrent execution detected')
  }

  try {
    // runPlanGeneration does the core AI work and inserts change_plans + change_plan_tasks.
    await runPlanGeneration(changeId, db, ai)

    // Load the generated plan and tasks for validation
    const { data: plan } = await db
      .from('change_plans')
      .select('id, estimated_tasks, validation_log, plan_quality_score')
      .eq('change_id', changeId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!plan) throw new Error('Plan generation produced no plan row')

    const { data: rawTasks } = await db
      .from('change_plan_tasks')
      .select('id, component_id, description, order_index, new_file_path')
      .eq('plan_id', plan.id)
      .order('order_index', { ascending: true })

    // change_impact_components joins via change_impacts (impact_id), not directly via change_id
    const { data: impactComponents } = await db
      .from('change_impact_components')
      .select('component_id, impact_weight')
      .eq('impact_id', impact.id)
      .order('impact_weight', { ascending: false })
      .limit(10)

    const validationComponents: ImpactedComponentForValidation[] = (impactComponents ?? []).map((c: any) => ({
      componentId: c.component_id,
      weight: c.impact_weight,
    }))

    const validationTasks: ValidatableTask[] = (rawTasks ?? []).map((t: any) => ({
      componentId: t.component_id,
      componentName: 'Unknown',
      newFilePath: t.new_file_path,
      description: t.description,
      orderIndex: t.order_index,
    }))

    const validationLog: Array<{ attempt: number; passed: boolean; errors: string[]; warnings: string[]; timestamp: string }> = []
    const result1 = validateTasks(validationTasks, validationComponents, new Set(), new Set())
    validationLog.push({ attempt: 1, passed: result1.passed, errors: result1.errors, warnings: result1.warnings, timestamp: new Date().toISOString() })

    let qualityScore = computeQualityScore(result1.passed, 1, result1.warnings.length, validationComponents, validationTasks)
    const riskCap = RISK_QUALITY_CAPS[(change.risk_level as string) ?? 'low'] ?? 1.0
    qualityScore = Math.min(qualityScore, riskCap)

    await db.from('change_plans').update({
      validation_log: validationLog,
      plan_quality_score: qualityScore,
    }).eq('id', plan.id)

    const completedAt = new Date().toISOString()
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime()

    await db.from('change_requests').update({
      pipeline_status: 'plan_generated',
      phase_timings: {
        ...(change.phase_timings as Record<string, unknown> ?? {}),
        plan_generation: { started_at: startedAt, completed_at: completedAt, duration_ms: durationMs, attempt_count: 1 },
      },
    }).eq('id', changeId)

  } catch (err) {
    await db.from('change_requests').update({
      pipeline_status: 'failed_at_plan_generation',
      failed_phase: 'plan_generation',
    }).eq('id', changeId)
    throw err
  }
}

function computeQualityScore(
  passed: boolean,
  attemptCount: number,
  warningCount: number,
  components: ImpactedComponentForValidation[],
  tasks: ValidatableTask[]
): number {
  let score = 1.0
  if (attemptCount === 3) score -= 0.2   // fallback used
  if (attemptCount >= 2) score -= 0.1    // at least one retry
  score -= warningCount * 0.05

  // Coverage penalty
  const totalWeight = components.reduce((s, c) => s + c.weight, 0)
  const taskCompIds = new Set(tasks.map(t => t.componentId).filter(Boolean))
  const coveredWeight = components.filter(c => taskCompIds.has(c.componentId)).reduce((s, c) => s + c.weight, 0)
  if (totalWeight > 0 && coveredWeight / totalWeight < 0.8) score -= 0.15

  return Math.max(0.1, score)
}
