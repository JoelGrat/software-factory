import { describe, it, expect } from 'vitest'
import { runFileBFS } from '@/lib/impact/file-bfs'
import type { SeedFile, FileGraphEdge } from '@/lib/impact/types'

// Edge semantics: from_file_id IMPORTS to_file_id.
// BFS direction: REVERSE (callers of changed file).
// Seed = file being changed. BFS finds who might break (callers).
//
// Example: edge { from: UI, to: AuthService } means UI imports AuthService.
//   Seed = AuthService (we changed it).
//   BFS finds UI (it imports AuthService → might break).

describe('runFileBFS', () => {
  it('includes seed files at weight 1.0', () => {
    const seeds: SeedFile[] = [{ fileId: 'f1', reason: 'component_match' }]
    const result = runFileBFS(seeds, [])
    expect(result.reachedFileIds.get('f1')).toBe(1.0)
  })

  it('finds direct caller at static decay 0.7', () => {
    // f1 imports f2 — if we change f2, f1 might break
    const seeds: SeedFile[] = [{ fileId: 'f2', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f1', to_file_id: 'f2', edge_type: 'static' },
    ]
    const result = runFileBFS(seeds, edges)
    expect(result.reachedFileIds.get('f1')).toBeCloseTo(0.7)
  })

  it('does NOT reach dependencies of the changed file (forward direction is wrong)', () => {
    // f2 imports f3 — changing f2 does NOT affect f3 (it's a dependency, not a caller)
    const seeds: SeedFile[] = [{ fileId: 'f2', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f2', to_file_id: 'f3', edge_type: 'static' },
    ]
    const result = runFileBFS(seeds, edges)
    expect(result.reachedFileIds.has('f3')).toBe(false)
  })

  it('finds re-export caller at 0.8 decay', () => {
    const seeds: SeedFile[] = [{ fileId: 'f2', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f1', to_file_id: 'f2', edge_type: 're-export' },
    ]
    const result = runFileBFS(seeds, edges)
    expect(result.reachedFileIds.get('f1')).toBeCloseTo(0.8)
  })

  it('propagates transitively through caller chain', () => {
    // f1 imports f2, f2 imports f3 — changing f3 affects f2 (0.7) and then f1 (0.7 * 0.7 = 0.49)
    const seeds: SeedFile[] = [{ fileId: 'f3', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f2', to_file_id: 'f3', edge_type: 'static' },
      { from_file_id: 'f1', to_file_id: 'f2', edge_type: 'static' },
    ]
    const result = runFileBFS(seeds, edges)
    expect(result.reachedFileIds.get('f2')).toBeCloseTo(0.7)
    expect(result.reachedFileIds.get('f1')).toBeCloseTo(0.49)
    expect(result.predecessors.get('f3')).toBe('seed')
    expect(result.predecessors.get('f2')).toBe('f3')
    expect(result.predecessors.get('f1')).toBe('f2')
  })

  it('stops propagation when weight drops below 0.1', () => {
    // Long caller chain — eventually weight decays below MIN_WEIGHT
    const seeds: SeedFile[] = [{ fileId: 'f8', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f7', to_file_id: 'f8', edge_type: 'static' },
      { from_file_id: 'f6', to_file_id: 'f7', edge_type: 'static' },
      { from_file_id: 'f5', to_file_id: 'f6', edge_type: 'static' },
      { from_file_id: 'f4', to_file_id: 'f5', edge_type: 'static' },
      { from_file_id: 'f3', to_file_id: 'f4', edge_type: 'static' },
      { from_file_id: 'f2', to_file_id: 'f3', edge_type: 'static' },
      { from_file_id: 'f1', to_file_id: 'f2', edge_type: 'static' }, // 0.7^7 = 0.082 < 0.1 → stop
    ]
    const result = runFileBFS(seeds, edges, { depth_limit: 10 })
    expect(result.reachedFileIds.has('f7')).toBe(true)
    expect(result.reachedFileIds.has('f1')).toBe(false)
  })

  it('keeps max weight when multiple callers reach the same file transitively', () => {
    // f1 imports f3 (direct, 0.7) and f2 imports f3 via re-export (0.8)
    // Both f1 and f2 are callers — f1 at 0.7, f2 at 0.8
    const seeds: SeedFile[] = [{ fileId: 'f3', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f1', to_file_id: 'f3', edge_type: 'static' },
      { from_file_id: 'f2', to_file_id: 'f3', edge_type: 're-export' },
    ]
    const result = runFileBFS(seeds, edges)
    expect(result.reachedFileIds.get('f1')).toBeCloseTo(0.7)
    expect(result.reachedFileIds.get('f2')).toBeCloseTo(0.8)
  })

  it('counts dynamic imports but does not traverse them', () => {
    const seeds: SeedFile[] = [{ fileId: 'f2', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f1', to_file_id: 'f2', edge_type: 'dynamic' },
    ]
    const result = runFileBFS(seeds, edges)
    // f1 dynamically imports f2 — counted but not traversed for further propagation
    expect(result.reachedFileIds.has('f1')).toBe(false)
    expect(result.dynamicImportCounts['f1']).toBe(1)
  })

  it('respects maxDepth', () => {
    const seeds: SeedFile[] = [{ fileId: 'f3', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f2', to_file_id: 'f3', edge_type: 'static' },
      { from_file_id: 'f1', to_file_id: 'f2', edge_type: 'static' },
    ]
    const result = runFileBFS(seeds, edges, { depth_limit: 1 })
    expect(result.reachedFileIds.has('f2')).toBe(true)
    expect(result.reachedFileIds.has('f1')).toBe(false)
  })

  it('handles empty seeds gracefully', () => {
    const result = runFileBFS([], [])
    expect(result.reachedFileIds.size).toBe(0)
    expect(result.dynamicImportCounts).toEqual({})
  })
})
