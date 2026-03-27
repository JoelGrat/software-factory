import { describe, it, expect } from 'vitest'
import { repairJson, repairAndParse } from '@/lib/ai/repair'

describe('repairJson', () => {
  it('strips markdown code fences', () => {
    const input = '```json\n{"a": 1}\n```'
    expect(JSON.parse(repairJson(input))).toEqual({ a: 1 })
  })

  it('removes trailing comma before }', () => {
    const input = '{"a": 1, "b": 2,}'
    expect(JSON.parse(repairJson(input))).toEqual({ a: 1, b: 2 })
  })

  it('removes trailing comma before ]', () => {
    const input = '[1, 2, 3,]'
    expect(JSON.parse(repairJson(input))).toEqual([1, 2, 3])
  })

  it('extracts JSON from surrounding prose', () => {
    const input = 'Here is the result:\n{"gaps": []}\nHope that helps!'
    expect(JSON.parse(repairJson(input))).toEqual({ gaps: [] })
  })

  it('handles nested objects with trailing commas', () => {
    const input = '{"outer": {"inner": "value",},}'
    expect(JSON.parse(repairJson(input))).toEqual({ outer: { inner: 'value' } })
  })
})

describe('repairAndParse', () => {
  it('parses valid JSON directly', () => {
    expect(repairAndParse<{ x: number }>('{"x": 42}')).toEqual({ x: 42 })
  })

  it('repairs and parses JSON with trailing comma', () => {
    expect(repairAndParse<{ x: number }>('{"x": 42,}')).toEqual({ x: 42 })
  })

  it('returns null for unparseable input', () => {
    expect(repairAndParse('not json at all {{{')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(repairAndParse('')).toBeNull()
  })
})
