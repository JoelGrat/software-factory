import { describe, it, expect } from 'vitest'
import { computeStatusFromScore, resolveGap } from '@/lib/requirements/re-evaluator'
import type { Gap } from '@/lib/supabase/types'

const makeGap = (overrides: Partial<Gap> = {}): Gap => ({
  id: 'g1',
  requirement_id: 'r1',
  item_id: null,
  severity: 'critical',
  category: 'missing',
  description: 'x',
  source: 'rule',
  rule_id: 'x',
  priority_score: 9,
  confidence: 100,
  question_generated: false,
  merged_into: null,
  resolved_at: null,
  resolution_source: null,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
})

describe('resolveGap', () => {
  it('returns gap with resolved_at set', () => {
    const resolved = resolveGap(makeGap(), 'question_answered')
    expect(resolved.resolved_at).not.toBeNull()
    expect(resolved.resolution_source).toBe('question_answered')
  })
})

describe('computeStatusFromScore', () => {
  it('returns incomplete when critical gaps remain unresolved', () => {
    const status = computeStatusFromScore([makeGap({ severity: 'critical', resolved_at: null })])
    expect(status).toBe('incomplete')
  })

  it('returns review_required when only major gaps remain unresolved', () => {
    const status = computeStatusFromScore([makeGap({ severity: 'major', resolved_at: null })])
    expect(status).toBe('review_required')
  })

  it('returns ready_for_dev when only minor gaps remain (minor does not block)', () => {
    const status = computeStatusFromScore([makeGap({ severity: 'minor', resolved_at: null })])
    expect(status).toBe('ready_for_dev')
  })

  it('returns ready_for_dev when all gaps are resolved', () => {
    const status = computeStatusFromScore([makeGap({ resolved_at: '2026-01-02T00:00:00Z' })])
    expect(status).toBe('ready_for_dev')
  })

  it('returns ready_for_dev when no gaps at all', () => {
    expect(computeStatusFromScore([])).toBe('ready_for_dev')
  })

  it('ignores merged gaps when computing status', () => {
    // A critical gap that is merged should not count
    const status = computeStatusFromScore([makeGap({ severity: 'critical', merged_into: 'other-gap-id' })])
    expect(status).toBe('ready_for_dev')
  })
})
