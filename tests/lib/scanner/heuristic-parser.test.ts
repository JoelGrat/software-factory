import { describe, it, expect } from 'vitest'
import { HeuristicParser } from '@/lib/scanner/heuristic-parser'

const mockFetcher = { getFileTree: async () => [], getContent: async () => '' }
const emptyAliases = {}

describe('HeuristicParser', () => {
  const parser = new HeuristicParser()

  it('canParse returns true for any file list', () => {
    expect(parser.canParse([])).toBe(true)
    expect(parser.canParse(['src/foo.py', 'main.go'])).toBe(true)
  })

  it('groups files by first path segment', async () => {
    const files = ['lib/auth.ts', 'lib/utils.ts', 'app/page.tsx']
    const result = await parser.parse(files, mockFetcher, emptyAliases)
    const names = result.map(c => c.name).sort()
    expect(names).toEqual(['app', 'lib'])
  })

  it('handles files with no directory (root level)', async () => {
    const files = ['middleware.ts', 'next.config.ts']
    const result = await parser.parse(files, mockFetcher, emptyAliases)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('root')
  })

  it('classifies api directory as api type', async () => {
    const result = await parser.parse(['api/users.ts'], mockFetcher, emptyAliases)
    expect(result[0].type).toBe('api')
  })

  it('classifies routes directory as api type', async () => {
    const result = await parser.parse(['routes/auth.ts'], mockFetcher, emptyAliases)
    expect(result[0].type).toBe('api')
  })

  it('classifies components directory as ui type', async () => {
    const result = await parser.parse(['components/Button.tsx'], mockFetcher, emptyAliases)
    expect(result[0].type).toBe('ui')
  })

  it('classifies db directory as db type', async () => {
    const result = await parser.parse(['db/schema.ts'], mockFetcher, emptyAliases)
    expect(result[0].type).toBe('db')
  })

  it('classifies unknown directory as module type', async () => {
    const result = await parser.parse(['lib/scanner.ts'], mockFetcher, emptyAliases)
    expect(result[0].type).toBe('module')
  })

  it('sets unknownDependencies true on all components', async () => {
    const result = await parser.parse(['lib/foo.ts', 'app/bar.tsx'], mockFetcher, emptyAliases)
    expect(result.every(c => c.unknownDependencies)).toBe(true)
  })

  it('sets confidence to 30', async () => {
    const result = await parser.parse(['lib/foo.ts'], mockFetcher, emptyAliases)
    expect(result[0].confidence).toBe(30)
  })

  it('sets dependsOn to empty array', async () => {
    const result = await parser.parse(['lib/foo.ts'], mockFetcher, emptyAliases)
    expect(result[0].dependsOn).toEqual([])
  })

  it('sets edges to empty array', async () => {
    const result = await parser.parse(['lib/foo.ts'], mockFetcher, emptyAliases)
    expect(result[0].edges).toEqual([])
  })
})
