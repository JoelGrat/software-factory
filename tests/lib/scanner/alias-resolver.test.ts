import { describe, it, expect } from 'vitest'
import { buildAliasMap } from '@/lib/scanner/alias-resolver'

describe('buildAliasMap', () => {
  it('maps @/* paths from tsconfig', () => {
    const tsconfig = JSON.stringify({
      compilerOptions: {
        paths: { '@/*': ['./src/*'] }
      }
    })
    const map = buildAliasMap(tsconfig)
    expect(map['@/']).toBe('src/')
  })

  it('handles multiple aliases', () => {
    const tsconfig = JSON.stringify({
      compilerOptions: {
        paths: {
          '@/*': ['./src/*'],
          '@lib/*': ['./src/lib/*'],
        }
      }
    })
    const map = buildAliasMap(tsconfig)
    expect(map['@/']).toBe('src/')
    expect(map['@lib/']).toBe('src/lib/')
  })

  it('returns empty map when no paths configured', () => {
    const tsconfig = JSON.stringify({ compilerOptions: {} })
    expect(buildAliasMap(tsconfig)).toEqual({})
  })

  it('returns empty map on malformed JSON', () => {
    expect(buildAliasMap('{ not json')).toEqual({})
  })

  it('returns empty map when compilerOptions missing', () => {
    expect(buildAliasMap(JSON.stringify({}))).toEqual({})
  })

  it('handles tsconfig with JSON comments', () => {
    const tsconfig = `{
      // this is a comment
      "compilerOptions": {
        "paths": { "@/*": ["./src/*"] }
      }
    }`
    const map = buildAliasMap(tsconfig)
    expect(map['@/']).toBe('src/')
  })
})
