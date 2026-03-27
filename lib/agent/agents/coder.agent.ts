import type { AIProvider } from '@/lib/ai/provider'
import type { ParsedItem } from '@/lib/requirements/parser'
import type { AgentPlan, FileChange } from '@/lib/supabase/types'
import { buildCoderPrompt, CODER_SCHEMA } from '@/lib/agent/prompts/coder-prompt'

export async function runCoderAgent(
  requirements: ParsedItem[],
  plan: Omit<AgentPlan, 'id' | 'job_id' | 'created_at'>,
  previousErrors: string[],
  currentFileContents: Record<string, string>,
  ai: AIProvider
): Promise<FileChange[]> {
  const prompt = buildCoderPrompt(requirements, plan, previousErrors, currentFileContents)
  const result = await ai.complete(prompt, { responseSchema: CODER_SCHEMA, maxTokens: 8000 })
  const parsed = JSON.parse(result.content) as { changes: FileChange[] }
  return parsed.changes
}
