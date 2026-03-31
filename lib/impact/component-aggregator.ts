import type { FileBFSResult, FileAssignment, MappedComponent, ComponentWeight } from './types'

export function aggregateComponents(
  bfsResult: FileBFSResult,
  assignments: FileAssignment[],
  seedComponents: MappedComponent[]
): ComponentWeight[] {
  const weights = new Map<string, ComponentWeight>()

  // Seed components always win at weight 1.0
  for (const comp of seedComponents) {
    weights.set(comp.componentId, {
      componentId: comp.componentId,
      weight: 1.0,
      source: 'seed',
      sourceDetail: comp.matchReason,
    })
  }

  // File graph: file weight → component weight (take max)
  const fileToComponent = new Map<string, string>()
  for (const a of assignments) fileToComponent.set(a.file_id, a.component_id)

  for (const [fileId, fileWeight] of bfsResult.reachedFileIds) {
    const componentId = fileToComponent.get(fileId)
    if (!componentId) continue
    const existing = weights.get(componentId)
    if (!existing || (existing.source !== 'seed' && fileWeight > existing.weight)) {
      weights.set(componentId, {
        componentId,
        weight: fileWeight,
        source: 'file_graph',
        sourceDetail: fileId,
      })
    }
  }

  return Array.from(weights.values()).sort((a, b) => b.weight - a.weight)
}
