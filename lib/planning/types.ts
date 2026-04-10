// lib/planning/types.ts

export interface DraftPlan {
  new_file_paths: string[]
  component_names: string[]
  assumptions: string[]       // AI-inferred assumptions about the change context
  confidence: number          // 0.0–1.0, clamped; defaults to 0.5 if AI omits it
}

export interface ImpactedComponent {
  componentId: string
  name: string
  type: string
  impactWeight: number
}

export interface PlannerArchitecture {
  approach: string
  branchName: string
  testApproach: string
  estimatedFiles: number
  componentApproaches: Record<string, string>  // componentName → approach
  newFilePaths: string[]  // new files the plan requires creating
}

export interface PlannerTask {
  description: string
  componentId: string | null
  componentName: string
  orderIndex: number
  newFilePath?: string  // set when task creates a new file rather than modifying an existing one
}
