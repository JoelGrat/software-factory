// lib/planning/planning-repository.ts
// Sole owner of all Supabase reads/writes for the planning pipeline.
// Generators and scorers produce plain objects; this module persists them.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChangeSpec, DetailedPlan, PlannerFailure, PlannerStage } from './types'
import type { ProjectedTask } from './human-task-view'

// ---- Spec ----

export async function createSpec(
  db: SupabaseClient,
  changeId: string,
  spec: ChangeSpec,
  markdown: string,
  version: number
): Promise<{ id: string }> {
  const { data, error } = await db
    .from('change_specs')
    .insert({ change_id: changeId, version, structured: spec, markdown })
    .select('id')
    .single()
  if (error || !data) throw new Error(`Failed to create spec: ${error?.message}`)
  return data
}

export async function loadSpecForChange(
  db: SupabaseClient,
  changeId: string
): Promise<{ id: string; structured: ChangeSpec; markdown: string } | null> {
  const { data } = await db
    .from('change_specs')
    .select('id, structured, markdown')
    .eq('change_id', changeId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as any) ?? null
}

// ---- Plan ----

export async function createPlan(
  db: SupabaseClient,
  changeId: string,
  branchName: string,
  planJson: DetailedPlan,
  plannerVersion: number
): Promise<{ id: string }> {
  const { data, error } = await db
    .from('change_plans')
    .insert({
      change_id: changeId,
      status: 'draft',
      branch_name: branchName,
      plan_json: planJson,
      version: 1,
      planner_version: plannerVersion,
      started_at: new Date().toISOString(),
      current_stage: 'plan',
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`Failed to create plan: ${error?.message}`)
  return data
}

export async function updatePlanStage(
  db: SupabaseClient,
  planId: string,
  stage: PlannerStage,
  stageDurations: Record<string, number>
): Promise<void> {
  await db.from('change_plans').update({
    current_stage: stage,
    stage_durations: stageDurations,
  }).eq('id', planId)
}

export async function finalizePlan(
  db: SupabaseClient,
  planId: string,
  qualityScore: number
): Promise<void> {
  await db.from('change_plans').update({
    current_stage: 'policy',
    plan_quality_score: qualityScore,
    ended_at: new Date().toISOString(),
  }).eq('id', planId)
}

export async function loadPlanForChange(
  db: SupabaseClient,
  changeId: string
): Promise<{
  id: string
  plan_json: DetailedPlan
  branch_name: string
  planner_version: number
  stage_durations: Record<string, number>
} | null> {
  const { data } = await db
    .from('change_plans')
    .select('id, plan_json, branch_name, planner_version, stage_durations')
    .eq('change_id', changeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as any) ?? null
}

// ---- Task projection ----

/**
 * Delete all task rows for this plan and rebuild from scratch.
 * Never patch incrementally — plan_json is the source of truth.
 */
export async function rebuildTaskProjection(
  db: SupabaseClient,
  planId: string,
  planVersion: number,
  tasks: ProjectedTask[]
): Promise<void> {
  await db.from('change_plan_tasks').delete().eq('plan_id', planId)

  if (tasks.length === 0) return

  const rows = tasks.map(t => ({
    plan_id: planId,
    plan_task_id: t.planTaskId,
    phase_id: t.phaseId,
    description: t.title,
    order_index: t.orderIndex,
    status: t.status,
    plan_version: planVersion,
  }))
  const { error } = await db.from('change_plan_tasks').insert(rows)
  if (error) throw new Error(`Failed to rebuild task projection: ${error.message}`)
}

// ---- Failure ----

export async function recordPlanFailure(
  db: SupabaseClient,
  changeId: string,
  planId: string | null,
  failure: PlannerFailure
): Promise<void> {
  await db.from('change_requests').update({
    pipeline_status: 'failed',
    failed_stage: failure.stage,
    retryable: failure.retryable,
    failure_diagnostics: failure,
  }).eq('id', changeId)
  if (planId) {
    await db.from('change_plans').update({
      failed_stage: failure.stage,
      ended_at: new Date().toISOString(),
    }).eq('id', planId)
  }
}

// ---- Status transitions ----

export async function updatePipelineStatus(
  db: SupabaseClient,
  changeId: string,
  status: string,
  extraFields?: Record<string, unknown>
): Promise<void> {
  await db.from('change_requests').update({
    pipeline_status: status,
    ...extraFields,
  }).eq('id', changeId)
}

export async function guardedStatusTransition(
  db: SupabaseClient,
  changeId: string,
  fromStatus: string,
  toStatus: string
): Promise<boolean> {
  const { data } = await db
    .from('change_requests')
    .update({ pipeline_status: toStatus })
    .eq('id', changeId)
    .eq('pipeline_status', fromStatus)
    .select('id')
  return (data?.length ?? 0) > 0
}
