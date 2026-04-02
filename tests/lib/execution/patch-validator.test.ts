import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { validatePatch } from '@/lib/execution/patch-validator'
import { buildLocator } from '@/lib/execution/node-locator'
import type { FilePatch } from '@/lib/execution/types'

const SOURCE = `
export function getUser(id: string): string {
  return id
}
export function other(): void {}
`.trim()

function makeSourceFile(code = SOURCE) {
  const p = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  return p.createSourceFile('user.ts', code, { overwrite: true })
}

function makePatch(overrides: Partial<FilePatch> = {}): FilePatch {
  const sf = makeSourceFile()
  const fn = sf.getFunctions()[0]!
  return {
    path: 'src/user.ts',
    locator: buildLocator('user.ts', fn),
    originalContent: fn.getText(),
    newContent: `function getUser(id: string): string {\n  return id + '-updated'\n}`,
    confidence: 80,
    requiresPropagation: false,
    allowedChanges: { symbols: ['getUser'], intent: 'update getUser' },
    ...overrides,
  }
}

describe('validatePatch', () => {
  it('passes a valid patch', () => {
    const sf = makeSourceFile()
    const result = validatePatch(sf, makePatch())
    expect(result.valid).toBe(true)
  })

  it('rejects when locator resolves to symbol not in allowedChanges', () => {
    const sf = makeSourceFile()
    // locator points to getUser but allowedChanges says only 'other'
    const patch = makePatch({
      allowedChanges: { symbols: ['other'], intent: 'update other' },
    })
    const result = validatePatch(sf, patch)
    expect(result.valid).toBe(false)
    expect(result.stage).toBe('intent')
  })

  it('rejects when newContent is invalid TypeScript syntax', () => {
    const sf = makeSourceFile()
    const patch = makePatch({ newContent: 'function getUser( {{{' })
    const result = validatePatch(sf, patch)
    expect(result.valid).toBe(false)
    expect(result.stage).toBe('syntax')
  })

  it('rejects when originalContent does not match current node text', () => {
    const sf = makeSourceFile()
    const patch = makePatch({ originalContent: 'function getUser() { return "stale" }' })
    const result = validatePatch(sf, patch)
    expect(result.valid).toBe(false)
    expect(result.stage).toBe('stale')
  })
})
