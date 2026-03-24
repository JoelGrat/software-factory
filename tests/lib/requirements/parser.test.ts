import { describe, it, expect } from 'vitest'
import { parseRequirements } from '@/lib/requirements/parser'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

describe('parseRequirements', () => {
  it('extracts items from raw text', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({
      items: [
        {
          type: 'functional',
          title: 'User login',
          description: 'Users must be able to log in with email and password.',
          priority: 'high',
          source_text: 'Users must be able to log in',
          nfr_category: null,
        },
        {
          type: 'non-functional',
          title: 'Response time under 200ms',
          description: 'All API responses must complete within 200ms.',
          priority: 'medium',
          source_text: 'response time under 200ms',
          nfr_category: 'performance',
        },
      ],
    }))

    const result = await parseRequirements('Users must be able to log in. Response time under 200ms.', mock)
    expect(result).toHaveLength(2)
    expect(result[0].type).toBe('functional')
    expect(result[1].nfr_category).toBe('performance')
  })

  it('throws if AI returns invalid JSON', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse('not json at all')
    await expect(parseRequirements('some text', mock)).rejects.toThrow('AI provider returned invalid JSON')
  })

  it('returns empty array when AI returns empty items list', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ items: [] }))
    const result = await parseRequirements('', mock)
    expect(result).toHaveLength(0)
  })
})
