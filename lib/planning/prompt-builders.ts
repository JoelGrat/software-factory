// lib/planning/prompt-builders.ts
import type { ImpactedComponent, PlannerArchitecture, PlannerTask } from './types'

export function buildArchitecturePrompt(
  change: { title: string; intent: string; type: string },
  components: ImpactedComponent[]
): string {
  const componentList = components
    .map(c => `- ${c.name} (type: ${c.type}, impact: ${Math.round(c.impactWeight * 100)}%)`)
    .join('\n')

  return `You are planning the implementation of a software change.

Change: ${change.title}
Type: ${change.type}
Intent: ${change.intent}

Impacted components (from impact analysis):
${componentList}

Design the high-level approach for implementing this change.
For each component, describe what needs to change and how.

Respond with JSON:
{
  "approach": "One paragraph describing the overall implementation approach",
  "branchName": "sf/xxxxxx-short-slug",
  "testApproach": "Brief testing strategy",
  "estimatedFiles": 5,
  "componentApproaches": {
    "ComponentName": "Approach for this component"
  }
}`
}

export function buildComponentTasksPrompt(
  change: { title: string; intent: string },
  component: ImpactedComponent,
  approach: string
): string {
  return `You are generating implementation tasks for a specific component.

Change: ${change.title}
Intent: ${change.intent}

Component: ${component.name} (${component.type})
Approach: ${approach}

Generate 3–7 specific, actionable implementation tasks for this component.
Each task should be completable in under an hour.
Focus only on work needed for this change — not general improvements.

Respond with JSON:
{
  "tasks": [
    { "description": "Specific task description" }
  ]
}`
}

export function buildSpecPrompt(
  change: { title: string; intent: string; type: string },
  architecture: PlannerArchitecture,
  tasks: PlannerTask[]
): string {
  const tasksByComponent: Record<string, string[]> = {}
  for (const task of tasks) {
    if (!tasksByComponent[task.componentName]) tasksByComponent[task.componentName] = []
    tasksByComponent[task.componentName].push(`${task.orderIndex + 1}. ${task.description}`)
  }

  const taskSection = Object.entries(tasksByComponent)
    .map(([comp, descs]) => `### ${comp}\n${descs.join('\n')}`)
    .join('\n\n')

  return `Write an implementation specification for this software change.

## Change
Title: ${change.title}
Type: ${change.type}
Intent: ${change.intent}

## Approach
${architecture.approach}

## Testing Strategy
${architecture.testApproach}

## Tasks by Component
${taskSection}

Write a clear markdown spec covering: overview, approach per component, task breakdown, and testing notes.
Be concise — this is a working document for a developer, not a design doc.`
}
