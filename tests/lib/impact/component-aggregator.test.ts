import { describe, it, expect } from 'vitest'
import { aggregateComponents } from '@/lib/impact/component-aggregator'
import type { FileBFSResult, FileAssignment, MappedComponent } from '@/lib/impact/types'

function makeBfsResult(entries: Array<[string, number]>): FileBFSResult {
  return { reachedFileIds: new Map(entries), dynamicImportCounts: {} }
}

describe('aggregateComponents', () => {
  it('gives seed components weight 1.0 regardless of file graph', () => {
    const bfs = makeBfsResult([])
    const assignments: FileAssignment[] = []
    const seedComponents: MappedComponent[] = [{
      componentId: 'comp1', name: 'Auth', type: 'service', confidence: 90, matchReason: 'keyword: auth'
    }]
    const result = aggregateComponents(bfs, assignments, seedComponents)
    expect(result.find(c => c.componentId === 'comp1')?.weight).toBe(1.0)
    expect(result.find(c => c.componentId === 'comp1')?.source).toBe('seed')
  })

  it('maps reached files to their assigned components', () => {
    const bfs = makeBfsResult([['f1', 0.7], ['f2', 0.49]])
    const assignments: FileAssignment[] = [
      { file_id: 'f1', component_id: 'comp2' },
      { file_id: 'f2', component_id: 'comp3' },
    ]
    const result = aggregateComponents(bfs, assignments, [])
    expect(result.find(c => c.componentId === 'comp2')?.weight).toBeCloseTo(0.7)
    expect(result.find(c => c.componentId === 'comp3')?.weight).toBeCloseTo(0.49)
  })

  it('takes max weight when multiple files map to same component', () => {
    const bfs = makeBfsResult([['f1', 0.7], ['f2', 0.49]])
    const assignments: FileAssignment[] = [
      { file_id: 'f1', component_id: 'comp2' },
      { file_id: 'f2', component_id: 'comp2' },
    ]
    const result = aggregateComponents(bfs, assignments, [])
    const comp = result.find(c => c.componentId === 'comp2')
    expect(comp?.weight).toBeCloseTo(0.7)
  })

  it('seed weight (1.0) wins over file_graph weight for same component', () => {
    const bfs = makeBfsResult([['f1', 0.5]])
    const assignments: FileAssignment[] = [{ file_id: 'f1', component_id: 'comp1' }]
    const seedComponents: MappedComponent[] = [{
      componentId: 'comp1', name: 'Auth', type: 'service', confidence: 90, matchReason: 'keyword: auth'
    }]
    const result = aggregateComponents(bfs, assignments, seedComponents)
    const comp = result.find(c => c.componentId === 'comp1')
    expect(comp?.weight).toBe(1.0)
    expect(comp?.source).toBe('seed')
  })

  it('ignores files with no component assignment', () => {
    const bfs = makeBfsResult([['f_unassigned', 0.9]])
    const assignments: FileAssignment[] = []
    const result = aggregateComponents(bfs, assignments, [])
    expect(result).toHaveLength(0)
  })

  it('returns results sorted by weight descending', () => {
    const bfs = makeBfsResult([['f1', 0.3], ['f2', 0.7]])
    const assignments: FileAssignment[] = [
      { file_id: 'f1', component_id: 'comp1' },
      { file_id: 'f2', component_id: 'comp2' },
    ]
    const result = aggregateComponents(bfs, assignments, [])
    expect(result[0].weight).toBeGreaterThan(result[1].weight)
  })
})
