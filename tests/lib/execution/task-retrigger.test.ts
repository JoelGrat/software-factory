import { describe, it, expect } from 'vitest'
import { collectDownstreamIds } from '@/lib/execution/task-retrigger'

interface T { id: string; dependencies: string[] }

describe('collectDownstreamIds', () => {
  it('returns only the target when it has no dependents', () => {
    const tasks: T[] = [
      { id: 'A', dependencies: [] },
      { id: 'B', dependencies: [] },
    ]
    expect(collectDownstreamIds('A', tasks)).toEqual(new Set(['A']))
  })

  it('includes direct dependent', () => {
    const tasks: T[] = [
      { id: 'A', dependencies: [] },
      { id: 'B', dependencies: ['A'] },
    ]
    expect(collectDownstreamIds('A', tasks)).toEqual(new Set(['A', 'B']))
  })

  it('includes transitive dependents recursively', () => {
    const tasks: T[] = [
      { id: 'A', dependencies: [] },
      { id: 'B', dependencies: ['A'] },
      { id: 'C', dependencies: ['B'] },
      { id: 'D', dependencies: ['C'] },
    ]
    expect(collectDownstreamIds('A', tasks)).toEqual(new Set(['A', 'B', 'C', 'D']))
  })

  it('does not include tasks in a parallel branch', () => {
    const tasks: T[] = [
      { id: 'A', dependencies: [] },
      { id: 'B', dependencies: ['A'] },
      { id: 'X', dependencies: [] },
      { id: 'Y', dependencies: ['X'] },
    ]
    const result = collectDownstreamIds('A', tasks)
    expect(result.has('X')).toBe(false)
    expect(result.has('Y')).toBe(false)
    expect(result).toEqual(new Set(['A', 'B']))
  })

  it('handles diamond dependency without duplicates', () => {
    // A -> B -> D
    // A -> C -> D
    const tasks: T[] = [
      { id: 'A', dependencies: [] },
      { id: 'B', dependencies: ['A'] },
      { id: 'C', dependencies: ['A'] },
      { id: 'D', dependencies: ['B', 'C'] },
    ]
    expect(collectDownstreamIds('A', tasks)).toEqual(new Set(['A', 'B', 'C', 'D']))
  })
})
