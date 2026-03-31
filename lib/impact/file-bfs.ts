import type { SeedFile, FileGraphEdge, FileBFSResult } from './types'

const EDGE_DECAY: Record<string, number> = {
  static: 0.7,
  're-export': 0.8,
  component_dependency: 0.6,
}
const MIN_WEIGHT = 0.1

export function runFileBFS(
  seeds: SeedFile[],
  edges: FileGraphEdge[],
  maxDepth = 3
): FileBFSResult {
  const adjacency = new Map<string, Array<{ target: string; type: string }>>()
  for (const edge of edges) {
    if (!adjacency.has(edge.from_file_id)) adjacency.set(edge.from_file_id, [])
    adjacency.get(edge.from_file_id)!.push({ target: edge.to_file_id, type: edge.edge_type })
  }

  const reachedFileIds = new Map<string, number>()
  const dynamicImportCounts: Record<string, number> = {}

  const queue: Array<{ fileId: string; weight: number; depth: number }> = []
  for (const seed of seeds) {
    reachedFileIds.set(seed.fileId, 1.0)
    queue.push({ fileId: seed.fileId, weight: 1.0, depth: 0 })
  }

  while (queue.length > 0) {
    const { fileId, weight, depth } = queue.shift()!
    if (depth >= maxDepth) continue

    for (const { target, type } of adjacency.get(fileId) ?? []) {
      if (type === 'dynamic') {
        dynamicImportCounts[target] = (dynamicImportCounts[target] ?? 0) + 1
        continue
      }
      const decay = EDGE_DECAY[type] ?? 0.7
      const newWeight = weight * decay
      if (newWeight < MIN_WEIGHT) continue
      const existing = reachedFileIds.get(target) ?? 0
      if (newWeight > existing) {
        reachedFileIds.set(target, newWeight)
        queue.push({ fileId: target, weight: newWeight, depth: depth + 1 })
      }
    }
  }

  return { reachedFileIds, dynamicImportCounts }
}
