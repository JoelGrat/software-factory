// lib/planning/plan-generator.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { ImpactedComponent, PlannerTask } from './types'
import { runArchitecturePhase, runComponentTasksPhase, runFallbackTasksPhase, runOrderingPhase, runSpecPhase } from './phases'

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
      .select('id, project_id, title, intent, type, priority')
      .eq('id', changeId)
      .single()

    if (!change) throw new Error(`Change not found: ${changeId}`)

    // Load impact → impacted components
    const { data: impact } = await db
      .from('change_impacts')
      .select('id, change_id')
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

    // Phase 1: Architecture
    const architecture = await runArchitecturePhase(change, components, ai)

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
          componentId: null as any,
          componentName: 'General',
          orderIndex: allTasks.length,
        })
      }
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

  } catch (err) {
    await db.from('change_requests').update({ status: 'analyzed' }).eq('id', changeId)
    throw err
  }
}
