// app/api/projects/[id]/dashboard-stream/route.ts
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { subscribeToDashboard } from '@/lib/dashboard/event-bus'
import { getEventsSince } from '@/lib/dashboard/event-history'
import { isStalled } from '@/lib/dashboard/watchdog'
import type { DashboardEvent } from '@/lib/dashboard/event-types'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  // Verify project ownership
  const { data: project } = await db
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('owner_id', user.id)
    .single()
  if (!project) return new Response('Not found', { status: 404 })

  const sinceVersion = Number(new URL(req.url).searchParams.get('since') ?? '0')
  const adminDb = createAdminClient()

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: DashboardEvent | { type: 'heartbeat' }) {
        try {
          controller.enqueue(`event: dashboard\ndata: ${JSON.stringify(event)}\n\n`)
        } catch {
          // client disconnected
        }
      }

      // 1. Replay missed events if reconnecting
      if (sinceVersion > 0) {
        const missed = await getEventsSince(adminDb, projectId, sinceVersion)
        if (missed === null) {
          // Client is behind the buffer — send resync
          send({
            type: 'resync_required',
            scope: 'system',
            changeId: '',
            projectId,
            analysisVersion: 0,
            version: 0,
            payload: {},
          } as DashboardEvent)
        } else {
          for (const e of missed) send(e)
        }
      }

      // 2. Reconstruct synthetic lifecycle for any currently-running change
      const { data: runningChanges } = await adminDb
        .from('change_requests')
        .select('id, analysis_version, analysis_status, last_stage_started_at, expected_stage_duration_ms')
        .eq('project_id', projectId)
        .eq('analysis_status', 'running')

      for (const change of runningChanges ?? []) {
        // Check for stall
        if (isStalled({
          last_stage_started_at: change.last_stage_started_at ? new Date(change.last_stage_started_at) : null,
          expected_stage_duration_ms: change.expected_stage_duration_ms,
        })) {
          await adminDb
            .from('change_requests')
            .update({ analysis_status: 'stalled' })
            .eq('id', change.id)
            .eq('analysis_status', 'running')
          send({
            type: 'stalled', scope: 'analysis',
            changeId: change.id, projectId,
            analysisVersion: change.analysis_version, version: 0,
            synthetic: true, payload: {},
          } as DashboardEvent)
        } else {
          // Emit synthetic queued → started sequence
          for (const type of ['queued', 'started'] as const) {
            send({
              type, scope: 'analysis',
              changeId: change.id, projectId,
              analysisVersion: change.analysis_version, version: 0,
              synthetic: true, payload: {},
            } as DashboardEvent)
          }
        }
      }

      // 3. Subscribe to live events
      const unsub = subscribeToDashboard(projectId, send)

      // 4. Heartbeat every 25s
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(': heartbeat\n\n')
        } catch {
          clearInterval(heartbeat)
        }
      }, 25_000)

      // 5. Cleanup on disconnect
      req.signal.addEventListener('abort', () => {
        clearInterval(heartbeat)
        unsub()
        try { controller.close() } catch { /* already closed */ }
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
