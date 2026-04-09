// lib/dashboard/event-counter.ts
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Atomically increments the project's event version counter in the DB.
 * Returns the new version number. Uses a DB function to ensure atomicity
 * under concurrent writes.
 */
export async function nextVersion(db: SupabaseClient, projectId: string): Promise<number> {
  const { data, error } = await db.rpc('increment_project_event_version', {
    p_project_id: projectId,
  })
  if (error) throw error
  return data as number
}
