import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import type { SupabaseClient } from '@supabase/supabase-js'

const execFile = promisify(execFileCb)

export const PORT_MIN = 3100
export const PORT_MAX = 3999

/** Pure: pick lowest free port. Throws 'port_pool_exhausted' if none available. */
export function pickPort(usedPorts: Set<number>): number {
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!usedPorts.has(p)) return p
  }
  throw new Error('port_pool_exhausted')
}

/** Query DB for in-use ports, pick lowest free one.
 *  @param exclude Additional ports to treat as used (e.g. ones that failed to bind on the host).
 */
export async function allocatePort(db: SupabaseClient, exclude: Set<number> = new Set()): Promise<number> {
  const { data, error } = await (db.from('preview_containers') as any)
    .select('port')
    .in('status', ['starting', 'running'])
  if (error) throw new Error(`allocatePort: db query failed: ${error.message}`)
  const used = new Set<number>((data ?? []).map((r: any) => r.port as number).filter(Boolean))
  for (const p of exclude) used.add(p)
  return pickPort(used)
}

/**
 * Sweep stale rows and verify running containers still exist in Docker.
 * Call this before every allocatePort() to keep the pool self-healing.
 */
export async function cleanupOrphans(db: SupabaseClient): Promise<void> {
  const now = new Date().toISOString()
  const startingCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString()

  // Mark stale 'starting' rows as error
  await (db.from('preview_containers') as any)
    .update({ status: 'error', error_message: 'startup timeout', stopped_at: now })
    .eq('status', 'starting')
    .lt('started_at', startingCutoff)

  // Check 'running' rows against Docker
  const { data: running, error } = await (db.from('preview_containers') as any)
    .select('id, container_id')
    .eq('status', 'running')
  if (error) return  // best-effort: don't block port allocation on cleanup failure

  for (const row of running ?? []) {
    if (!row.container_id) continue
    try {
      // Use execFile (not exec) to avoid shell injection via container_id
      await execFile('docker', ['inspect', row.container_id])
    } catch {
      await (db.from('preview_containers') as any)
        .update({ status: 'stopped', stopped_at: now })
        .eq('id', row.id)
    }
  }
}
