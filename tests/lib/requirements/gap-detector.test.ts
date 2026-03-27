import { describe, it, expect } from 'vitest'
import { detectGaps } from '@/lib/requirements/gap-detector'
import { MockAIProvider } from '@/lib/ai/adapters/mock'
import type { ParsedItem } from '@/lib/requirements/parser'

const minimalItems: ParsedItem[] = [
  {
    type: 'functional',
    title: 'User login',
    description: 'Users log in with email.',
    priority: 'high',
    source_text: 'Users log in with email.',
    nfr_category: null,
  },
]

describe('detectGaps', () => {
  it('fires rule gaps when rules fail', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ gaps: [] }))
    const { gaps } = await detectGaps(minimalItems, null, mock)
    // minimalItems has no actors, no approval role, no workflow states, no NFR, no error handling
    const ruleGaps = gaps.filter(g => g.source === 'rule')
    expect(ruleGaps.length).toBeGreaterThanOrEqual(4)
    expect(ruleGaps.every(g => g.confidence === 100)).toBe(true)
  })

  it('includes AI gaps tagged source=ai', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({
      gaps: [{
        item_id: null,
        severity: 'major',
        category: 'missing',
        description: 'No data retention policy specified.',
        confidence: 85,
      }],
    }))
    const { gaps } = await detectGaps(minimalItems, null, mock)
    const aiGaps = gaps.filter(g => g.source === 'ai')
    expect(aiGaps).toHaveLength(1)
    expect(aiGaps[0].confidence).toBe(85)
  })

  it('computes priority_score as impact × uncertainty', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ gaps: [] }))
    const { gaps } = await detectGaps(minimalItems, null, mock)
    const criticalMissing = gaps.find(g => g.severity === 'critical' && g.category === 'missing')
    expect(criticalMissing).toBeDefined()
    expect(criticalMissing!.priority_score).toBe(9) // 3 × 3
  })

  it('returns mergedPairs when duplicate gaps exist', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({
      gaps: [
        { item_id: 'item-0', severity: 'minor', category: 'missing', description: 'Gap A', confidence: 70 },
        { item_id: 'item-0', severity: 'major', category: 'missing', description: 'Gap B', confidence: 80 },
      ],
    }))
    const { mergedPairs } = await detectGaps(minimalItems, null, mock)
    expect(mergedPairs.length).toBeGreaterThanOrEqual(1)
    const pair = mergedPairs[0]
    expect(typeof pair.survivorIndex).toBe('number')
    expect(typeof pair.mergedIndex).toBe('number')
  })

  it('all gaps have question_generated false by default', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ gaps: [] }))
    const { gaps } = await detectGaps(minimalItems, null, mock)
    expect(gaps.every(g => g.question_generated === false)).toBe(true)
  })
})

describe('detectGaps — domain packs', () => {
  it('fires hasBillingDefined for saas domain when no billing item present', async () => {
    const items: ParsedItem[] = [
      { type: 'functional', title: 'Login', description: 'User logs in with email.', priority: 'high', source_text: null, nfr_category: null },
    ]
    const mock = new MockAIProvider()
    mock.setDefaultResponse('{"gaps":[]}')
    const result = await detectGaps(items, 'saas', mock)
    expect(result.gaps.some(g => g.rule_id === 'hasBillingDefined')).toBe(true)
  })

  it('does NOT fire hasBillingDefined for general domain', async () => {
    const items: ParsedItem[] = [
      { type: 'functional', title: 'Login', description: 'User logs in.', priority: 'high', source_text: null, nfr_category: null },
    ]
    const mock = new MockAIProvider()
    mock.setDefaultResponse('{"gaps":[]}')
    const result = await detectGaps(items, 'general', mock)
    expect(result.gaps.some(g => g.rule_id === 'hasBillingDefined')).toBe(false)
  })
})

describe('detectGaps — validated defaults', () => {
  it('rule gaps have validated=true', async () => {
    const items: ParsedItem[] = [
      { type: 'functional', title: 'Process order', description: 'System processes orders.', priority: 'high', source_text: null, nfr_category: null },
    ]
    const mock = new MockAIProvider()
    mock.setDefaultResponse('{"gaps":[]}')
    const result = await detectGaps(items, null, mock)
    const ruleGaps = result.gaps.filter(g => g.source === 'rule')
    expect(ruleGaps.length).toBeGreaterThan(0)
    expect(ruleGaps.every(g => g.validated === true)).toBe(true)
  })

  it('AI gaps have validated=false', async () => {
    const items: ParsedItem[] = [
      { type: 'functional', title: 'Admin user', description: 'Admin approves orders, defines workflow states.', priority: 'high', source_text: null, nfr_category: null },
    ]
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ gaps: [{ severity: 'major', category: 'ambiguous', description: 'Role scope unclear.', confidence: 80 }] }))
    const result = await detectGaps(items, null, mock)
    const aiGaps = result.gaps.filter(g => g.source === 'ai')
    expect(aiGaps.length).toBeGreaterThan(0)
    expect(aiGaps.every(g => g.validated === false)).toBe(true)
  })
})
