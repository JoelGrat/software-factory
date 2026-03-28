import type { AIProvider } from '@/lib/ai/provider'
import type { ParsedItem } from '@/lib/requirements/parser'
import { buildRequirementsLoopPrompt, REQUIREMENTS_LOOP_SCHEMA } from '@/lib/agent/prompts/requirements-loop-prompt'

const MAX_ITERATIONS = 3
const CONFIDENCE_THRESHOLD = 80

interface LoopResult {
  items: ParsedItem[]
  critique: string[]
  confidence: number
}

export async function runRequirementsLoop(rawInput: string, ai: AIProvider): Promise<ParsedItem[]> {
  let previousCritique: string[] = []

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const prompt = buildRequirementsLoopPrompt(rawInput, previousCritique)
    const result = await ai.complete(prompt, { responseSchema: REQUIREMENTS_LOOP_SCHEMA })
    const parsed = JSON.parse(result.content) as LoopResult
    const confidence = parsed.confidence ?? 0
    const critique = parsed.critique ?? []

    if (confidence >= CONFIDENCE_THRESHOLD || i === MAX_ITERATIONS - 1) {
      return parsed.items ?? []
    }

    previousCritique = critique
  }

  return []
}
