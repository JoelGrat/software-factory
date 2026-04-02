// tests/lib/execution/failure-classifier.test.ts
import { describe, it, expect } from 'vitest'
import { classifyFailure, FAILURE_PRIORITY } from '@/lib/execution/failure-classifier'

describe('classifyFailure', () => {
  it('classifies TypeScript syntax error', () => {
    const output = "src/user.ts(5,3): error TS1005: ';' expected."
    expect(classifyFailure(output)).toBe('syntax')
  })

  it('classifies TypeScript type error', () => {
    const output = "src/user.ts(10,1): error TS2322: Type 'string' is not assignable to type 'number'."
    expect(classifyFailure(output)).toBe('type')
  })

  it('classifies test failure from vitest output', () => {
    const output = `
 FAIL  tests/user.test.ts
  ● getUser › returns user by id
    Expected: "user-1"
    Received: undefined
`.trim()
    expect(classifyFailure(output)).toBe('test')
  })

  it('classifies timeout', () => {
    expect(classifyFailure('Error: execution timed out after 600000ms')).toBe('timeout')
  })

  it('returns runtime for unrecognised errors', () => {
    expect(classifyFailure('ReferenceError: Cannot read properties of undefined')).toBe('runtime')
  })
})

describe('FAILURE_PRIORITY', () => {
  it('syntax has highest priority (lowest number)', () => {
    expect(FAILURE_PRIORITY.syntax).toBeLessThan(FAILURE_PRIORITY.type)
    expect(FAILURE_PRIORITY.type).toBeLessThan(FAILURE_PRIORITY.runtime)
    expect(FAILURE_PRIORITY.runtime).toBeLessThan(FAILURE_PRIORITY.test)
  })
})
