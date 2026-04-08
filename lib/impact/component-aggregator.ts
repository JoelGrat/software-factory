import type { FileBFSResult, FileAssignment, MappedComponent, ComponentWeight } from './types'

export function aggregateComponents(
  bfsResult: FileBFSResult,
  assignments: FileAssignment[],
  seedComponents: MappedComponent[]
): ComponentWeight[] {
  const weights = new Map<string, ComponentWeight>()

  // Seed components: weight is data-driven from match confidence
  //   keyword match → 0.5–0.9   (based on hit count)
  //   ai_mapping    → 0.70
  //   draft_plan_projection → 0.50
  //   projected_file_neighborhood → 0.65
  for (const comp of seedComponents) {
    weights.set(comp.componentId, {
      componentId: comp.componentId,
      weight: Math.min(comp.confidence / 100, 1.0),
      source: 'directly_mapped',
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
    if (!existing || fileWeight > existing.weight) {
      weights.set(componentId, {
        componentId,
        weight: fileWeight,
        source: 'via_file',
        sourceDetail: fileId,
      })
    }
  }

  return Array.from(weights.values()).sort((a, b) => b.weight - a.weight)
}
