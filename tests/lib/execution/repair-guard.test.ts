import { describe, it, expect } from 'vitest'
import { isPathAllowed, filterPathsToAllowed } from '@/lib/execution/repair-guard'

describe('isPathAllowed', () => {
  it('allows app/ files', () => {
    expect(isPathAllowed('app/dashboard/page.tsx')).toBe(true)
  })

  it('allows lib/ files', () => {
    expect(isPathAllowed('lib/execution/foo.ts')).toBe(true)
  })

  it('blocks .env files', () => {
    expect(isPathAllowed('.env')).toBe(false)
    expect(isPathAllowed('.env.local')).toBe(false)
    expect(isPathAllowed('.env.production')).toBe(false)
  })

  it('blocks migration files', () => {
    expect(isPathAllowed('supabase/migrations/001_init.sql')).toBe(false)
  })

  it('blocks package.json', () => {
    expect(isPathAllowed('package.json')).toBe(false)
    expect(isPathAllowed('package-lock.json')).toBe(false)
  })

  it('blocks secret key files', () => {
    expect(isPathAllowed('certs/server.pem')).toBe(false)
    expect(isPathAllowed('keys/private.key')).toBe(false)
  })

  it('blocks files outside allowed dirs', () => {
    expect(isPathAllowed('scripts/deploy.sh')).toBe(false)
  })
})

describe('filterPathsToAllowed', () => {
  it('filters out blocked paths and keeps allowed ones', () => {
    const paths = ['app/page.tsx', '.env.local', 'lib/foo.ts', 'package.json']
    expect(filterPathsToAllowed(paths)).toEqual(['app/page.tsx', 'lib/foo.ts'])
  })
})
