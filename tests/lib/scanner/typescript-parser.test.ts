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
  it('splits signal-named files into sub-components at 3 segments', () => {
    const groups = groupFilesByComponent([
      'lib/supabase/client.ts',
      'lib/supabase/server.ts',
      'lib/supabase/admin.ts',
      'lib/supabase/types.ts',   // no signal — stays grouped
    ])
    expect(groups.get('lib/supabase/client')).toEqual(['lib/supabase/client.ts'])
    expect(groups.get('lib/supabase/server')).toEqual(['lib/supabase/server.ts'])
    expect(groups.get('lib/supabase/admin')).toEqual(['lib/supabase/admin.ts'])
    expect(groups.get('lib/supabase')).toEqual(['lib/supabase/types.ts'])
    expect(groups.has('lib/supabase/types')).toBe(false)
  })
  it('does not split signal-named files at 4+ segments', () => {
    const groups = groupFilesByComponent(['app/api/auth/[id]/service.ts'])
    expect(groups.get('app/api')).toBeDefined()
    expect(groups.has('app/api/service')).toBe(false)
  })
  it('split signal check is case-insensitive', () => {
    const groups = groupFilesByComponent(['lib/db/Service.ts'])
    expect(groups.get('lib/db/service')).toEqual(['lib/db/Service.ts'])
  })
})

import { extractImports, TypeScriptParser } from '@/lib/scanner/typescript-parser'
import type { FileFetcher } from '@/lib/scanner/types'

describe('extractImports', () => {
  it('extracts static imports', () => {
    const source = `import { foo } from './bar'`
    const result = extractImports('test.ts', source)
    expect(result).toContainEqual({ fromPath: 'test.ts', toSpecifier: './bar', edgeType: 'static' })
  })

  it('classifies re-exports', () => {
    const source = `export { foo } from './qux'`
    const result = extractImports('test.ts', source)
    expect(result).toContainEqual({ fromPath: 'test.ts', toSpecifier: './qux', edgeType: 're-export' })
  })

  it('classifies dynamic import with string literal', () => {
    const source = `const mod = import('./dynamic')`
    const result = extractImports('test.ts', source)
    expect(result).toContainEqual({ fromPath: 'test.ts', toSpecifier: './dynamic', edgeType: 'dynamic-static-string' })
  })

  it('returns empty array for file with no imports', () => {
    const source = `export const x = 1`
    expect(extractImports('test.ts', source)).toEqual([])
  })
})

describe('TypeScriptParser', () => {
  it('canParse returns true when tsconfig.json present', () => {
    const parser = new TypeScriptParser()
    expect(parser.canParse(['tsconfig.json', 'src/index.ts'])).toBe(true)
  })

  it('canParse returns true when next.config.ts present', () => {
    const parser = new TypeScriptParser()
    expect(parser.canParse(['next.config.ts', 'app/page.tsx'])).toBe(true)
  })

  it('canParse returns false for non-TS project', () => {
    const parser = new TypeScriptParser()
    expect(parser.canParse(['main.py', 'requirements.txt'])).toBe(false)
  })

  it('parse produces components grouped by directory', async () => {
    const parser = new TypeScriptParser()
    const mockFetcher: FileFetcher = {
      getFileTree: async () => [],
      getContent: async (path: string) => {
        if (path === 'lib/auth/token.ts') return `import { createClient } from '@supabase/supabase-js'`
        if (path === 'app/api/auth/route.ts') return `export async function GET(req: Request) {}`
        return ''
      },
    }
    const files = ['tsconfig.json', 'lib/auth/token.ts', 'app/api/auth/route.ts']
    const components = await parser.parse(files, mockFetcher, { '@/': '' })
    expect(components.length).toBeGreaterThan(0)
    const authComponent = components.find(c => c.name === 'lib/auth')
    expect(authComponent).toBeDefined()
    expect(authComponent?.type).toBe('db')  // imports supabase client → db signal
    const apiComponent = components.find(c => c.name === 'app/api')
    expect(apiComponent).toBeDefined()
    expect(apiComponent?.type).toBe('api')  // HTTP handler signal
  })

  it('populate dependsOn when one component imports from another via alias', async () => {
    const parser = new TypeScriptParser()
    const mockFetcher: FileFetcher = {
      getFileTree: async () => [],
      getContent: async (path: string) => {
        if (path === 'lib/auth/token.ts') return `export function getToken() {}`
        if (path === 'app/api/auth/route.ts') return `import { getToken } from '@/lib/auth/token'\nexport async function GET(req: Request) {}`
        return ''
      },
    }
    const files = ['lib/auth/token.ts', 'app/api/auth/route.ts']
    const components = await parser.parse(files, mockFetcher, { '@/': '' })
    const apiComponent = components.find(c => c.name === 'app/api')
    expect(apiComponent?.dependsOn).toContain('lib/auth')
  })

  it('populate dependsOn via relative imports', async () => {
    const parser = new TypeScriptParser()
    const mockFetcher: FileFetcher = {
      getFileTree: async () => [],
      getContent: async (path: string) => {
        if (path === 'lib/utils/format.ts') return `export function fmt(s: string) { return s }`
        if (path === 'lib/auth/token.ts') return `import { fmt } from '../utils/format'`
        return ''
      },
    }
    const files = ['lib/utils/format.ts', 'lib/auth/token.ts']
    const components = await parser.parse(files, mockFetcher, {})
    const authComponent = components.find(c => c.name === 'lib/auth')
    expect(authComponent?.dependsOn).toContain('lib/utils')
  })
})
