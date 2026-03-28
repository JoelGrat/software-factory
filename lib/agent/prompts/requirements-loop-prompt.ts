export const REQUIREMENTS_LOOP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['functional', 'non-functional', 'constraint', 'assumption'] },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          source_text: { type: 'string' },
          nfr_category: { type: 'string', enum: ['security', 'performance', 'auditability'] },
        },
        required: ['type', 'title', 'description', 'priority', 'source_text'],
      },
    },
    critique: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['items', 'critique', 'confidence'],
}

export function buildRequirementsLoopPrompt(rawInput: string, previousCritique: string[]): string {
  const critiqueSection = previousCritique.length > 0
    ? `\n\nPREVIOUS CRITIQUE — address these gaps in this iteration:\n${previousCritique.map(c => `- ${c}`).join('\n')}`
    : ''

  return `You are a senior requirements analyst. Extract all discrete requirement items from the text below.

For each item:
- type: "functional" (feature/behaviour), "non-functional" (quality/constraint), "constraint" (hard limit), "assumption" (assumed but not stated)
- title: 5-10 word summary
- description: full detail in one or two sentences
- priority: "high" (blocking/critical), "medium" (important), "low" (nice-to-have)
- source_text: exact sentence or phrase this came from
- nfr_category: only for non-functional — "security", "performance", or "auditability". Omit for all others.

After extracting items, self-critique:
- What is missing or ambiguous?
- What assumptions are implied but not stated?
- critique: list each gap as a string (empty array if none)
- confidence: 0-100 score for how complete the requirements are (80+ means ready)

Return ONLY valid JSON. No commentary.${critiqueSection}

--- REQUIREMENTS TEXT ---
${rawInput}
--- END ---`
}
