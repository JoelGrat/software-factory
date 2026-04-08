// lib/planning/phases.ts
import type { AIProvider } from '@/lib/ai/provider'
import type { ImpactedComponent, PlannerArchitecture, PlannerTask } from './types'
import { buildArchitecturePrompt, buildComponentTasksPrompt, buildFallbackTasksPrompt, buildSpecPrompt } from './prompt-builders'

// Component type priority for deterministic ordering (lower = runs first)
const TYPE_PRIORITY: Record<string, number> = {
  database: 0,
  repository: 1,
  service: 2,
  auth: 3,
  api: 4,
  module: 5,
  ui: 6,
  component: 7,
}

export async function runArchitecturePhase(
  change: { title: string; intent: string; type: string },
  components: ImpactedComponent[],
  ai: AIProvider
): Promise<PlannerArchitecture> {
  const prompt = buildArchitecturePrompt(change, components)
  const result = await ai.complete(prompt, {
    responseSchema: {
      type: 'object',
      properties: {
        approach: { type: 'string' },
        branchName: { type: 'string' },
        testApproach: { type: 'string' },
        estimatedFiles: { type: 'number' },
        componentApproaches: { type: 'object' },
      },
      required: ['approach', 'branchName', 'testApproach', 'estimatedFiles', 'componentApproaches'],
    },
    maxTokens: 2048,
  })

  const parsed = JSON.parse(result.content)
  return {
    approach: parsed.approach,
    branchName: parsed.branchName,
    testApproach: parsed.testApproach,
    estimatedFiles: parsed.estimatedFiles ?? 0,
    componentApproaches: parsed.componentApproaches ?? {},
    newFilePaths: parsed.newFilePaths ?? [],
  }
}

export async function runComponentTasksPhase(
  change: { title: string; intent: string },
  component: ImpactedComponent,
  approach: string,
  ai: AIProvider
): Promise<string[]> {
  const prompt = buildComponentTasksPrompt(change, component, approach)
  try {
    const result = await ai.complete(prompt, {
      responseSchema: {
        type: 'object',
        properties: {
          tasks: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' } } } },
        },
        required: ['tasks'],
      },
      maxTokens: 2048,
    })
    const parsed = JSON.parse(result.content)
    return (parsed.tasks ?? []).map((t: { description: string }) => t.description).filter(Boolean)
  } catch {
    return []
  }
}

export async function runFallbackTasksPhase(
  change: { title: string; intent: string; type: string },
  approach: string,
  ai: AIProvider
): Promise<string[]> {
  const prompt = buildFallbackTasksPrompt(change, approach)
  try {
    const result = await ai.complete(prompt, {
      responseSchema: {
        type: 'object',
        properties: {
          tasks: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' } } } },
        },
        required: ['tasks'],
      },
      maxTokens: 2048,
    })
    const parsed = JSON.parse(result.content)
    return (parsed.tasks ?? []).map((t: { description: string }) => t.description).filter(Boolean)
  } catch {
    return []
  }
}

export function runOrderingPhase(
  tasks: PlannerTask[],
  components: ImpactedComponent[]
): PlannerTask[] {
  const typeByComponentId = new Map(components.map(c => [c.componentId, c.type]))

  const sorted = [...tasks].sort((a, b) => {
    const pa = TYPE_PRIORITY[typeByComponentId.get(a.componentId) ?? ''] ?? 99
    const pb = TYPE_PRIORITY[typeByComponentId.get(b.componentId) ?? ''] ?? 99
    if (pa !== pb) return pa - pb
    return a.orderIndex - b.orderIndex
  })

  return sorted.map((task, i) => ({ ...task, orderIndex: i }))
}

export async function runSpecPhase(
  change: { title: string; intent: string; type: string },
  architecture: PlannerArchitecture,
  tasks: PlannerTask[],
  ai: AIProvider
): Promise<string> {
  const prompt = buildSpecPrompt(change, architecture, tasks)
  try {
    const result = await ai.complete(prompt, { maxTokens: 4096 })
    return result.content
  } catch {
    return ''
  }
}
