export const PARSE_REQUIREMENTS_SCHEMA: Record<string, unknown> = {
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
  },
  required: ['items'],
}

export function buildParsePrompt(rawInput: string): string {
  return `You are a requirements analyst. Extract all discrete requirement items from the text below.

For each item:
- type: "functional" (feature/behaviour), "non-functional" (quality/constraint), "constraint" (hard limit), or "assumption" (assumed but not stated)
- title: 5-10 word summary
- description: full detail in one or two sentences
- priority: "high" (blocking/critical), "medium" (important), or "low" (nice-to-have)
- source_text: the exact sentence or phrase this item came from
- nfr_category: only for non-functional items — "security", "performance", or "auditability". Omit for all other types.

Return ONLY valid JSON matching the schema. Do not add commentary.

--- REQUIREMENTS TEXT ---
${rawInput}
--- END ---`
}
