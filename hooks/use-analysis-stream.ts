'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import type { DashboardEvent } from '@/lib/dashboard/event-types'

export type ConnectionState = 'connecting' | 'connected' | 'degraded' | 'error'

interface ActiveChangeState {
  id: string
  analysisStatus: string
  analysisVersion: number
}

interface SnapshotState {
  changeId: string
  snapshotStatus: string
  executionOutcome: string
}

interface UseAnalysisStreamResult {
  events: DashboardEvent[]
  connectionState: ConnectionState
  activeChanges: ActiveChangeState[]
  snapshots: SnapshotState[]
  /** Exposed for testing only */
  _handleEvent: (event: DashboardEvent) => void
  _setRunVersion: (changeId: string, version: number) => void
}

const POLL_INTERVAL_MS = 12_000

export function useAnalysisStream(projectId: string): UseAnalysisStreamResult {
  const [events, setEvents] = useState<DashboardEvent[]>([])
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const [activeChanges, setActiveChanges] = useState<ActiveChangeState[]>([])
  const [snapshots, setSnapshots] = useState<SnapshotState[]>([])

  const lastVersionRef = useRef<number>(0)
  const runVersionsRef = useRef<Map<string, number>>(new Map())
  const realEventsSeenRef = useRef<Map<string, Set<string>>>(new Map())

  const _setRunVersion = useCallback((changeId: string, version: number) => {
    runVersionsRef.current.set(changeId, version)
  }, [])

  const _handleEvent = useCallback((event: DashboardEvent) => {
    // 1. Drop if version <= last seen (dedup)
    if (event.version > 0 && event.version <= lastVersionRef.current) return
    if (event.version > 0) lastVersionRef.current = event.version

    // 2. Drop if analysisVersion doesn't match current run (stale run events)
    const currentRunVersion = runVersionsRef.current.get(event.changeId)
    if (
      currentRunVersion !== undefined &&
      event.analysisVersion !== currentRunVersion &&
      !event.synthetic
    ) return

    // 3. Track new analysisVersion when we see a queued/started event
    if (event.type === 'queued' || event.type === 'started') {
      runVersionsRef.current.set(event.changeId, event.analysisVersion)
    }

    // 4. Discard synthetic if we've already seen a real event of the same type for this change
    if (event.synthetic) {
      const realSeen = realEventsSeenRef.current.get(event.changeId)
      if (realSeen?.has(event.type)) return
    } else {
      if (!realEventsSeenRef.current.has(event.changeId)) {
        realEventsSeenRef.current.set(event.changeId, new Set())
      }
      realEventsSeenRef.current.get(event.changeId)!.add(event.type)
    }

    setEvents(prev => {
      const filtered = event.synthetic
        ? prev
        : prev.filter(e => !(e.changeId === event.changeId && e.type === event.type && e.synthetic))
      return [...filtered, event]
    })
  }, [])

  const reconcile = useCallback((pollSnapshots: SnapshotState[], pollActiveChanges: ActiveChangeState[]) => {
    setSnapshots(pollSnapshots)
    setActiveChanges(pollActiveChanges)

    for (const snap of pollSnapshots) {
      setEvents(prev => {
        const hasCompleted = prev.some(e => e.changeId === snap.changeId && e.type === 'completed')
        if (!hasCompleted) {
          return [...prev, {
            type: 'completed',
            scope: 'analysis',
            changeId: snap.changeId,
            projectId,
            analysisVersion: 0,
            version: 0,
            synthetic: true,
            payload: { outcome: snap.executionOutcome, fromReconciliation: true },
          } as DashboardEvent]
        }
        return prev
      })
    }
  }, [projectId])

  // SSE connection
  useEffect(() => {
    let es: EventSource | null = null
    let retries = 0
    const MAX_RETRIES = 3

    function connect() {
      const since = lastVersionRef.current
      es = new EventSource(
        `/api/projects/${projectId}/dashboard-stream${since > 0 ? `?since=${since}` : ''}`
      )

      es.addEventListener('dashboard', (e: MessageEvent) => {
        try {
          const event: DashboardEvent = JSON.parse(e.data)
          if (event.type === 'resync_required') {
            poll()
          } else {
            _handleEvent(event)
          }
          setConnectionState('connected')
          retries = 0
        } catch { /* ignore malformed events */ }
      })

      es.onerror = () => {
        es?.close()
        retries++
        if (retries >= MAX_RETRIES) {
          setConnectionState('degraded')
        } else {
          setTimeout(connect, 2000 * retries)
        }
      }
    }

    connect()
    return () => { es?.close() }
  }, [projectId, _handleEvent])

  async function poll() {
    try {
      const res = await fetch(`/api/projects/${projectId}/dashboard-poll`)
      if (!res.ok) return
      const data = await res.json()
      reconcile(data.snapshots ?? [], data.activeChanges ?? [])
    } catch { /* ignore transient failures */ }
  }

  useEffect(() => {
    poll()
    const interval = setInterval(poll, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [projectId])

  return { events, connectionState, activeChanges, snapshots, _handleEvent, _setRunVersion }
}
