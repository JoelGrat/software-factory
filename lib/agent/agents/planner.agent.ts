import type { AIProvider } from '@/lib/ai/provider'
import type { ParsedItem } from '@/lib/requirements/parser'
import type { AgentPlan } from '@/lib/supabase/types'
import type { IExecutor } from '@/lib/agent/executor'
import {
  buildFileRequestPrompt,
  buildPlannerPrompt,
  FILE_REQUEST_SCHEMA,
  PLANNER_SCHEMA,
} from '@/lib/agent/prompts/planner-prompt'

export async function runPlannerAgent(
  requirements: ParsedItem[],
  projectPath: string,
  executor: IExecutor,
  ai: AIProvider
): Promise<Omit<AgentPlan, 'id' | 'job_id' | 'created_at'>> {
  const fileTree = await executor.getFileTree(projectPath)

  const fileRequestPrompt = buildFileRequestPrompt(requirements, fileTree)
  const fileRequestResult = await ai.complete(fileRequestPrompt, { responseSchema: FILE_REQUEST_SCHEMA })
  const { requested_files } = JSON.parse(fileRequestResult.content) as { requested_files: string[] }

  const fileContents = await executor.readFiles(projectPath, requested_files.slice(0, 20))
  const plannerPrompt = buildPlannerPrompt(requirements, fileTree, fileContents)
  const planResult = await ai.complete(plannerPrompt, { responseSchema: PLANNER_SCHEMA })

  return JSON.parse(planResult.content) as Omit<AgentPlan, 'id' | 'job_id' | 'created_at'>
}
