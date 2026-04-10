export type SeedReason = 'keyword_match' | 'component_match' | 'direct_mention'
export type ImpactSource = 'directly_mapped' | 'via_file'

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
  predecessors: Map<string, string>  // fileId → predecessor fileId (or 'seed')
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

export interface ImpactFeedback {
  risk_level: 'low' | 'medium' | 'high'
  reasons: string[]
  uncertainty: number           // 0.0 (certain) to 1.0 (very uncertain)
  new_file_count: number        // files the draft plan intends to create
  new_file_in_critical_domain: boolean  // any new file touches auth/db/security/payment
  new_edges_created: number     // neighborhood components inferred from projected files
}
