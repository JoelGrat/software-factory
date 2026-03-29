import type { AIProvider } from '@/lib/ai/provider'
import type { ParsedItem } from '@/lib/requirements/parser'
import type { AgentPlan } from '@/lib/supabase/types'
import type { IExecutor } from '@/lib/agent/executor'
import {
  buildFileRequestPrompt,
  buildPlannerPrompt,
  buildSpecPrompt,
  FILE_REQUEST_SCHEMA,
  PLANNER_SCHEMA,
} from '@/lib/agent/prompts/planner-prompt'

export async function runPlannerAgent(
  requirements: ParsedItem[],
  projectPath: string | null,
  executor: IExecutor,
  ai: AIProvider
): Promise<Omit<AgentPlan, 'id' | 'job_id' | 'created_at'>> {
  let fileTree: string[] = []
  let fileContents: Record<string, string> = {}

  if (projectPath) {
    fileTree = await executor.getFileTree(projectPath)

    const fileRequestPrompt = buildFileRequestPrompt(requirements, fileTree)
    const fileRequestResult = await ai.complete(fileRequestPrompt, { responseSchema: FILE_REQUEST_SCHEMA })
    const { requested_files } = JSON.parse(fileRequestResult.content) as { requested_files: string[] }

    fileContents = await executor.readFiles(projectPath, requested_files.slice(0, 20))
  }

  const plannerPrompt = buildPlannerPrompt(requirements, fileTree, fileContents)
  const planResult = await ai.complete(plannerPrompt, { responseSchema: PLANNER_SCHEMA, maxTokens: 16000, timeout: 120_000 })
  const plan = JSON.parse(planResult.content) as Omit<AgentPlan, 'id' | 'job_id' | 'created_at' | 'spec_markdown'>

  // Generate spec as plain text — best-effort, does not block plan approval if it fails
  let spec_markdown: string | null = null
  try {
    const specResult = await ai.complete(buildSpecPrompt(requirements, plan), { maxTokens: 2048, timeout: 60_000 })
    spec_markdown = specResult.content
  } catch {
    // spec generation failed — plan still proceeds without it
  }

  return { ...plan, spec_markdown }
}
