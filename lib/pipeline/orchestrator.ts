// lib/pipeline/orchestrator.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import { generateSpec } from '@/lib/planning/spec-generator'
import { generateDetailedPlan, PlanQualityGateError } from '@/lib/planning/detailed-plan-generator'
import { validateSpecInput } from '@/lib/planning/plan-validator'
import { projectToTasks } from '@/lib/planning/human-task-view'
import { scoreFromPlan } from '@/lib/planning/risk-scorer'
import {
  createSpec,
  createPlan,
  setPlanJson,
  updatePlanStage,
  finalizePlan,
  recordPlanFailure,
  rebuildTaskProjection,
  loadSpecForChange,
  loadPlanForChange,
  updatePipelineStatus,
  guardedStatusTransition,
} from '@/lib/planning/planning-repository'
import { runImpactEnginePhase } from './phases/impact-engine'
import type { DetailedPlan, PlannerFailure, PlannerStage } from '@/lib/planning/types'

const STAGE_ORDER: PlannerStage[] = ['spec', 'plan', 'projection', 'impact', 'risk', 'policy']

function shouldRunStage(startStage: PlannerStage, thisStage: PlannerStage): boolean {
  return STAGE_ORDER.indexOf(thisStage) >= STAGE_ORDER.indexOf(startStage)
}

function deriveBranchName(goal: string, changeId: string): string {
  const slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-$/, '')
  return `sf/${changeId.slice(0, 8)}-${slug}`
}

