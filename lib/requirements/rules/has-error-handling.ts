import type { ParsedItem } from '@/lib/requirements/parser'

const ERROR_KEYWORDS = ['error', 'fail', 'failure', 'exception', 'invalid', 'timeout', 'retry', 'fallback', 'handle', 'catch', 'unavailable', 'downtime']

export function hasErrorHandling(items: ParsedItem[]): boolean {
  return items.some(item =>
    ERROR_KEYWORDS.some(kw =>
      item.title.toLowerCase().includes(kw) || item.description.toLowerCase().includes(kw)
    )
  )
}
