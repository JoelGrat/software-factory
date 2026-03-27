import type { ParsedItem } from '@/lib/requirements/parser'

const KEYWORDS = ['entity', 'model', 'schema', 'table', 'record', 'field', 'attribute', 'data structure', 'database', 'struct', 'store']

export function hasDataModelDefined(items: ParsedItem[]): boolean {
  return items.some(i =>
    KEYWORDS.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k))
  )
}
