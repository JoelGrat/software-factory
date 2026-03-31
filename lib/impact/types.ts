export type SeedReason = 'keyword_match' | 'component_match' | 'direct_mention'
export type ImpactSource = 'seed' | 'file_graph'

export interface SeedFile {
  fileId: string
  reason: SeedReason
}

export interface FileGraphEdge {
  from_file_id: string
  to_file_id: string
  edge_type: 'static' | 're-export' | 'component_dependency' | 'dynamic' | string
}

export interface FileAssignment {
  file_id: string
  component_id: string
}

export interface FileBFSResult {
  reachedFileIds: Map<string, number>
  dynamicImportCounts: Record<string, number>
}

export interface MappedComponent {
  componentId: string
  name: string
  type: string
  confidence: number
  matchReason: string
}

export interface ComponentMapResult {
  seedFileIds: string[]
  components: MappedComponent[]
  aiUsed: boolean
}

export interface ComponentWeight {
  componentId: string
  weight: number
  source: ImpactSource
  sourceDetail: string
}

export interface RiskFactors {
  blastRadius: number
  unknownDepsCount: number
  hasLowConfidenceComponents: boolean
  componentTypes: string[]
  dynamicImportCount: number
}

export interface RiskScoreResult {
  score: number
  riskLevel: 'low' | 'medium' | 'high'
  primaryRiskFactor: string
  confidenceBreakdown: Record<string, number>
}
