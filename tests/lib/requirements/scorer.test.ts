import { describe, it, expect } from 'vitest'
import { computeScore } from '@/lib/requirements/scorer'
import type { DetectedGap } from '@/lib/requirements/gap-detector'
import type { ParsedItem } from '@/lib/requirements/parser'

const nfrItem: ParsedItem = {
  type: 'non-functional',
  title: 'Perf',
  description: 'Response under 200ms',
  priority: 'high',
  source_text: 'x',
  nfr_category: 'performance',
}
const secItem: ParsedItem = {
  type: 'non-functional',
  title: 'Auth',
  description: 'Auth via OAuth',
  priority: 'high',
  source_text: 'x',
  nfr_category: 'security',
}
const auditItem: ParsedItem = {
  type: 'non-functional',
  title: 'Audit',
  description: 'All actions audited',
  priority: 'medium',
  source_text: 'x',
  nfr_category: 'auditability',
}

const noGaps: DetectedGap[] = []
const noMergedPairs = new Set<number>()

describe('computeScore', () => {
  it('returns 100 completeness and 100 nfr when no gaps and all NFR categories covered', () => {
    const result = computeScore(noGaps, noMergedPairs, [nfrItem, secItem, auditItem])
    expect(result.completeness).toBe(100)
    expect(result.nfr_score).toBe(100)
    expect(result.overall_score).toBe(100)
  })

  it('deducts 20 per critical gap', () => {
    const critGap: DetectedGap = {
      item_id: null,
      severity: 'critical',
      category: 'missing',
      description: 'x',
      source: 'rule',
      rule_id: 'x',
      priority_score: 9,
      confidence: 100,
      question_generated: false,
    }
    const result = computeScore([critGap], noMergedPairs, [nfrItem, secItem, auditItem])
    expect(result.completeness).toBe(80)
  })

  it('deducts 10 per major gap and 3 per minor gap', () => {
    const majorGap: DetectedGap = {
      item_id: null,
      severity: 'major',
      category: 'missing',
      description: 'x',
      source: 'ai',
      rule_id: null,
      priority_score: 6,
      confidence: 80,
      question_generated: false,
    }
    const minorGap: DetectedGap = {
      item_id: null,
      severity: 'minor',
      category: 'incomplete',
      description: 'x',
      source: 'ai',
      rule_id: null,
      priority_score: 1,
      confidence: 60,
      question_generated: false,
    }
    const result = computeScore([majorGap, minorGap], noMergedPairs, [])
    expect(result.completeness).toBe(87) // 100 - 10 - 3
  })

  it('skips merged gaps in scoring', () => {
    const critGap: DetectedGap = {
      item_id: null,
      severity: 'critical',
      category: 'missing',
      description: 'x',
      source: 'rule',
      rule_id: 'x',
      priority_score: 9,
      confidence: 100,
      question_generated: false,
    }
    // Index 0 is merged — should not count
    const mergedIndices = new Set([0])
    const result = computeScore([critGap], mergedIndices, [])
    expect(result.completeness).toBe(100) // merged gap excluded
  })

  it('clamps completeness at 0', () => {
    const critGaps = Array.from({ length: 6 }, (_, i): DetectedGap => ({
      item_id: null,
      severity: 'critical',
      category: 'missing',
      description: `gap ${i}`,
      source: 'rule',
      rule_id: 'x',
      priority_score: 9,
      confidence: 100,
      question_generated: false,
    }))
    const result = computeScore(critGaps, noMergedPairs, [])
    expect(result.completeness).toBe(0)
  })

  it('computes nfr_score as partial coverage', () => {
    const result = computeScore(noGaps, noMergedPairs, [nfrItem]) // only performance
    expect(result.nfr_score).toBe(33)
  })

  it('computes overall_score as 70% completeness + 30% nfr', () => {
    const result = computeScore(noGaps, noMergedPairs, [nfrItem, secItem]) // 67 nfr, 100 completeness
    expect(result.overall_score).toBe(Math.round(100 * 0.7 + 67 * 0.3))
  })

  it('computes confidence as average of AI-sourced gap confidences', () => {
    const aiGap1: DetectedGap = {
      item_id: null,
      severity: 'minor',
      category: 'incomplete',
      description: 'x',
      source: 'ai',
      rule_id: null,
      priority_score: 1,
      confidence: 80,
      question_generated: false,
    }
    const aiGap2: DetectedGap = {
      item_id: null,
      severity: 'minor',
      category: 'ambiguous',
      description: 'x',
      source: 'ai',
      rule_id: null,
      priority_score: 2,
      confidence: 60,
      question_generated: false,
    }
    const result = computeScore([aiGap1, aiGap2], noMergedPairs, [])
    expect(result.confidence).toBe(70) // (80+60)/2
  })

  it('returns confidence 100 when all gaps are rule-sourced', () => {
    const ruleGap: DetectedGap = {
      item_id: null,
      severity: 'critical',
      category: 'missing',
      description: 'x',
      source: 'rule',
      rule_id: 'x',
      priority_score: 9,
      confidence: 100,
      question_generated: false,
    }
    const result = computeScore([ruleGap], noMergedPairs, [])
    expect(result.confidence).toBe(100)
  })
})
