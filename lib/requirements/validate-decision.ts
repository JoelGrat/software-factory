export function validateDecision(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'Invalid body'
  const b = body as Record<string, unknown>
  if (!b.gap_id || typeof b.gap_id !== 'string') return 'gap_id is required'
  if (!b.decision || typeof b.decision !== 'string' || !(b.decision as string).trim()) return 'decision is required'
  if (!b.rationale || typeof b.rationale !== 'string' || !(b.rationale as string).trim()) return 'rationale is required'
  return null
}
