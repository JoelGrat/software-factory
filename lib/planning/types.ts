// lib/planning/types.ts

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
  componentId: string
  componentName: string
  orderIndex: number
  newFilePath?: string  // set when task creates a new file rather than modifying an existing one
}
