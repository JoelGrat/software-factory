export const GENERATE_QUESTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    question_text: { type: 'string' },
    target_role: { type: 'string', enum: ['ba', 'architect', 'po', 'dev'] },
  },
  required: ['question_text', 'target_role'],
}

export function buildGenerateQuestionPrompt(
  gapDescription: string,
  gapCategory: string,
  itemDescription: string | null
): string {
  const itemContext = itemDescription
    ? `\nRelated requirement item: ${itemDescription}`
    : '\n(Document-level gap — not tied to a specific item)'

  return `You are a requirements analyst. Generate one concise clarifying question for the gap below.

Gap category: ${gapCategory}
Gap description: ${gapDescription}${itemContext}

Target role assignment rules:
- "ambiguous" gaps → target_role: "ba"
- "missing"/"incomplete" with product/business decision → target_role: "po"
- "missing"/"incomplete" with process/detail/technical → target_role: "ba"
- "conflicting" with technical concern → target_role: "architect"
- "conflicting" with business rules → target_role: "po"

The question must be specific enough that the answer would resolve the gap. Not more than two sentences.

Return ONLY valid JSON.`
}
