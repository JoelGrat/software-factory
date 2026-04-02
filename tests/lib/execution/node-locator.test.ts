// tests/lib/execution/node-locator.test.ts
import { describe, it, expect } from 'vitest'
import { Project, SyntaxKind } from 'ts-morph'
import { buildLocator, resolveNode } from '@/lib/execution/node-locator'

const SOURCE = `
function greet(name: string): string {
  return 'Hello ' + name
}

function farewell(name: string): string {
  return 'Goodbye ' + name
}
`.trim()

function makeSourceFile(code = SOURCE) {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  return project.createSourceFile('test.ts', code, { overwrite: true })
}

describe('buildLocator', () => {
  it('builds a locator from a function node', () => {
    const sf = makeSourceFile()
    const fn = sf.getFunctions()[0]!
    const locator = buildLocator('test.ts', fn)
    expect(locator.primary).toBeTypeOf('string')
    expect(locator.fallbacks.symbolName).toBe('greet')
    expect(locator.fallbacks.kind).toBe(SyntaxKind.FunctionDeclaration)
  })
})

describe('resolveNode', () => {
  it('resolves node by primary hash', () => {
    const sf = makeSourceFile()
    const fn = sf.getFunctions()[0]!
    const locator = buildLocator('test.ts', fn)
    const resolved = resolveNode(sf, locator)
    expect(resolved).not.toBeNull()
    expect(resolved!.getText()).toContain('greet')
  })

  it('falls back to symbolName when primary hash does not match', () => {
    const sf = makeSourceFile()
    const fn = sf.getFunctions()[0]!
    const locator = buildLocator('test.ts', fn)
    // corrupt primary so it won't match
    const staleLocator = { ...locator, primary: 'stale-hash-000' }
    const resolved = resolveNode(sf, staleLocator)
    expect(resolved).not.toBeNull()
    expect(resolved!.getText()).toContain('greet')
  })

  it('returns null when multiple nodes match a fallback', () => {
    // two functions with same name at slightly different positions
    const code = `
function dupe(x: string): string { return x }
function dupe(x: number): number { return x }
`.trim()
    const sf = makeSourceFile(code)
    const locator = {
      primary: 'no-match',
      fallbacks: {
        symbolName: 'dupe',
        kind: SyntaxKind.FunctionDeclaration,
        approximatePosition: { line: 1, toleranceLines: 5 },
        structureSignature: 'any',
      },
    }
    const resolved = resolveNode(sf, locator)
    expect(resolved).toBeNull()
  })

  it('returns null when no node matches', () => {
    const sf = makeSourceFile()
    const locator = {
      primary: 'no-match',
      fallbacks: {
        symbolName: 'nonexistent',
        kind: SyntaxKind.FunctionDeclaration,
        approximatePosition: { line: 99, toleranceLines: 2 },
        structureSignature: 'no-match',
      },
    }
    expect(resolveNode(sf, locator)).toBeNull()
  })
})
