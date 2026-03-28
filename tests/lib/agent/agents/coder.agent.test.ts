import { describe, it, expect } from 'vitest'
import { runCoderAgent } from '@/lib/agent/agents/coder.agent'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

const requirements = [
  { type: 'functional' as const, title: 'Login', description: 'Login', priority: 'high' as const, source_text: 'Login', nfr_category: null },
]

const plan = {
  tasks: [{ id: 'task-1', title: 'Add login', description: 'Add login', files: ['src/login.ts'], dependencies: [] }],
  files_to_create: ['src/login.ts'],
  files_to_modify: [],
  test_approach: 'Unit tests',
  branch_name: 'sf/abc-add-login',
  spec_markdown: null,
}

describe('runCoderAgent', () => {
  it('returns file changes', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({
      changes: [{ path: 'src/login.ts', content: 'export function login() {}', operation: 'create' }],
    }))

    const result = await runCoderAgent(requirements, plan, [], {}, mock)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('src/login.ts')
    expect(result[0].operation).toBe('create')
  })

  it('includes previous errors in prompt context (agent runs)', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ changes: [] }))

    await runCoderAgent(requirements, plan, ['TypeError: x is undefined'], {}, mock)
    expect(mock.callCount).toBe(1)
  })
})
