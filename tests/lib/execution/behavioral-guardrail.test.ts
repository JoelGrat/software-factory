// tests/lib/execution/behavioral-guardrail.test.ts
import { describe, it, expect } from 'vitest'
import { checkBehavior } from '@/lib/execution/behavioral-guardrail'

describe('checkBehavior', () => {
  it('passes clean before/after with no anomalies', () => {
    const before = `function getUser(id: string) {\n  if (!id) return null\n  return db.find(id)\n}`
    const after  = `function getUser(id: string) {\n  if (!id) return null\n  return db.find(id + '-v2')\n}`
    const result = checkBehavior(before, after)
    expect(result.passed).toBe(true)
    expect(result.anomalies).toHaveLength(0)
  })

  it('detects removed conditional', () => {
    const before = `function getUser(id: string) {\n  if (!id) throw new Error()\n  return db.find(id)\n}`
    const after  = `function getUser(id: string) {\n  return db.find(id)\n}`
    const result = checkBehavior(before, after)
    const types = result.anomalies.map(a => a.type)
    expect(types).toContain('removed_conditional')
  })

  it('detects exception swallowing (empty catch)', () => {
    const before = `function load() { return fetch('/api') }`
    const after  = `function load() { try { return fetch('/api') } catch (e) {} }`
    const result = checkBehavior(before, after)
    const types = result.anomalies.map(a => a.type)
    expect(types).toContain('exception_swallowing')
  })

  it('detects added early return in a conditional branch', () => {
    const before = `function run(x: number) {\n  if (x > 0) {\n    process(x)\n  }\n}`
    const after  = `function run(x: number) {\n  if (x > 0) {\n    return\n  }\n  process(x)\n}`
    const result = checkBehavior(before, after)
    const types = result.anomalies.map(a => a.type)
    expect(types).toContain('early_return')
  })
})
