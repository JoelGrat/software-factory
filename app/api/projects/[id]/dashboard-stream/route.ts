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
  // NOTE: createClient() must be called in the synchronous request handler scope,
  // not inside ReadableStream.start() — cookies() is only available synchronously.
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

  const raw = new URL(req.url).searchParams.get('since')
  const sinceVersion = raw !== null && /^\d+$/.test(raw) ? Number(raw) : 0
  const adminDb = createAdminClient()

  const stream = new ReadableStream({
    async start(controller) {
      let unsub: (() => void) | undefined
      let heartbeat: ReturnType<typeof setInterval> | undefined

      try {
        const sentVersions = new Set<number>()

        function send(event: DashboardEvent) {
          // Skip synthetic events' version dedup (they use version: 0)
          if (event.version > 0 && sentVersions.has(event.version)) return
          if (event.version > 0) sentVersions.add(event.version)
          try {
            controller.enqueue(`event: dashboard\ndata: ${JSON.stringify(event)}\n\n`)
          } catch {
            // client disconnected
          }
        }

        // Buffer events that arrive during replay
        let replayComplete = false
        const pendingBuffer: DashboardEvent[] = []

        // 1. Subscribe FIRST to avoid missing events during replay
        unsub = subscribeToDashboard(projectId, (e) => {
          if (!replayComplete) {
            pendingBuffer.push(e)
          } else {
            send(e)
          }
        })

        // 2. Replay missed events if reconnecting
        if (sinceVersion > 0) {
          const missed = await getEventsSince(adminDb, projectId, sinceVersion)
          if (missed === null) {
            send({
              type: 'resync_required',
              scope: 'system',
              changeId: '',
              projectId,
              analysisVersion: 0,
              version: 0,
              payload: {},
            })
          } else {
            for (const e of missed) send(e)
          }
        }

        // 3. Reconstruct synthetic lifecycle for currently-running changes
        const { data: runningChanges } = await adminDb
          .from('change_requests')
          .select('id, analysis_version, analysis_status, last_stage_started_at, expected_stage_duration_ms')
          .eq('project_id', projectId)
          .eq('analysis_status', 'running')

        for (const change of runningChanges ?? []) {
          if (isStalled({
            last_stage_started_at: change.last_stage_started_at ? new Date(change.last_stage_started_at) : null,
            expected_stage_duration_ms: change.expected_stage_duration_ms,
          })) {
            const { error: stallErr } = await adminDb
              .from('change_requests')
              .update({ analysis_status: 'stalled' })
              .eq('id', change.id)
              .eq('analysis_status', 'running')
            if (stallErr) {
              console.error('[dashboard-stream] stall update failed', { changeId: change.id, error: stallErr })
            }
            send({
              type: 'stalled', scope: 'analysis',
              changeId: change.id, projectId,
              analysisVersion: change.analysis_version, version: 0,
              synthetic: true, payload: {},
            })
          } else {
            for (const type of ['queued', 'started'] as const) {
              send({
                type, scope: 'analysis',
                changeId: change.id, projectId,
                analysisVersion: change.analysis_version, version: 0,
                synthetic: true, payload: {},
              })
            }
          }
        }

        // 4. Replay done — flush buffered events and go live
        replayComplete = true
        for (const e of pendingBuffer) send(e)

        // 5. Heartbeat every 25s
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(': heartbeat\n\n')
          } catch {
            clearInterval(heartbeat)
          }
        }, 25_000)

        // 6. Cleanup on disconnect
        req.signal.addEventListener('abort', () => {
          clearInterval(heartbeat)
          unsub?.()
          try { controller.close() } catch { /* already closed */ }
        })

      } catch (err) {
        // Unhandled error during setup — close stream
        unsub?.()
        if (heartbeat !== undefined) clearInterval(heartbeat)
        try { controller.error(err) } catch { /* already errored or closed */ }
      }
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
