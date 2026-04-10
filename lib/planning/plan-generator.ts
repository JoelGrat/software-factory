// lib/planning/plan-generator.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { ImpactedComponent, PlannerTask } from './types'
import type { ImpactFeedback } from '@/lib/impact/types'
import { runArchitecturePhase, runComponentTasksPhase, runFallbackTasksPhase, runOrderingPhase, runSpecPhase } from './phases'
import { runDraftPlan } from './draft-planner'

export async function runPlanGeneration(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider
): Promise<void> {
  await db.from('change_requests').update({ status: 'planning' }).eq('id', changeId)

  try {
    // Load change
    const { data: change } = await db
      .from('change_requests')
      .select('id, project_id, title, intent, type, priority, risk_level, confidence_score, confidence_breakdown')
      .eq('id', changeId)
      .single()

    if (!change) throw new Error(`Change not found: ${changeId}`)

    // Load impact → impacted components
    const { data: impact } = await db
      .from('change_impacts')
      .select('id, change_id, primary_risk_factor, analysis_quality')
      .eq('change_id', changeId)
      .maybeSingle()

    if (!impact) throw new Error(`No impact analysis found for change: ${changeId}`)

    const { data: rawComponents } = await db
      .from('change_impact_components')
      .select('component_id, impact_weight, system_components(name, type)')
      .eq('impact_id', impact.id)
      .order('impact_weight', { ascending: false })
      .limit(10)

    const components: ImpactedComponent[] = (rawComponents ?? []).map((row: any) => ({
      componentId: row.component_id,
      name: row.system_components?.name ?? row.component_id,
      type: row.system_components?.type ?? 'module',
      impactWeight: row.impact_weight,
    }))

    // Draft plan: fast AI pass to project what files/components will be created/touched.
    // Augment with deterministic keyword match so AI alone is never a single point of failure.
    const draftPlan = await runDraftPlan(change, ai)

    const changeWords = [
      ...change.title.toLowerCase().split(/\s+/),
      ...change.intent.toLowerCase().split(/\s+/),
    ].filter(t => t.length > 2)
    for (const comp of components) {
      const compWords = comp.name.replace(/([A-Z])/g, ' $1').toLowerCase().trim().split(/\s+/)
      if (compWords.some(w => changeWords.includes(w)) && !draftPlan.component_names.includes(comp.name)) {
        draftPlan.component_names.push(comp.name)
      }
    }

    // Derive feedback from already-stored impact data — no extra DB writes or AI calls
    const reasons: string[] = []
    const breakdown: Record<string, number> = (change as any).confidence_breakdown ?? {}
    for (const [factor, weight] of Object.entries(breakdown).sort(([, a], [, b]) => (b as number) - (a as number)).slice(0, 3)) {
      if ((weight as number) > 0) reasons.push(factor)
    }
    const primaryFactor = (impact as any)?.primary_risk_factor
    if (primaryFactor && !reasons.includes(primaryFactor)) reasons.unshift(primaryFactor)

    const existingNames = components.map(c => c.name)
    for (const name of draftPlan.component_names) {
      if (!existingNames.includes(name)) reasons.push(`projected component not in analysis: ${name}`)
    }

    const criticalDomains = ['auth', 'security', 'payment', 'credential', 'token', 'db', 'database', 'migration', 'session']
    const newFilePaths = draftPlan.new_file_paths
    const newFileInCriticalDomain = newFilePaths.some(p =>
      criticalDomains.some(d => p.toLowerCase().includes(d))
    )
    if (newFilePaths.length > 0) reasons.push(`introduces ${newFilePaths.length} new file(s)`)
    if (newFileInCriticalDomain) reasons.push('new file(s) touch critical domain (auth/db/security)')

    const feedback: ImpactFeedback = {
      risk_level: ((change as any).risk_level ?? 'low') as 'low' | 'medium' | 'high',
      reasons: reasons.slice(0, 5),
      uncertainty: (impact as any)?.analysis_quality === 'medium' ? 0.3 : 0.1,
      new_file_count: newFilePaths.length,
      new_file_in_critical_domain: newFileInCriticalDomain,
      new_edges_created: 0,  // not available from stored data; populated by runImpactAnalysis
    }

    // Phase 1: Architecture (feedback adjusts task granularity + sequencing in prompt)
    const architecture = await runArchitecturePhase(change, components, ai, feedback)

    // Create change_plans row
    const { data: plan, error: planError } = await db
      .from('change_plans')
      .insert({
        change_id: changeId,
        status: 'draft',
        estimated_files: architecture.estimatedFiles,
        branch_name: architecture.branchName,
      })
      .select('id')
      .single()

    if (planError || !plan) throw planError ?? new Error('Failed to create change_plans row')

    // Phase 2: Per-component tasks (or fallback if no components)
    const allTasks: PlannerTask[] = []
    if (components.length > 0) {
      for (const component of components) {
        const approach = architecture.componentApproaches[component.name] ?? 'Implement changes as needed'
        const descriptions = await runComponentTasksPhase(change, component, approach, ai)
        for (const description of descriptions) {
          allTasks.push({
            description,
            componentId: component.componentId,
            componentName: component.name,
            orderIndex: allTasks.length,
          })
        }
      }
    } else {
      const descriptions = await runFallbackTasksPhase(change, architecture.approach, ai)
      for (const description of descriptions) {
        allTasks.push({
          description,
          componentId: null,
          componentName: 'General',
          orderIndex: allTasks.length,
        })
      }
    }

    // New-file tasks: one task per file the architecture flagged as needing creation
    const uniqueNewFilePaths = [...new Set(architecture.newFilePaths)].filter(Boolean)
    for (const filePath of uniqueNewFilePaths) {
      allTasks.push({
        description: `Create new file: ${filePath}`,
        componentId: null,
        componentName: 'New File',
        orderIndex: allTasks.length,
        newFilePath: filePath,
      })
    }

    // Phase 3: Deterministic ordering
    const orderedTasks = runOrderingPhase(allTasks, components)

    // Write tasks to DB
    if (orderedTasks.length > 0) {
      const taskRows = orderedTasks.map(t => ({
        plan_id: plan.id,
        component_id: t.componentId,
        description: t.description,
        order_index: t.orderIndex,
        status: 'pending',
        new_file_path: t.newFilePath ?? null,
      }))
      const { error: tasksError } = await db.from('change_plan_tasks').insert(taskRows)
      if (tasksError) throw tasksError
    }

    // Update plan with task count
    await db.from('change_plans').update({
      estimated_tasks: orderedTasks.length,
    }).eq('id', plan.id)

    // Phase 4: Spec generation (best-effort)
    const specMarkdown = await runSpecPhase(change, architecture, orderedTasks, ai)
    await db.from('change_plans').update({ spec_markdown: specMarkdown }).eq('id', plan.id)

    // Mark complete
    await db.from('change_requests').update({ status: 'planned' }).eq('id', changeId)

    // Apply execution policy based on project settings + change risk level
    const { data: projectRow } = await db
      .from('projects')
      .select('project_settings')
      .eq('id', (change as any).project_id)
      .single()

    const riskPolicy = (projectRow?.project_settings as any)?.riskPolicy ?? { low: 'auto', medium: 'approval', high: 'manual' }
    const riskLevel: string = (change as any).risk_level ?? 'low'
    const policy: 'auto' | 'approval' | 'manual' = riskPolicy[riskLevel] ?? 'manual'

    if (policy === 'auto') {
      // Auto-approve plan and fire execution immediately
      await db.from('change_plans')
        .update({ status: 'approved', approved_at: new Date().toISOString() })
        .eq('id', plan.id)

      const { DockerExecutor } = await import('@/lib/execution/executors/docker-executor')
      const { runExecution } = await import('@/lib/execution/execution-orchestrator')
      runExecution(changeId, db, ai, new DockerExecutor()).catch(err =>
        console.error(`[plan-generator] auto-execution failed for change ${changeId}:`, err)
      )
    } else if (policy === 'approval') {
      // Pause for user approval — plan stays draft, change status signals the UI
      await db.from('change_requests').update({ status: 'awaiting_approval' }).eq('id', changeId)
    }
    // 'manual' → leave as 'planned', user must navigate to change detail page

  } catch (err) {
    await db.from('change_requests').update({ status: 'analyzed' }).eq('id', changeId)
    throw err
  }
}
