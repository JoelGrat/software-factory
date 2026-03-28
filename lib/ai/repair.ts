// lib/ai/repair.ts

/**
 * Attempts common JSON fixes on a raw string:
 * - Strips markdown code fences (```json ... ```)
 * - Removes trailing commas before } or ]
 * - Extracts the outermost { } or [ ] block from surrounding prose
 */
export function repairJson(raw: string): string {
  let s = raw.trim()
  // Strip markdown code fences
  s = s.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '')
  // Remove trailing commas before closing braces/brackets (handles nested)
  s = s.replace(/,(\s*[}\]])/g, '$1')
  // Extract outermost JSON object or array from surrounding prose
  const start = s.search(/[{[]/)
  const lastBrace   = s.lastIndexOf('}')
  const lastBracket = s.lastIndexOf(']')
  const end = Math.max(lastBrace, lastBracket)
  if (start !== -1 && end > start) {
    s = s.slice(start, end + 1)
  }
  return s
}

/** Try JSON.parse directly, then try after repair. Returns null on total failure. */
export function repairAndParse<T>(raw: string): T | null {
  if (!raw) return null
  try { return JSON.parse(raw) as T } catch { /* fall through to repair */ }
  try { return JSON.parse(repairJson(raw)) as T } catch { return null }
}
