// tests/lib/dashboard/event-types.test.ts
import { describe, it, expect } from 'vitest'
import type { DashboardEvent } from '@/lib/dashboard/event-types'

describe('DashboardEvent', () => {
  it('accepts a minimal queued event', () => {
    const event: DashboardEvent = {
      type: 'queued',
      scope: 'analysis',
      changeId: 'c1',
      projectId: 'p1',
      analysisVersion: 1,
      version: 1,
      payload: {},
    }
    expect(event.type).toBe('queued')
  })

  it('accepts synthetic flag', () => {
    const event: DashboardEvent = {
      type: 'progress',
      scope: 'analysis',
      changeId: 'c1',
      projectId: 'p1',
      analysisVersion: 1,
      version: 2,
      synthetic: true,
      payload: { stage: 'context_load', pct: 10 },
    }
    expect(event.synthetic).toBe(true)
  })
})
