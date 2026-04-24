import type { SupabaseClient } from '@supabase/supabase-js'

interface TaskDep {
  id: string
  dependencies: string[]
}

/**
 * Collect the target task and all transitive dependents.
 * Returns a Set of task IDs to reset.
 */
export function collectDownstreamIds(
  fromTaskId: string,
  tasks: TaskDep[],
): Set<string> {
  const result = new Set<string>([fromTaskId])
  let changed = true
  while (changed) {
    changed = false
    for (const task of tasks) {
      if (!result.has(task.id) && task.dependencies.some(d => result.has(d))) {
        result.add(task.id)
        changed = true
      }
    }
  }
  return result
}

/**
 * Reset the target task and all downstream dependents to 'pending'.
 * Tasks outside the dependency graph are untouched.
 */
export async function resetDownstreamTasks(
  db: SupabaseClient,
  fromTaskId: string,
  allTasks: TaskDep[],
): Promise<Set<string>> {
  const toReset = collectDownstreamIds(fromTaskId, allTasks)

  const { error } = await db.from('change_plan_tasks')
    .update({
      status: 'pending',
      locked_by_run_id: null,
      locked_at: null,
      failure_reason: null,
      blocked_by_task_id: null,
      completed_at: null,
    })
    .in('id', [...toReset])

  if (error) throw new Error(`resetDownstreamTasks failed: ${error.message}`)

  return toReset
}

/**
 * Union of collectDownstreamIds over multiple roots.
 */
export function collectDownstreamIdsFromRoots(
  roots: string[],
  tasks: TaskDep[],
): Set<string> {
  const result = new Set<string>()
  for (const root of roots) {
    for (const id of collectDownstreamIds(root, tasks)) {
      result.add(id)
    }
  }
  return result
}

/**
 * Reset multiple root tasks and all their transitive downstream dependents.
 */
export async function resetDownstreamTasksFromRoots(
  db: SupabaseClient,
  roots: string[],
  allTasks: TaskDep[],
): Promise<Set<string>> {
  const toReset = collectDownstreamIdsFromRoots(roots, allTasks)
  if (toReset.size === 0) return toReset

  const { error } = await db.from('change_plan_tasks')
    .update({
      status: 'pending',
      locked_by_run_id: null,
      locked_at: null,
      failure_reason: null,
      blocked_by_task_id: null,
      completed_at: null,
    })
    .in('id', [...toReset])

  if (error) throw new Error(`resetDownstreamTasksFromRoots failed: ${error.message}`)
  return toReset
}
