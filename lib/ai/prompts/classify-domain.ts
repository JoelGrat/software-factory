export const CLASSIFY_DOMAIN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    domain: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 100 },
  },
  required: ['domain', 'confidence'],
}

export function buildClassifyDomainPrompt(rawInput: string): string {
  return `You are a business analyst. Classify the domain of the requirements below.

Common domains: e-commerce, healthcare, fintech, saas, logistics, hr-management, content-management, iot, gaming, other.

Return:
- domain: the single best-matching domain string (lowercase, hyphenated)
- confidence: 0-100 how confident you are

Return ONLY valid JSON.

--- REQUIREMENTS ---
${rawInput.slice(0, 1000)}
--- END ---`
}
