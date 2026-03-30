import { describe, it, expect } from 'vitest'
import { runFileBFS } from '@/lib/impact/file-bfs'
import type { SeedFile, FileGraphEdge } from '@/lib/impact/types'

describe('runFileBFS', () => {
  it('includes seed files at weight 1.0', () => {
    const seeds: SeedFile[] = [{ fileId: 'f1', reason: 'component_match' }]
    const result = runFileBFS(seeds, [])
    expect(result.reachedFileIds.get('f1')).toBe(1.0)
  })

  it('propagates static edges with 0.7 decay', () => {
    const seeds: SeedFile[] = [{ fileId: 'f1', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f1', to_file_id: 'f2', edge_type: 'static' },
    ]
    const result = runFileBFS(seeds, edges)
    expect(result.reachedFileIds.get('f2')).toBeCloseTo(0.7)
  })

  it('propagates re-export edges with 0.8 decay', () => {
    const seeds: SeedFile[] = [{ fileId: 'f1', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f1', to_file_id: 'f2', edge_type: 're-export' },
    ]
    const result = runFileBFS(seeds, edges)
    expect(result.reachedFileIds.get('f2')).toBeCloseTo(0.8)
  })

  it('stops propagation when weight drops below 0.1', () => {
    const seeds: SeedFile[] = [{ fileId: 'f1', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f1', to_file_id: 'f2', edge_type: 'static' }, // 0.7
      { from_file_id: 'f2', to_file_id: 'f3', edge_type: 'static' }, // 0.49
      { from_file_id: 'f3', to_file_id: 'f4', edge_type: 'static' }, // 0.343
      { from_file_id: 'f4', to_file_id: 'f5', edge_type: 'static' }, // 0.24
      { from_file_id: 'f5', to_file_id: 'f6', edge_type: 'static' }, // 0.168
      { from_file_id: 'f6', to_file_id: 'f7', edge_type: 'static' }, // 0.117
      { from_file_id: 'f7', to_file_id: 'f8', edge_type: 'static' }, // 0.082 < 0.1 → STOP
    ]
    const result = runFileBFS(seeds, edges)
    expect(result.reachedFileIds.has('f8')).toBe(false)
    expect(result.reachedFileIds.has('f7')).toBe(true)
  })

  it('keeps max weight when multiple paths reach same file', () => {
    const seeds: SeedFile[] = [
      { fileId: 'f1', reason: 'component_match' },
      { fileId: 'f2', reason: 'component_match' },
    ]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f1', to_file_id: 'f3', edge_type: 'static' }, // 0.7
      { from_file_id: 'f2', to_file_id: 'f3', edge_type: 're-export' }, // 0.8
    ]
    const result = runFileBFS(seeds, edges)
    expect(result.reachedFileIds.get('f3')).toBeCloseTo(0.8)
  })

  it('counts dynamic imports but does not traverse them', () => {
    const seeds: SeedFile[] = [{ fileId: 'f1', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f1', to_file_id: 'f2', edge_type: 'dynamic' },
    ]
    const result = runFileBFS(seeds, edges)
    expect(result.reachedFileIds.has('f2')).toBe(false)
    expect(result.dynamicImportCounts['f2']).toBe(1)
  })

  it('respects maxDepth', () => {
    const seeds: SeedFile[] = [{ fileId: 'f1', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f1', to_file_id: 'f2', edge_type: 'static' },
      { from_file_id: 'f2', to_file_id: 'f3', edge_type: 'static' },
    ]
    const result = runFileBFS(seeds, edges, 1)
    expect(result.reachedFileIds.has('f2')).toBe(true)
    expect(result.reachedFileIds.has('f3')).toBe(false)
  })

  it('handles empty seeds gracefully', () => {
    const result = runFileBFS([], [])
    expect(result.reachedFileIds.size).toBe(0)
    expect(result.dynamicImportCounts).toEqual({})
  })
})
