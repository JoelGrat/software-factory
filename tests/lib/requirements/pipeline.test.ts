import { describe, it, expect, vi } from 'vitest'
import { runPipeline } from '@/lib/requirements/pipeline'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

/** Minimal Supabase client stub */
function makeDbStub() {
  const inserts: Record<string, unknown[]> = {}
  let statusValue = 'draft'

  const chainable = (table: string) => ({
    insert: (data: unknown) => {
      inserts[table] = inserts[table] ?? []
      ;(inserts[table] as unknown[]).push(data)
      return {
        select: () => ({ data: [{ id: 'fake-id' }], error: null }),
        data: [{ id: 'fake-id' }],
        error: null,
      }
    },
    update: (data: unknown) => {
      if (table === 'requirements' && typeof data === 'object' && data !== null && 'status' in data) {
        statusValue = (data as { status: string }).status
      }
      return {
        eq: () => ({ data: null, error: null }),
        in: () => ({ data: null, error: null }),
      }
    },
    delete: () => ({ eq: () => ({ data: null, error: null }) }),
    select: (_cols?: string) => ({
      eq: (_col?: string, _val?: unknown) => ({
        single: () => ({ data: { raw_input: 'some text' }, error: null }),
        data: [],
        error: null,
      }),
      data: [],
      error: null,
    }),
  })

  return {
    from: (table: string) => chainable(table),
    _inserts: inserts,
    _getStatus: () => statusValue,
  }
}

describe('runPipeline', () => {
  it('returns success when all steps pass', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ items: [] }))
    const db = makeDbStub() as unknown as Parameters<typeof runPipeline>[3]
    const result = await runPipeline('req-1', 'some input', 'user-1', db, mock)
    expect(result.success).toBe(true)
    expect(result.steps.parse).toBe('ok')
  })

  it('returns failure when parse step throws', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse('not valid json at all')
    const db = makeDbStub() as unknown as Parameters<typeof runPipeline>[3]
    const result = await runPipeline('req-1', 'some input', 'user-1', db, mock)
    expect(result.success).toBe(false)
    expect(result.steps.parse).toBe('error')
  })
})
