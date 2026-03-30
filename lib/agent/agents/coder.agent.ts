import type { AIProvider } from '@/lib/ai/provider'
import type { ParsedItem } from '@/lib/requirements/parser'
// TODO: replaced in Plan 2/3/4 — old types removed in migration 006
/* eslint-disable @typescript-eslint/no-explicit-any */
// import type { AgentPlan, FileChange } from '@/lib/supabase/types' // removed in migration 006
import { buildCoderPrompt, CODER_SCHEMA } from '@/lib/agent/prompts/coder-prompt'

export async function runCoderAgent(
  requirements: ParsedItem[],
  plan: any,
  previousErrors: string[],
  currentFileContents: Record<string, string>,
  ai: AIProvider
): Promise<any[]> {
  const prompt = buildCoderPrompt(requirements, plan, previousErrors, currentFileContents)
  const result = await ai.complete(prompt, { responseSchema: CODER_SCHEMA, maxTokens: 8000 })
  const parsed = JSON.parse(result.content) as { changes: any[] }
  return parsed.changes
}
