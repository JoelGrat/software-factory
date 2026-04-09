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
  emitter.emit(projectKey(projectId), event)
}

export function subscribeToDashboard(
  projectId: string,
  handler: (e: DashboardEvent) => void
): () => void {
  const key = projectKey(projectId)
  emitter.on(key, handler)
  return () => emitter.off(key, handler)
}
