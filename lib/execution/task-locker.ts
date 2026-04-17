import type { SupabaseClient } from '@supabase/supabase-js'

/** Crash recovery timeout: tasks locked longer than this are considered zombies */
const LOCK_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Atomically acquire a task lock.
 * Uses conditional UPDATE (WHERE status = 'pending') to prevent double-execution.
 * Returns true if lock acquired, false if another run holds it.
 */
export async function acquireTaskLock(
  db: SupabaseClient,
  taskId: string,
  runId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('change_plan_tasks')
    .update({
      status: 'in_progress',
      locked_by_run_id: runId,
      locked_at: new Date().toISOString(),
    })
    .eq('id', taskId)
    .eq('status', 'pending')
    .select('id')
  if (error) throw new Error(`acquireTaskLock failed: ${error.message}`)
  return (data?.length ?? 0) > 0
}

/** Mark a task as successfully completed. */
export async function releaseTaskDone(
  db: SupabaseClient,
  taskId: string,
): Promise<void> {
  const { error } = await db.from('change_plan_tasks').update({
    status: 'done',
    completed_at: new Date().toISOString(),
    locked_by_run_id: null,
    locked_at: null,
  }).eq('id', taskId)
  if (error) throw new Error(`releaseTaskDone failed: ${error.message}`)
}

/** Mark a task as failed with a reason. */
export async function releaseTaskFailed(
  db: SupabaseClient,
  taskId: string,
  reason: string,
): Promise<void> {
  const { error } = await db.from('change_plan_tasks').update({
    status: 'failed',
    failure_reason: reason.slice(0, 500),
    locked_by_run_id: null,
    locked_at: null,
  }).eq('id', taskId)
  if (error) throw new Error(`releaseTaskFailed failed: ${error.message}`)
}

/** Mark a task as blocked by a dependency. */
export async function markTaskBlocked(
  db: SupabaseClient,
  taskId: string,
  blockedByTaskId: string,
): Promise<void> {
  const { error } = await db.from('change_plan_tasks').update({
    status: 'blocked',
    blocked_by_task_id: blockedByTaskId,
  }).eq('id', taskId)
  if (error) throw new Error(`markTaskBlocked failed: ${error.message}`)
}

/**
 * Release tasks locked by a dead process (zombie cleanup).
 * Called at execution startup.
 */
export async function crashRecoveryCleanup(db: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString()
  const { error } = await db.from('change_plan_tasks')
    .update({ status: 'pending', locked_by_run_id: null, locked_at: null })
    .eq('status', 'in_progress')
    .lt('locked_at', cutoff)
  if (error) console.warn('[task-locker] crashRecoveryCleanup failed:', error.message)
}
