import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Mock EventSource
class MockEventSource {
  url: string
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
  close = vi.fn()
  constructor(url: string) { this.url = url }
}

vi.stubGlobal('EventSource', MockEventSource)
vi.stubGlobal('fetch', vi.fn())

import { useAnalysisStream } from '@/hooks/use-analysis-stream'
import type { DashboardEvent } from '@/lib/dashboard/event-types'

describe('useAnalysisStream', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts in connecting state', () => {
    const { result } = renderHook(() => useAnalysisStream('proj-1'))
    expect(result.current.connectionState).toBe('connecting')
  })

  it('drops events with version <= last seen version', () => {
    const { result } = renderHook(() => useAnalysisStream('proj-1'))
    const event: DashboardEvent = {
      type: 'queued', scope: 'analysis', changeId: 'c1', projectId: 'proj-1',
      analysisVersion: 1, version: 5, payload: {},
    }
    const staleEvent: DashboardEvent = { ...event, version: 3 }

    act(() => { result.current._handleEvent(event) })
    act(() => { result.current._handleEvent(staleEvent) })

    expect(result.current.events).toHaveLength(1)
    expect(result.current.events[0].version).toBe(5)
  })

  it('drops events with wrong analysisVersion', () => {
    const { result } = renderHook(() => useAnalysisStream('proj-1'))
    act(() => {
      result.current._setRunVersion('c1', 2)
    })
    const staleRunEvent: DashboardEvent = {
      type: 'progress', scope: 'analysis', changeId: 'c1', projectId: 'proj-1',
      analysisVersion: 1, version: 6, payload: { stage: 'context_load', pct: 10 },
    }
    act(() => { result.current._handleEvent(staleRunEvent) })
    expect(result.current.events).toHaveLength(0)
  })

  it('discards synthetic events when a real event of the same type exists', () => {
    const { result } = renderHook(() => useAnalysisStream('proj-1'))
    const realStarted: DashboardEvent = {
      type: 'started', scope: 'analysis', changeId: 'c1', projectId: 'proj-1',
      analysisVersion: 1, version: 4, payload: {},
    }
    const syntheticStarted: DashboardEvent = {
      ...realStarted, version: 1, synthetic: true,
    }
    act(() => { result.current._handleEvent(realStarted) })
    act(() => { result.current._handleEvent(syntheticStarted) })

    const startedEvents = result.current.events.filter(e => e.type === 'started' && e.changeId === 'c1')
    expect(startedEvents).toHaveLength(1)
    expect(startedEvents[0].synthetic).toBeUndefined()
  })

  it('replaces synthetic event when real event of same type arrives', () => {
    const { result } = renderHook(() => useAnalysisStream('proj-1'))

    // Inject a synthetic completed event (simulating reconciliation)
    const syntheticCompleted: DashboardEvent = {
      type: 'completed', scope: 'analysis', changeId: 'c1', projectId: 'proj-1',
      analysisVersion: 0, version: 0, synthetic: true,
      payload: { outcome: 'success', fromReconciliation: true },
    }
    act(() => { result.current._handleEvent(syntheticCompleted) })
    expect(result.current.events).toHaveLength(1)
    expect(result.current.events[0].synthetic).toBe(true)

    // Real completed event arrives — should replace the synthetic
    const realCompleted: DashboardEvent = {
      type: 'completed', scope: 'analysis', changeId: 'c1', projectId: 'proj-1',
      analysisVersion: 1, version: 7, payload: { outcome: 'success' },
    }
    act(() => { result.current._handleEvent(realCompleted) })

    const completedEvents = result.current.events.filter(e => e.type === 'completed' && e.changeId === 'c1')
    expect(completedEvents).toHaveLength(1)
    expect(completedEvents[0].synthetic).toBeUndefined()
  })
})
