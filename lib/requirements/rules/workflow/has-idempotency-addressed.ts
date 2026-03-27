import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['idempoten', 'idempotency key', 'duplicate', 'deduplication', 'exactly-once', 'at-most-once']
export function hasIdempotencyAddressed(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
