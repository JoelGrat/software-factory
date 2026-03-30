import { describe, it, expect } from 'vitest'
import {
  validateCreateChangeRequest,
  validatePatchChangeRequest,
} from '@/lib/change-requests/validator'

describe('validateCreateChangeRequest', () => {
  const valid = {
    title: 'Fix auth bug',
    intent: 'Users cannot log in with OAuth providers',
    type: 'bug',
    priority: 'high',
    tags: ['auth', 'critical'],
  }

  it('accepts a valid create payload', () => {
    const result = validateCreateChangeRequest(valid)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.data.title).toBe('Fix auth bug')
      expect(result.data.type).toBe('bug')
      expect(result.data.priority).toBe('high')
      expect(result.data.tags).toEqual(['auth', 'critical'])
    }
  })

  it('defaults priority to medium when missing', () => {
    const result = validateCreateChangeRequest({ ...valid, priority: undefined })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.data.priority).toBe('medium')
  })

  it('defaults tags to empty array when missing', () => {
    const result = validateCreateChangeRequest({ ...valid, tags: undefined })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.data.tags).toEqual([])
  })

  it('trims whitespace from title and intent', () => {
    const result = validateCreateChangeRequest({ ...valid, title: '  Fix auth  ', intent: '  Users cannot log in  ' })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.data.title).toBe('Fix auth')
      expect(result.data.intent).toBe('Users cannot log in')
    }
  })

  it('rejects missing title', () => {
    const result = validateCreateChangeRequest({ ...valid, title: '' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('title')
  })

  it('rejects missing intent', () => {
    const result = validateCreateChangeRequest({ ...valid, intent: '' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('intent')
  })

  it('rejects invalid type', () => {
    const result = validateCreateChangeRequest({ ...valid, type: 'unknown' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('type')
  })

  it('rejects non-object input', () => {
    expect(validateCreateChangeRequest(null)).toEqual({ valid: false, error: 'body must be an object' })
    expect(validateCreateChangeRequest('string')).toEqual({ valid: false, error: 'body must be an object' })
  })
})

describe('validatePatchChangeRequest', () => {
  it('accepts a valid title update', () => {
    const result = validatePatchChangeRequest({ title: 'New title' })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.updates.title).toBe('New title')
  })

  it('accepts a valid priority update', () => {
    const result = validatePatchChangeRequest({ priority: 'low' })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.updates.priority).toBe('low')
  })

  it('accepts a valid tags update', () => {
    const result = validatePatchChangeRequest({ tags: ['a', 'b'] })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.updates.tags).toEqual(['a', 'b'])
  })

  it('rejects empty payload', () => {
    const result = validatePatchChangeRequest({})
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('nothing')
  })

  it('rejects invalid priority', () => {
    const result = validatePatchChangeRequest({ priority: 'urgent' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('priority')
  })

  it('rejects tags that are not strings', () => {
    const result = validatePatchChangeRequest({ tags: [1, 2] })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('tags')
  })

  it('rejects empty title', () => {
    const result = validatePatchChangeRequest({ title: '  ' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('title')
  })
})
