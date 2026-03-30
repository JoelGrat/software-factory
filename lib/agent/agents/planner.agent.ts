import type { AIProvider } from '@/lib/ai/provider'
import type { ParsedItem } from '@/lib/requirements/parser'
// TODO: replaced in Plan 2/3/4 — old types removed in migration 006
/* eslint-disable @typescript-eslint/no-explicit-any */
// import type { AgentPlan } from '@/lib/supabase/types' // removed in migration 006
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
): Promise<any> {
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
  const plan = JSON.parse(planResult.content) as any

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
