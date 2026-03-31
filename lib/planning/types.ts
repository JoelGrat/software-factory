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
}

export interface PlannerTask {
  description: string
  componentId: string
  componentName: string
  orderIndex: number
}
