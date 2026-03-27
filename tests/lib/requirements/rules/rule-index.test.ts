import { describe, it, expect } from 'vitest'
import { selectRulePack } from '@/lib/requirements/rules/index'

describe('selectRulePack', () => {
  it('returns 10 rules for domain=general', () => {
    const rules = selectRulePack('general')
    expect(rules).toHaveLength(10)
  })

  it('returns 10 rules for domain=null (defaults to general)', () => {
    const rules = selectRulePack(null)
    expect(rules).toHaveLength(10)
  })

  it('returns 13 rules for domain=saas (10 core + 3 saas)', () => {
    const rules = selectRulePack('saas')
    expect(rules).toHaveLength(13)
  })

  it('returns 13 rules for domain=fintech (10 core + 3 fintech)', () => {
    const rules = selectRulePack('fintech')
    expect(rules).toHaveLength(13)
  })

  it('returns 13 rules for domain=workflow (10 core + 3 workflow)', () => {
    const rules = selectRulePack('workflow')
    expect(rules).toHaveLength(13)
  })

  it('every rule has id, check, severity, category, description', () => {
    const rules = selectRulePack('saas')
    for (const rule of rules) {
      expect(typeof rule.id).toBe('string')
      expect(typeof rule.check).toBe('function')
      expect(['critical', 'major', 'minor']).toContain(rule.severity)
      expect(typeof rule.description).toBe('string')
    }
  })

  it('saas pack contains hasBillingDefined rule', () => {
    const rules = selectRulePack('saas')
    expect(rules.some(r => r.id === 'hasBillingDefined')).toBe(true)
  })

  it('fintech pack contains hasAuditTrailDefined rule', () => {
    const rules = selectRulePack('fintech')
    expect(rules.some(r => r.id === 'hasAuditTrailDefined')).toBe(true)
  })

  it('general pack does NOT contain domain-specific rules', () => {
    const rules = selectRulePack('general')
    const ids = rules.map(r => r.id)
    expect(ids).not.toContain('hasBillingDefined')
    expect(ids).not.toContain('hasRollbackDefined')
  })
})
