import { describe, it, expect } from 'vitest'
import { shouldReassign, isComponentUnstable } from '@/lib/scanner/scan-helpers'

describe('shouldReassign', () => {
  it('returns true when confidence gap > 25 and cooldown met', () => {
    expect(shouldReassign(50, 80, 3)).toBe(true)
  })
  it('returns true when confidence gap > 25 and exactly 3 scans since move', () => {
    expect(shouldReassign(50, 80, 3)).toBe(true)
  })
  it('returns false when confidence gap > 25 but cooldown not met', () => {
    expect(shouldReassign(50, 80, 2)).toBe(false)
  })
  it('returns false when confidence gap exactly 25 (not > 25)', () => {
    expect(shouldReassign(50, 75, 5)).toBe(false)
  })
  it('overrides cooldown when confidence gap > 50', () => {
    expect(shouldReassign(20, 80, 1)).toBe(true)
  })
  it('overrides cooldown at exactly > 50 gap', () => {
    expect(shouldReassign(20, 71, 0)).toBe(true)
  })
  it('does NOT override cooldown at exactly 50 gap', () => {
    expect(shouldReassign(20, 70, 0)).toBe(false)
  })
  it('returns false when new confidence is lower', () => {
    expect(shouldReassign(80, 50, 10)).toBe(false)
  })
})

describe('isComponentUnstable', () => {
  it('returns true when reassignmentCount > 3', () => {
    expect(isComponentUnstable(4, 80)).toBe(true)
  })
  it('returns false at exactly 3 reassignments', () => {
    expect(isComponentUnstable(3, 80)).toBe(false)
  })
  it('returns true when avgConfidence < 40', () => {
    expect(isComponentUnstable(0, 39)).toBe(true)
  })
  it('returns false at exactly 40 confidence', () => {
    expect(isComponentUnstable(0, 40)).toBe(false)
  })
  it('returns false when both are within bounds', () => {
    expect(isComponentUnstable(2, 75)).toBe(false)
  })
})
