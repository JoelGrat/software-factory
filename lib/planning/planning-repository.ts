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
  markdown: string
): Promise<{ id: string }> {
  const { data: existing, error: versionError } = await db
    .from('change_specs')
    .select('version')
    .eq('change_id', changeId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (versionError) throw new Error(`Failed to resolve spec version: ${versionError.message}`)
  const version = ((existing as { version: number } | null)?.version ?? 0) + 1

  const { data, error } = await db
    .from('change_specs')
    .insert({ change_id: changeId, version, structured: spec, markdown })
    .select('id')
    .single()
  if (error || !data) throw new Error(`Failed to create spec: ${error?.message}`)
  return data as { id: string }
}

export async function loadSpecForChange(
  db: SupabaseClient,
  changeId: string
): Promise<{ id: string; structured: ChangeSpec; markdown: string } | null> {
  const { data, error } = await db
    .from('change_specs')
    .select('id, structured, markdown')
    .eq('change_id', changeId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Failed to load spec: ${error.message}`)
  return data as { id: string; structured: ChangeSpec; markdown: string } | null
}

// ---- Plan ----

export async function createPlan(
  db: SupabaseClient,
  changeId: string,
  branchName: string,
  plannerVersion: number
): Promise<{ id: string }> {
  const { data, error } = await db
    .from('change_plans')
    .insert({
      change_id: changeId,
      status: 'draft',
      branch_name: branchName,
      version: 1,
      planner_version: plannerVersion,
      started_at: new Date().toISOString(),
      current_stage: 'spec',
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`Failed to create plan: ${error?.message}`)
  return data as { id: string }
}

export async function updatePlanStage(
  db: SupabaseClient,
  planId: string,
  stage: PlannerStage,
  durationMs: number
): Promise<void> {
  const { data: current, error: readError } = await db
    .from('change_plans')
    .select('stage_durations')
    .eq('id', planId)
    .single()
  if (readError) throw new Error(`Failed to read plan stage durations: ${readError.message}`)
  const existing = (current as { stage_durations: Record<string, number> | null } | null)?.stage_durations ?? {}
  const merged = { ...existing, [stage]: durationMs }

  const { error } = await db
    .from('change_plans')
    .update({ current_stage: stage, stage_durations: merged })
    .eq('id', planId)
  if (error) throw new Error(`Failed to update plan stage: ${error.message}`)
}

export async function finalizePlan(
  db: SupabaseClient,
  planId: string,
  planJson: DetailedPlan,
  qualityScore: number
): Promise<void> {
  const { error } = await db.from('change_plans').update({
    plan_json: planJson,
    current_stage: 'policy',
    plan_quality_score: qualityScore,
    ended_at: new Date().toISOString(),
  }).eq('id', planId)
  if (error) throw new Error(`Failed to finalize plan: ${error.message}`)
}

export async function setPlanJson(
  db: SupabaseClient,
  planId: string,
  planJson: DetailedPlan
): Promise<void> {
  const { error } = await db
    .from('change_plans')
    .update({ plan_json: planJson })
    .eq('id', planId)
  if (error) throw new Error(`Failed to set plan JSON: ${error.message}`)
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
  const { data, error } = await db
    .from('change_plans')
    .select('id, plan_json, branch_name, planner_version, stage_durations')
    .eq('change_id', changeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Failed to load plan: ${error.message}`)
  return data as {
    id: string
    plan_json: DetailedPlan
    branch_name: string
    planner_version: number
    stage_durations: Record<string, number>
  } | null
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
  const { error: deleteError } = await db
    .from('change_plan_tasks')
    .delete()
    .eq('plan_id', planId)
  if (deleteError) throw new Error(`Failed to delete task projection: ${deleteError.message}`)

  if (tasks.length === 0) return

  const rows = tasks.map(t => ({
    plan_id: planId,
    plan_task_id: t.planTaskId,
    phase_id: t.phaseId,
    description: t.title,
    order_index: t.orderIndex,
    status: t.status,
    plan_version: planVersion,
    files: t.files,
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
  const { error } = await db.from('change_requests').update({
    status: 'failed',
    pipeline_status: 'failed',
    failed_stage: failure.stage,
    retryable: failure.retryable,
    failure_diagnostics: failure,
  }).eq('id', changeId)
  if (error) throw new Error(`Failed to record plan failure on change: ${error.message}`)
  if (planId) {
    const { error: planError } = await db.from('change_plans').update({
      failed_stage: failure.stage,
      ended_at: new Date().toISOString(),
    }).eq('id', planId)
    if (planError) throw new Error(`Failed to record plan failure on plan: ${planError.message}`)
  }
}

// ---- Status transitions ----

export async function updatePipelineStatus(
  db: SupabaseClient,
  changeId: string,
  status: string,
  extraFields?: Record<string, unknown>
): Promise<void> {
  const { error } = await db.from('change_requests').update({
    pipeline_status: status,
    ...extraFields,
  }).eq('id', changeId)
  if (error) throw new Error(`Failed to update pipeline status: ${error.message}`)
}

export async function guardedStatusTransition(
  db: SupabaseClient,
  changeId: string,
  fromStatus: string,
  toStatus: string
): Promise<boolean> {
  const { data, error } = await db
    .from('change_requests')
    .update({ pipeline_status: toStatus })
    .eq('id', changeId)
    .eq('pipeline_status', fromStatus)
    .select('id')
  if (error) throw new Error(`Failed to transition pipeline status: ${error.message}`)
  return (data?.length ?? 0) > 0
}
