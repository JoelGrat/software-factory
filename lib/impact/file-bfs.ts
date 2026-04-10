import type { SeedFile, FileGraphEdge, FileBFSResult } from './types'

export interface BFSConfig {
  re_export?: number
  static_import?: number
  component_dependency?: number
  depth_limit?: number
  min_weight_threshold?: number
}

const DEFAULT_BFS_CONFIG: Required<BFSConfig> = {
  re_export: 0.8,
  static_import: 0.7,
  component_dependency: 0.6,
  depth_limit: 3,
  min_weight_threshold: 0.1,
}

export function runFileBFS(
  seeds: SeedFile[],
  edges: FileGraphEdge[],
  config: BFSConfig = {}
): FileBFSResult {
  const cfg: Required<BFSConfig> = { ...DEFAULT_BFS_CONFIG, ...config }

  const EDGE_DECAY: Record<string, number> = {
    static: cfg.static_import,
    're-export': cfg.re_export,
    component_dependency: cfg.component_dependency,
  }

  // Build REVERSE adjacency: to_file → [from_file, ...]
  // Semantics: edge (from, to) means "from imports to".
  // For blast-radius analysis we want: "if I change X, who might break?"
  // Answer = files that IMPORT X (directly or transitively) = callers of X.
  // BFS from seed=X follows reverse edges to reach its callers.
  const adjacency = new Map<string, Array<{ target: string; type: string }>>()
  for (const edge of edges) {
    if (!adjacency.has(edge.to_file_id)) adjacency.set(edge.to_file_id, [])
    adjacency.get(edge.to_file_id)!.push({ target: edge.from_file_id, type: edge.edge_type })
  }

  const reachedFileIds = new Map<string, number>()
  const dynamicImportCounts: Record<string, number> = {}
  const predecessors = new Map<string, string>()

  const queue: Array<{ fileId: string; weight: number; depth: number }> = []
  let head = 0
  for (const seed of seeds) {
    reachedFileIds.set(seed.fileId, 1.0)
    predecessors.set(seed.fileId, 'seed')
    queue.push({ fileId: seed.fileId, weight: 1.0, depth: 0 })
  }

  while (head < queue.length) {
    const { fileId, weight, depth } = queue[head++]
    if (depth >= cfg.depth_limit) continue

    for (const { target, type } of adjacency.get(fileId) ?? []) {
      if (type === 'dynamic') {
        dynamicImportCounts[target] = (dynamicImportCounts[target] ?? 0) + 1
        continue
      }
      const decay = EDGE_DECAY[type] ?? cfg.static_import
      const newWeight = weight * decay
      if (newWeight < cfg.min_weight_threshold) continue
      const existing = reachedFileIds.get(target) ?? 0
      if (newWeight > existing) {
        reachedFileIds.set(target, newWeight)
        predecessors.set(target, fileId)
        queue.push({ fileId: target, weight: newWeight, depth: depth + 1 })
      }
    }
  }

  return { reachedFileIds, dynamicImportCounts, predecessors }
}
