import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['rollback', 'roll back', 'rolls back', 'undo', 'revert', 'compensation', 'compensating transaction', 'saga']
export function hasRollbackDefined(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
