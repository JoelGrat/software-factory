import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['retry', 'retries', 'backoff', 'exponential backoff', 'dead letter', 'dlq', 'max attempts']
export function hasRetryStrategyDefined(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
