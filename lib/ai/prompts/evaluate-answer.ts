export const EVALUATE_ANSWER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    resolved: { type: 'boolean' },
    rationale: { type: 'string' },
  },
  required: ['resolved', 'rationale'],
}

export function buildEvaluateAnswerPrompt(
  gapDescription: string,
  questionText: string,
  answer: string
): string {
  return `You are a requirements analyst evaluating whether a stakeholder's answer resolves a gap.

Gap: ${gapDescription}
Question asked: ${questionText}
Answer provided: ${answer}

Does this answer resolve the gap?
- resolved: true if the answer provides enough information to eliminate the ambiguity or fill the missing detail
- rationale: 1-2 sentences explaining why it does or does not resolve the gap

Return ONLY valid JSON.`
}
