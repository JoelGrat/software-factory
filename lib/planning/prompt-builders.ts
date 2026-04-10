// lib/planning/prompt-builders.ts
import type { ImpactedComponent, PlannerArchitecture, PlannerTask } from './types'
import type { ImpactFeedback } from '@/lib/impact/types'

export function buildArchitecturePrompt(
  change: { title: string; intent: string; type: string },
  components: ImpactedComponent[],
  feedback?: ImpactFeedback,
  assumptions: string[] = []
): string {
  const componentList = components
    .map(c => `- ${c.name} (type: ${c.type}, impact: ${Math.round(c.impactWeight * 100)}%)`)
    .join('\n')

  const assumptionsSection = assumptions.length > 0
    ? `\nInitial assumptions from draft analysis:\n${assumptions.map(a => `- ${a}`).join('\n')}\n`
    : ''

  let riskSection = ''
  if (feedback && feedback.risk_level !== 'low') {
    const factors = feedback.reasons.join(', ') || 'unspecified'
    // Constraint budget: safety through isolation, not proliferation.
    // Cap = 2 tasks per component + 2 for new files, floored at 6.
    const maxTasks = Math.max(components.length * 2 + (feedback.new_file_count > 0 ? 2 : 0), 6)
    const newFileNote = feedback.new_file_count > 0
      ? `New files introduced: ${feedback.new_file_count}${feedback.new_file_in_critical_domain ? ' (critical domain — auth/db/security)' : ''}.${feedback.new_edges_created > 0 ? ` Inferred ${feedback.new_edges_created} additional component(s) from file neighborhood.` : ''}`
      : ''

    if (feedback.risk_level === 'high') {
      riskSection = `
MANDATORY CONSTRAINTS — risk level HIGH (uncertainty: ${feedback.uncertainty}):
Factors: ${factors}
${newFileNote}
MUST isolate auth/db/service component changes — one component per task, no cross-component edits in a single step.
MUST add a "verify current behavior of X" task BEFORE modifying any component flagged in the risk factors.
MUST sequence: verify → isolate → implement → test per risky component.
MUST include a rollback note in the approach.
CONSTRAINT: total task count MUST NOT exceed ${maxTasks}. Safety comes from isolation, not from adding tasks. Remove tasks that don't do real work.
`
    } else {
      riskSection = `
Risk feedback — level MEDIUM (uncertainty: ${feedback.uncertainty}):
Factors: ${factors}
${newFileNote}
Add a verification step for uncertain components before modifying them.
Prefer isolated tasks where risk factors overlap.
CONSTRAINT: keep total task count under ${maxTasks}.
`
    }
  }

  return `You are planning the implementation of a software change.

Change: ${change.title}
Type: ${change.type}
Intent: ${change.intent}

Impacted components (from impact analysis):
${componentList}
${assumptionsSection}${riskSection}
Design the high-level approach for implementing this change.
For each component, describe what needs to change and how.
If this change requires creating brand-new files not yet in the codebase, list their paths in newFilePaths.

Respond with JSON:
{
  "approach": "One paragraph describing the overall implementation approach",
  "branchName": "sf/xxxxxx-short-slug",
  "testApproach": "Brief testing strategy",
  "estimatedFiles": 5,
  "componentApproaches": {
    "ComponentName": "Approach for this component"
  },
  "newFilePaths": ["relative/path/to/new-file.ts"]
}`
}

export function buildFallbackTasksPrompt(
  change: { title: string; intent: string; type: string },
  approach: string
): string {
  return `You are generating implementation tasks for a software change.

Change: ${change.title}
Type: ${change.type}
Intent: ${change.intent}
Approach: ${approach}

No specific system components were identified. Generate 4–8 specific, actionable implementation tasks covering the full change.
Each task should be completable in under an hour.
Focus only on work needed for this change — not general improvements.

Respond with JSON:
{
  "tasks": [
    { "description": "Specific task description" }
  ]
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
