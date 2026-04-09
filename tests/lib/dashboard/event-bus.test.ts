// tests/lib/dashboard/event-bus.test.ts
import { describe, it, expect, vi } from 'vitest'

describe('event bus', () => {
  it('delivers events to subscribers for the right project', async () => {
    // dynamic import so the singleton is fresh per test run
    const { emitDashboardEvent, subscribeToDashboard } = await import('@/lib/dashboard/event-bus')

    const received: unknown[] = []
    const unsub = subscribeToDashboard('proj-1', (e) => received.push(e))

    emitDashboardEvent('proj-1', {
      type: 'queued', scope: 'analysis', changeId: 'c1', projectId: 'proj-1',
      analysisVersion: 1, version: 1, payload: {},
    })

    unsub()
    expect(received).toHaveLength(1)
  })

  it('does not deliver events for other projects', async () => {
    const { emitDashboardEvent, subscribeToDashboard } = await import('@/lib/dashboard/event-bus')

    const received: unknown[] = []
    const unsub = subscribeToDashboard('proj-A', (e) => received.push(e))

    emitDashboardEvent('proj-B', {
      type: 'queued', scope: 'analysis', changeId: 'c1', projectId: 'proj-B',
      analysisVersion: 1, version: 1, payload: {},
    })

    unsub()
    expect(received).toHaveLength(0)
  })

  it('unsubscribe stops delivery', async () => {
    const { emitDashboardEvent, subscribeToDashboard } = await import('@/lib/dashboard/event-bus')

    const received: unknown[] = []
    const unsub = subscribeToDashboard('proj-2', (e) => received.push(e))
    unsub()

    emitDashboardEvent('proj-2', {
      type: 'queued', scope: 'analysis', changeId: 'c1', projectId: 'proj-2',
      analysisVersion: 1, version: 1, payload: {},
    })

    expect(received).toHaveLength(0)
  })
})
