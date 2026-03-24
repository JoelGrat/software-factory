export const DETECT_GAPS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          category: { type: 'string', enum: ['missing', 'ambiguous', 'conflicting', 'incomplete'] },
          description: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 100 },
        },
        required: ['severity', 'category', 'description', 'confidence'],
      },
    },
  },
  required: ['gaps'],
}

export function buildDetectGapsPrompt(itemsJson: string): string {
  return `You are a senior requirements analyst performing a gap analysis.

Review the structured requirement items below. Identify gaps that require reasoning — ambiguity, implicit conflicts, domain-specific omissions, incomplete specifications.

For each gap:
- item_id: always set to null (the caller maps gaps to items after parsing)
- severity: "critical" (blocks development), "major" (significant risk), or "minor" (worth noting)
- category: "missing" (not mentioned), "ambiguous" (unclear meaning), "conflicting" (contradicts another item), or "incomplete" (mentioned but not fully specified)
- description: 1-2 sentences explaining the gap
- confidence: 0-100 — how certain are you this is a real gap? (100 = definitely a gap)

Only report genuine gaps. Do not duplicate gaps already reported by deterministic rules. Return ONLY valid JSON.

--- REQUIREMENT ITEMS ---
${itemsJson}
--- END ---`
}
