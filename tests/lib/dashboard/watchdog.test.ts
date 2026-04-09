import { describe, it, expect } from 'vitest'
import { isStalled, type ChangeRow, FALLBACK_THRESHOLD_MS } from '@/lib/dashboard/watchdog'

describe('isStalled', () => {
  it('returns false when stage started recently', () => {
    const change: ChangeRow = {
      last_stage_started_at: new Date(Date.now() - 30_000), // 30s ago
      expected_stage_duration_ms: 60_000, // 1 min expected
    }
    // threshold = 2 * 60000 = 120s. Elapsed = 30s. Not stalled.
    expect(isStalled(change)).toBe(false)
  })

  it('returns true when elapsed > 2x expected stage duration', () => {
    const change: ChangeRow = {
      last_stage_started_at: new Date(Date.now() - 300_000), // 5 min ago
      expected_stage_duration_ms: 60_000, // 1 min expected
    }
    // threshold = 120s. Elapsed = 300s. Stalled.
    expect(isStalled(change)).toBe(true)
  })

  it('falls back to 10 min threshold when no expected duration', () => {
    const recentChange: ChangeRow = {
      last_stage_started_at: new Date(Date.now() - (FALLBACK_THRESHOLD_MS / 2)),
      expected_stage_duration_ms: null,
    }
    expect(isStalled(recentChange)).toBe(false)

    const oldChange: ChangeRow = {
      last_stage_started_at: new Date(Date.now() - (FALLBACK_THRESHOLD_MS + 60_000)),
      expected_stage_duration_ms: null,
    }
    expect(isStalled(oldChange)).toBe(true)
  })

  it('returns false when last_stage_started_at is null (stage not yet started)', () => {
    const change: ChangeRow = {
      last_stage_started_at: null,
      expected_stage_duration_ms: null,
    }
    expect(isStalled(change)).toBe(false)
  })
})
