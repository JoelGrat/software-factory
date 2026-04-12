// lib/planning/add-task.ts
import type { SupabaseClient } from '@supabase/supabase-js'

export interface InsertedTask {
  id: string
  plan_id: string
  component_id: string | null
  description: string
  order_index: number
  status: string
}

/**
 * Appends a single task to an existing plan.
 * order_index is set to max(existing) + 1, or 0 if no tasks exist.
 */
export async function insertPlanTask(
  db: SupabaseClient,
  planId: string,
  description: string,
  existingTasks: { order_index: number }[],
): Promise<InsertedTask> {
  const maxIndex = existingTasks.reduce((max, t) => Math.max(max, t.order_index), -1)
  const row = {
    plan_id: planId,
    component_id: null,
    description,
    order_index: maxIndex + 1,
    status: 'pending',
  }
  const { data, error } = await db
    .from('change_plan_tasks')
    .insert(row)
    .select()
    .single()
  if (error) throw error
  return data as InsertedTask
}
