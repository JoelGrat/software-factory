// tests/lib/execution/symbol-extractor.test.ts
import { describe, it, expect } from 'vitest'
import { extractSymbol } from '@/lib/execution/symbol-extractor'

const SOURCE = `
import { UserRepo } from './user-repo'
import type { User } from './types'

export async function getUser(id: string): Promise<User> {
  const repo = new UserRepo()
  if (!id) throw new Error('id required')
  return repo.findById(id)
}

export function formatUser(user: User): string {
  return user.name
}
`.trim()

describe('extractSymbol', () => {
  it('extracts function code', () => {
    const ctx = extractSymbol('src/user.ts', SOURCE, 'getUser', [])
    expect(ctx).not.toBeNull()
    expect(ctx!.code).toContain('getUser')
    expect(ctx!.symbolName).toBe('getUser')
  })

  it('extracts callees from function body', () => {
    const ctx = extractSymbol('src/user.ts', SOURCE, 'getUser', [])
    expect(ctx!.callees).toContain('findById')
  })

  it('extracts related types from signature', () => {
    const ctx = extractSymbol('src/user.ts', SOURCE, 'getUser', [])
    expect(ctx!.relatedTypes).toContain('User')
  })

  it('computes complexity as line count', () => {
    const ctx = extractSymbol('src/user.ts', SOURCE, 'getUser', [])
    expect(ctx!.complexity).toBeGreaterThan(1)
  })

  it('includes caller file paths passed in', () => {
    const ctx = extractSymbol('src/user.ts', SOURCE, 'getUser', ['src/controller.ts'])
    expect(ctx!.callers).toContain('src/controller.ts')
  })

  it('returns null for unknown symbol name', () => {
    expect(extractSymbol('src/user.ts', SOURCE, 'nonexistent', [])).toBeNull()
  })

  it('builds a NodeLocator with the correct symbol name', () => {
    const ctx = extractSymbol('src/user.ts', SOURCE, 'getUser', [])
    expect(ctx!.locator.fallbacks.symbolName).toBe('getUser')
  })
})
