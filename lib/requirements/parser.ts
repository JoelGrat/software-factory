import type { AIProvider } from '@/lib/ai/provider'
import { buildParsePrompt, PARSE_REQUIREMENTS_SCHEMA } from '@/lib/ai/prompts/parse-requirements'
import type { ItemType, NfrCategory } from '@/lib/supabase/types'

export interface ParsedItem {
  type: ItemType
  title: string
  description: string
  priority: 'high' | 'medium' | 'low'
  source_text: string | null
  nfr_category: NfrCategory | null
}

export async function parseRequirements(rawInput: string, ai: AIProvider): Promise<ParsedItem[]> {
  const prompt = buildParsePrompt(rawInput)
  const result = await ai.complete(prompt, { responseSchema: PARSE_REQUIREMENTS_SCHEMA })
  const parsed = JSON.parse(result.content) as { items: ParsedItem[] }
  return parsed.items
}
