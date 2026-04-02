import { describe, it, expect } from 'vitest'
import { PropagationManager } from '@/lib/execution/propagation-manager'
import type { PropagationItem } from '@/lib/execution/types'

function item(filePath: string, symbolName = 'fn'): PropagationItem {
  return { filePath, symbolName, reason: 'test' }
}

describe('PropagationManager', () => {
  it('enqueues and dequeues items', () => {
    const mgr = new PropagationManager(10)
    mgr.enqueue(item('src/a.ts'))
    expect(mgr.dequeue()).toMatchObject({ filePath: 'src/a.ts' })
    expect(mgr.dequeue()).toBeNull()
  })

  it('does not re-enqueue visited symbols', () => {
    const mgr = new PropagationManager(10)
    mgr.enqueue(item('src/a.ts', 'fn'))
    mgr.markVisited('src/a.ts', 'fn')
    mgr.enqueue(item('src/a.ts', 'fn'))  // should be ignored
    expect(mgr.size()).toBe(1)  // only the first enqueue counts
  })

  it('reports isAtCap when queue reaches limit', () => {
    const mgr = new PropagationManager(2)
    mgr.enqueue(item('a.ts'))
    mgr.enqueue(item('b.ts'))
    expect(mgr.isAtCap()).toBe(true)
  })

  it('tracks unique added file paths', () => {
    const mgr = new PropagationManager(10)
    mgr.enqueue(item('src/a.ts'))
    mgr.enqueue(item('src/a.ts', 'other'))  // same file, different symbol
    mgr.enqueue(item('src/b.ts'))
    expect(mgr.getAddedFilePaths()).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('does not enqueue when already at cap', () => {
    const mgr = new PropagationManager(1)
    mgr.enqueue(item('a.ts'))
    mgr.enqueue(item('b.ts'))
    expect(mgr.size()).toBe(1)
  })
})
