// lib/dashboard/event-history.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DashboardEvent } from './event-types'

const MAX_HISTORY_PER_PROJECT = 500

/**
 * Appends an event to the project's event_history ring buffer.
 * Prunes oldest events when the count exceeds MAX_HISTORY_PER_PROJECT.
 * Fire-and-forget — callers should not await if they don't need confirmation.
 */
export async function recordEvent(
  db: SupabaseClient,
  projectId: string,
  event: DashboardEvent
): Promise<void> {
  await db.from('event_history').insert({
    project_id: projectId,
    version: event.version,
    event_json: event,
  })

  // Prune: keep only the most recent MAX_HISTORY_PER_PROJECT events
  const { data: oldest } = await db
    .from('event_history')
    .select('id')
    .eq('project_id', projectId)
    .order('version', { ascending: false })
    .range(MAX_HISTORY_PER_PROJECT, MAX_HISTORY_PER_PROJECT)
    .maybeSingle()

  if (oldest) {
    await db
      .from('event_history')
      .delete()
      .eq('project_id', projectId)
      .lt('version', event.version - MAX_HISTORY_PER_PROJECT + 1)
  }
}

/**
 * Returns events since `sinceVersion` for replay on SSE reconnect.
 * Returns null if sinceVersion is older than the oldest stored event (triggers resync).
 */
export async function getEventsSince(
  db: SupabaseClient,
  projectId: string,
  sinceVersion: number
): Promise<DashboardEvent[] | null> {
  // Check oldest stored event
  const { data: oldest } = await db
    .from('event_history')
    .select('version')
    .eq('project_id', projectId)
    .order('version', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (oldest && sinceVersion < oldest.version) {
    return null // client is behind buffer — trigger resync
  }

  const { data } = await db
    .from('event_history')
    .select('event_json')
    .eq('project_id', projectId)
    .gt('version', sinceVersion)
    .order('version', { ascending: true })

  return (data ?? []).map((row) => row.event_json as DashboardEvent)
}
