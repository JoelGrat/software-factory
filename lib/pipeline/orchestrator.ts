// lib/pipeline/orchestrator.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import { runDraftPlanPhase } from './phases/draft-plan'
import { runImpactAnalysisPhase } from './phases/impact-analysis'
import { runPlanGenerationPhase } from './phases/plan-generation'

export async function runPipeline(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider,
  opts: { forceReset?: boolean } = {}
): Promise<void> {
  await runDraftPlanPhase(changeId, db, ai, opts)
  await runImpactAnalysisPhase(changeId, db, ai)
  await runPlanGenerationPhase(changeId, db, ai)
  await applyExecutionPolicy(changeId, db, ai)
}

async function applyExecutionPolicy(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider
): Promise<void> {
  const { data: change } = await db
    .from('change_requests')
    .select('project_id, risk_level')
    .eq('id', changeId)
    .single()
  if (!change) return

  const { data: projectRow } = await db
    .from('projects')
    .select('project_settings')
    .eq('id', change.project_id)
    .single()

  const riskPolicy = (projectRow?.project_settings as any)?.riskPolicy ?? { low: 'auto', medium: 'approval', high: 'manual' }
  const riskLevel: string = (change as any).risk_level ?? 'low'

  // Factor in plan quality score — low quality overrides auto → approval
  const { data: plan } = await db
    .from('change_plans')
    .select('id, plan_quality_score')
    .eq('change_id', changeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  let policy: 'auto' | 'approval' | 'manual' = riskPolicy[riskLevel] ?? 'manual'
  if (policy === 'auto' && plan && (plan.plan_quality_score ?? 1) < 0.5) {
    policy = 'approval'  // low-quality plan overrides auto
  }

  if (policy === 'auto') {
    await db.from('change_plans')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', plan!.id)
    // Lazy import to avoid pulling in Docker deps at module load time
    const { DockerExecutor } = await import('@/lib/execution/executors/docker-executor')
    const { runExecution } = await import('@/lib/execution/execution-orchestrator')
    runExecution(changeId, db, ai, new DockerExecutor()).catch(err =>
      console.error(`[orchestrator] auto-execution failed for change ${changeId}:`, err)
    )
  } else if (policy === 'approval') {
    await db.from('change_requests')
      .update({ status: 'awaiting_approval', pipeline_status: 'awaiting_approval' })
      .eq('id', changeId)
  }
  // 'manual' → pipeline_status stays 'plan_generated', user navigates to detail page
}
