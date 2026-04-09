// lib/dashboard/event-bus.ts
import { EventEmitter } from 'node:events'
import type { DashboardEvent } from './event-types'

// One singleton per server process. Acceptable for single-process deployment.
// Multi-process scaling requires replacing this with Redis pub/sub.
const emitter = new EventEmitter()
emitter.setMaxListeners(200)

function projectKey(projectId: string): string {
  return `project:${projectId}`
}

export function emitDashboardEvent(projectId: string, event: DashboardEvent): void {
  if (!projectId) {
    console.error('[event-bus] emitDashboardEvent called with empty projectId')
    return
  }
  try {
    emitter.emit(projectKey(projectId), event)
  } catch (err) {
    console.error('[event-bus] handler threw during emit for project', projectId, err)
  }
}

export function subscribeToDashboard(
  projectId: string,
  handler: (e: DashboardEvent) => void
): () => void {
  const key = projectKey(projectId)
  emitter.on(key, handler)
  return () => emitter.off(key, handler)
}

/** Returns listener count for a project channel. Useful for tests and health checks. */
export function listenerCount(projectId: string): number {
  return emitter.listenerCount(projectKey(projectId))
}
