import type { TaskRunSummary } from './execution-types-v2'

interface TaskRow {
  id: string
  status: string
}

/**
 * Compute final TaskRunSummary from task rows.
 * success  = all tasks done
 * partial  = ≥1 done + ≥1 failed/blocked
 * failed   = 0 done
 */
export function computeTaskRunSummary(
  tasks: TaskRow[],
  durationMs: number,
): TaskRunSummary {
  const completedTasks = tasks.filter(t => t.status === 'done').map(t => t.id)
  const failedTasks = tasks.filter(t => t.status === 'failed').map(t => t.id)
  const blockedTasks = tasks.filter(t => t.status === 'blocked').map(t => t.id)
  const skippedTasks = tasks.filter(t => t.status === 'skipped' || t.status === 'cancelled').map(t => t.id)

  const finalStatus: TaskRunSummary['finalStatus'] =
    completedTasks.length === tasks.length ? 'success'
    : completedTasks.length > 0 ? 'partial'
    : 'failed'

  return {
    completedTasks,
    failedTasks,
    blockedTasks,
    skippedTasks,
    totalTasks: tasks.length,
    durationMs,
    finalStatus,
  }
}
