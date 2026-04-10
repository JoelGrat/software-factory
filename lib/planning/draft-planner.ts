// lib/planning/draft-planner.ts
import type { AIProvider } from '@/lib/ai/provider'
import type { DraftPlan } from './types'

export async function runDraftPlan(
  change: { title: string; intent: string; type: string },
  ai: AIProvider
): Promise<DraftPlan> {
  const result = await ai.complete(
    `Analyse this software change and identify what it will create and touch.

Change: ${change.title}
Type: ${change.type}
Intent: ${change.intent}

Respond with JSON:
{
  "new_file_paths": ["relative/path/to/new-file.ts"],
  "component_names": ["ComponentName"],
  "assumptions": ["Assumes X is the entry point for this change"],
  "confidence": 0.85
}`,
    {
      responseSchema: {
        type: 'object',
        properties: {
          new_file_paths: { type: 'array', items: { type: 'string' } },
          component_names: { type: 'array', items: { type: 'string' } },
          assumptions: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
        },
        required: ['new_file_paths', 'component_names'],
      },
      maxTokens: 512,
    }
  )
  const parsed = JSON.parse(result.content)
  const rawConfidence = parsed.confidence
  const confidence = typeof rawConfidence === 'number'
    ? Math.max(0, Math.min(1, rawConfidence))
    : 0.5
  return {
    new_file_paths: parsed.new_file_paths ?? [],
    component_names: parsed.component_names ?? [],
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
    confidence,
  }
}
