// tests/lib/execution/prompt-builders.test.ts
import { describe, it, expect } from 'vitest'
import {
  buildSymbolPatchPrompt,
  buildMultiSymbolPatchPrompt,
  buildFilePatchPrompt,
} from '@/lib/execution/prompt-builders'
import type { SymbolContext } from '@/lib/execution/types'

const CTX: SymbolContext = {
  symbolName: 'getUser',
  filePath: 'src/user.ts',
  code: 'function getUser(id: string): User { return db.find(id) }',
  locator: { primary: 'abc', fallbacks: { kind: 0, approximatePosition: { line: 1, toleranceLines: 5 }, structureSignature: 'xyz' } },
  callers: ['src/controller.ts'],
  callees: ['find'],
  relatedTypes: ['User'],
  complexity: 3,
}

const TASK = { description: 'Add caching to getUser', intent: 'Reduce DB calls' }

describe('buildSymbolPatchPrompt', () => {
  it('includes task intent and description', () => {
    const p = buildSymbolPatchPrompt(TASK, CTX)
    expect(p).toContain('Add caching to getUser')
    expect(p).toContain('Reduce DB calls')
  })

  it('includes the symbol code', () => {
    const p = buildSymbolPatchPrompt(TASK, CTX)
    expect(p).toContain('function getUser')
  })

  it('includes the allowed symbols', () => {
    const p = buildSymbolPatchPrompt(TASK, CTX)
    expect(p).toContain('getUser')
  })

  it('includes previous error when provided', () => {
    const p = buildSymbolPatchPrompt(TASK, CTX, 'TypeError: cache is undefined')
    expect(p).toContain('TypeError: cache is undefined')
  })

  it('asks for confidence and requiresPropagation in JSON output', () => {
    const p = buildSymbolPatchPrompt(TASK, CTX)
    expect(p).toContain('confidence')
    expect(p).toContain('requiresPropagation')
    expect(p).toContain('newContent')
  })
})

describe('buildMultiSymbolPatchPrompt', () => {
  it('includes all symbol names', () => {
    const p = buildMultiSymbolPatchPrompt(TASK, [CTX, { ...CTX, symbolName: 'saveUser' }])
    expect(p).toContain('getUser')
    expect(p).toContain('saveUser')
  })
})

describe('buildFilePatchPrompt', () => {
  it('includes the full file content', () => {
    const p = buildFilePatchPrompt(TASK, 'full file content here', CTX.filePath)
    expect(p).toContain('full file content here')
  })
})
