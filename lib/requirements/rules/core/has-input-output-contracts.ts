import type { ParsedItem } from '@/lib/requirements/parser'

const KEYWORDS = ['input', 'output', 'request', 'response', 'payload', 'api', 'endpoint', 'parameter', 'accepts', 'returns', 'contract']

export function hasInputOutputContracts(items: ParsedItem[]): boolean {
  return items.some(i =>
    KEYWORDS.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k))
  )
}
