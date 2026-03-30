import type { AIProvider } from '@/lib/ai/provider'
import { buildGenerateQuestionPrompt, GENERATE_QUESTION_SCHEMA } from '@/lib/ai/prompts/generate-question'
import type { DetectedGap } from '@/lib/requirements/gap-detector'
import type { ParsedItem } from '@/lib/requirements/parser'
// TODO: replaced in Plan 2/3/4 — old types removed in migration 006
/* eslint-disable @typescript-eslint/no-explicit-any */
// import type { TargetRole } from '@/lib/supabase/types' // removed in migration 006

export interface GeneratedQuestion {
  gap_index: number
  question_text: string
  target_role: any
}

const TOP_N = 10

export async function generateQuestions(
  gaps: DetectedGap[],
  mergedIndices: Set<number>,
  items: ParsedItem[],
  ai: AIProvider
): Promise<GeneratedQuestion[]> {
  const eligible = gaps
    .map((gap, idx) => ({ gap, idx }))
    .filter(({ idx }) => !mergedIndices.has(idx))
    .slice(0, TOP_N)

  const results = await Promise.all(
    eligible.map(async ({ gap, idx }) => {
      const relatedItem = gap.item_id
        ? items.find((_item, i) => `item-${i}` === gap.item_id) ?? null
        : null
      const prompt = buildGenerateQuestionPrompt(gap.description, gap.category, relatedItem?.description ?? null)
      const result = await ai.complete(prompt, { responseSchema: GENERATE_QUESTION_SCHEMA })
      const parsed = JSON.parse(result.content) as { question_text: string; target_role: any }
      return { gap_index: idx, question_text: parsed.question_text, target_role: parsed.target_role }
    })
  )

  return results
}
