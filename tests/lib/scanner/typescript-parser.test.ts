import { describe, it, expect } from 'vitest'
import { scoreComponentType, detectAnchoredPath, groupFilesByComponent } from '@/lib/scanner/typescript-parser'

describe('scoreComponentType', () => {
  it('returns api when hasHttpHandlers', () => {
    expect(scoreComponentType({ hasHttpHandlers: true, hasJsx: false, hasDbCalls: false })).toBe('api')
  })
  it('returns ui when hasJsx', () => {
    expect(scoreComponentType({ hasHttpHandlers: false, hasJsx: true, hasDbCalls: false })).toBe('ui')
  })
  it('returns db when hasDbCalls', () => {
    expect(scoreComponentType({ hasHttpHandlers: false, hasJsx: false, hasDbCalls: true })).toBe('db')
  })
  it('returns service when no specific signals', () => {
    expect(scoreComponentType({ hasHttpHandlers: false, hasJsx: false, hasDbCalls: false })).toBe('service')
  })
  it('api wins over ui when both signals present', () => {
    expect(scoreComponentType({ hasHttpHandlers: true, hasJsx: true, hasDbCalls: false })).toBe('api')
  })
})

describe('detectAnchoredPath', () => {
  it('anchors paths under app/api/', () => {
    expect(detectAnchoredPath('app/api/projects/route.ts')).toBe(true)
  })
  it('anchors paths under api/', () => {
    expect(detectAnchoredPath('api/users.ts')).toBe(true)
  })
  it('anchors migration files', () => {
    expect(detectAnchoredPath('supabase/migrations/001_init.sql')).toBe(true)
  })
  it('anchors schema.prisma', () => {
    expect(detectAnchoredPath('prisma/schema.prisma')).toBe(true)
  })
  it('does not anchor regular files', () => {
    expect(detectAnchoredPath('lib/auth/token.ts')).toBe(false)
    expect(detectAnchoredPath('components/Button.tsx')).toBe(false)
  })
})

describe('groupFilesByComponent', () => {
  it('groups by second path segment', () => {
    const groups = groupFilesByComponent(['lib/auth/token.ts', 'lib/auth/session.ts', 'lib/utils.ts'])
    expect(groups.get('lib/auth')).toEqual(['lib/auth/token.ts', 'lib/auth/session.ts'])
    expect(groups.get('lib/utils')).toEqual(['lib/utils.ts'])
  })
  it('uses first segment when no second', () => {
    const groups = groupFilesByComponent(['middleware.ts'])
    expect(groups.get('middleware')).toEqual(['middleware.ts'])
  })
  it('uses second segment when file is directly in first-level dir', () => {
    const groups = groupFilesByComponent(['lib/index.ts'])
    expect(groups.get('lib/index')).toEqual(['lib/index.ts'])
  })
})