export async function runPipeline(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider,
  opts: { forceReset?: boolean } = {}
): Promise<void> {
  const { data: change, error: changeError } = await db
    .from('change_requests')
    .select('id, pipeline_status, failed_stage, title, intent, type')
    .eq('id', changeId)
    .single()
  if (!change) throw new Error(`Change not found: ${changeId}${changeError ? ` (${changeError.message})` : ''}`)

  const isRetry =
    change.pipeline_status === 'failed' &&
    change.failed_stage &&
    !opts.forceReset

  const startStage: PlannerStage = isRetry
    ? ((change.failed_stage as PlannerStage) ?? 'spec')
    : 'spec'

  let planRow = await loadPlanForChange(db, changeId)
  let planId: string | null = planRow?.id ?? null
  const plannerVersion = isRetry ? ((planRow?.planner_version ?? 1) + 1) : 1
  let currentPlanJson: DetailedPlan | null = planRow?.plan_json ?? null

  try {
    // Transition to planning state — inside try so failures are recorded
    if (!isRetry) {
      if (opts.forceReset) {
        // forceReset: allow regeneration from any recoverable state (ready, awaiting_approval, etc.)
        await db.from('change_requests').update({
          status: 'planning',
          pipeline_status: 'planning',
          failed_stage: null,
          retryable: null,
          failure_diagnostics: null,
        }).eq('id', changeId)
      } else {
        const ok = await guardedStatusTransition(db, changeId, 'validated', 'planning')
        if (!ok) throw Object.assign(
          new Error(`Cannot start planning: change must be in 'validated' status (current: ${change.pipeline_status})`),
          { _stage: 'spec' as PlannerStage }
        )
        await updatePipelineStatus(db, changeId, 'planning', { status: 'planning' })
      }
    } else {
      await updatePipelineStatus(db, changeId, 'planning', {
        status: 'planning',
        failed_stage: null,
        retryable: null,
        failure_diagnostics: null,
      })
    }
    // Stage 1: Generate Spec
    if (shouldRunStage(startStage, 'spec')) {
      const t = Date.now()
      await updatePipelineStatus(db, changeId, 'spec_generating')
      const { spec, markdown } = await generateSpec(
        changeId, db, ai,
        (s) => updatePipelineStatus(db, changeId, s)
      )
      await updatePipelineStatus(db, changeId, 'spec_validating')
      const specCheck = validateSpecInput(spec)
      if (!specCheck.passed) {
        throw Object.assign(new Error(`Spec validation failed: ${specCheck.diagnostics.summary}`), {
          _stage: 'spec' as PlannerStage,
          _diagnostics: specCheck.diagnostics,
        })
      }
      await createSpec(db, changeId, spec, markdown)
      if (planId) await updatePlanStage(db, planId, 'spec', Date.now() - t)
      await updatePipelineStatus(db, changeId, 'spec_generated')
    }

    // Stage 2: Generate Detailed Plan
    if (shouldRunStage(startStage, 'plan')) {
      const t = Date.now()
      await updatePipelineStatus(db, changeId, 'plan_generating')
      const specRow = await loadSpecForChange(db, changeId)
      if (!specRow) {
        throw Object.assign(new Error('No spec found — cannot generate plan'), { _stage: 'plan' as PlannerStage })
      }
      const plan = await generateDetailedPlan(
        change, specRow.structured, plannerVersion, ai,
        (s) => updatePipelineStatus(db, changeId, s)
      )
      const branchName = deriveBranchName(plan.goal, changeId)
      plan.branch_name = branchName
      const { id } = await createPlan(db, changeId, branchName, plannerVersion)
      planId = id
      await setPlanJson(db, planId, plan)
      currentPlanJson = plan
      await updatePlanStage(db, planId, 'plan', Date.now() - t)
      await updatePipelineStatus(db, changeId, 'plan_generated')
    }

    // Ensure planId is resolved for remaining stages
    if (!planId) {
      planRow = await loadPlanForChange(db, changeId)
      planId = planRow?.id ?? null
      currentPlanJson = planRow?.plan_json ?? null
    }
    if (!planId) throw new Error('No plan row found — cannot continue')
    if (!currentPlanJson) {
      const loaded = await loadPlanForChange(db, changeId)
      currentPlanJson = loaded?.plan_json ?? null
    }

    // Stage 3: Project Human Task View
    if (shouldRunStage(startStage, 'projection')) {
      const t = Date.now()
      if (!currentPlanJson) {
        throw Object.assign(
          new Error('No plan_json — cannot rebuild task projection'),
          { _stage: 'projection' as PlannerStage }
        )
      }
      const tasks = projectToTasks(currentPlanJson)
      const version = planRow?.planner_version ?? plannerVersion
      await rebuildTaskProjection(db, planId, version, tasks)
      await updatePlanStage(db, planId, 'projection', Date.now() - t)
    }

    // Stage 4: Impact Analysis
    if (shouldRunStage(startStage, 'impact')) {
      const t = Date.now()
      await runImpactEnginePhase(changeId, db, ai)
      await updatePlanStage(db, planId, 'impact', Date.now() - t)
    }

    // Stage 5: Score Risk
    if (shouldRunStage(startStage, 'risk')) {
      const t = Date.now()
      await updatePipelineStatus(db, changeId, 'scoring')
      if (currentPlanJson) {
        const { data: impactRow } = await db
          .from('change_impacts')
          .select('drift_ratio, direct_seeds')
          .eq('change_id', changeId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        const impactData = impactRow as { drift_ratio?: number; direct_seeds?: number } | null
        const driftRatio = impactData?.drift_ratio ?? 0
        const riskScore = scoreFromPlan(currentPlanJson, driftRatio)
        await db.from('change_requests').update({
          risk_level: riskScore.riskLevel,
          pipeline_status: 'scored',
        }).eq('id', changeId)
      }
      await updatePlanStage(db, planId, 'risk', Date.now() - t)
    }

    // Stage 6: Apply Execution Policy
    const { data: planMeta } = await db
      .from('change_plans')
      .select('plan_quality_score')
      .eq('id', planId)
      .single()
    const planData = planMeta as { plan_quality_score?: number } | null
    const qualityScore = planData?.plan_quality_score ?? 1.0
    if (planId && currentPlanJson) {
      await finalizePlan(db, planId, currentPlanJson, qualityScore)
      await applyExecutionPolicy(changeId, planId, qualityScore, db, ai)
    } else {
      throw Object.assign(
        new Error('Cannot finalize: missing plan row or plan JSON'),
        { _stage: 'policy' as PlannerStage }
      )
    }

  } catch (err) {
    const failure = buildFailure(err)
    await recordPlanFailure(db, changeId, planId, failure)
    throw err
  }
}

async function applyExecutionPolicy(
  changeId: string,
  planId: string,
  qualityScore: number,
  db: SupabaseClient,
  ai: AIProvider
): Promise<void> {
  const { data: change } = await db
    .from('change_requests')
    .select('project_id, risk_level')
    .eq('id', changeId)
    .single()
  if (!change) return

  const changeData = change as { project_id: string; risk_level?: string }

  const { data: projectRow } = await db
    .from('projects')
    .select('project_settings')
    .eq('id', changeData.project_id)
    .single()

  const projectData = projectRow as { project_settings?: { riskPolicy?: Record<string, string> } } | null

  const riskPolicy = projectData?.project_settings?.riskPolicy ?? {
    low: 'auto', medium: 'approval', high: 'manual',
  }
  const riskLevel: string = changeData.risk_level ?? 'low'

  const VALID_POLICIES = ['auto', 'approval', 'manual'] as const
  const rawPolicy = riskPolicy[riskLevel] ?? 'manual'
  let policy: 'auto' | 'approval' | 'manual' = VALID_POLICIES.includes(rawPolicy as typeof VALID_POLICIES[number])
    ? (rawPolicy as 'auto' | 'approval' | 'manual')
    : 'manual'
  if (policy === 'auto' && qualityScore < 0.5) policy = 'approval'

  if (policy === 'auto') {
    await db.from('change_plans')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', planId)
    await db.from('change_requests')
      .update({ status: 'ready', pipeline_status: 'ready' })
      .eq('id', changeId)
    const { DockerExecutor } = await import('@/lib/execution/executors/docker-executor')
    const { runExecution } = await import('@/lib/execution/execution-orchestrator')
    runExecution(changeId, db, ai, new DockerExecutor()).catch(err =>
      console.error(`[orchestrator] auto-execution failed for change ${changeId}:`, err)
    )
  } else if (policy === 'approval') {
    await db.from('change_requests')
      .update({ status: 'awaiting_approval', pipeline_status: 'awaiting_approval' })
      .eq('id', changeId)
  } else {
    // manual → mark ready, user initiates execution manually
    await db.from('change_requests')
      .update({ status: 'ready', pipeline_status: 'ready' })
      .eq('id', changeId)
  }
}

function buildFailure(err: unknown): PlannerFailure {
  interface CaughtError {
    _stage?: PlannerStage
    _diagnostics?: unknown
    message?: string
    diagnostics?: { issues: string[]; summary: string }
  }
  const e = err as CaughtError
  const stage: PlannerStage = e?._stage ?? guessStageFromMessage(e?.message)
  const isQualityGate = err instanceof PlanQualityGateError
  const rawMessage: string = e?.message ?? String(err)
  const rawIssues: string[] = isQualityGate ? (e.diagnostics?.issues ?? [rawMessage]) : [rawMessage]
  const truncated = rawIssues.length > 10

  return {
    stage,
    retryable: !isQualityGate,
    reason: isQualityGate ? 'quality_gate' : rawMessage.slice(0, 200),
    diagnostics: {
      summary: isQualityGate ? (e.diagnostics?.summary ?? rawMessage.slice(0, 200)) : rawMessage.slice(0, 200),
      issues: rawIssues.slice(0, 10),
      truncated,
    },
    failed_at: new Date().toISOString(),
  }
}

function guessStageFromMessage(msg: unknown): PlannerStage {
  const m = String(msg ?? '').toLowerCase()
  if (m.includes('spec')) return 'spec'
  if (m.includes('projection')) return 'projection'
  if (m.includes('plan')) return 'plan'
  if (m.includes('impact')) return 'impact'
  if (m.includes('risk')) return 'risk'
  return 'policy'
}
