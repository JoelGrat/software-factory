import type { DetailedPlan } from './types'

export interface ProjectedTask {
  planTaskId: string
  phaseId: string
  title: string
  description: string | undefined
  orderIndex: number
  status: 'pending'
  files: string[]
}

/**
 * Projects plan_json into a flat list of tasks for change_plan_tasks.
 * Substep ordering within tasks is preserved by definition (array order).
 * Call rebuildTaskProjection in planning-repository to persist — never patch incrementally.
 */
export function projectToTasks(plan: DetailedPlan): ProjectedTask[] {
  const rows: ProjectedTask[] = []
  let orderIndex = 0

  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      rows.push({
        planTaskId: task.id,
        phaseId: phase.id,
        title: task.title,
        description: task.description,
        orderIndex: orderIndex++,
        status: 'pending',
        files: task.files,
      })
    }
  }

  return rows
}
