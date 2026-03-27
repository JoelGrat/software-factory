import type { ParsedItem } from '@/lib/requirements/parser'

const KEYWORDS = ['edge case', 'boundary', 'limit', 'maximum', 'minimum', 'overflow', 'empty', 'null', 'zero', 'invalid', 'out of range', 'corner case']

export function hasEdgeCasesCovered(items: ParsedItem[]): boolean {
  return items.some(i =>
    KEYWORDS.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k))
  )
}
