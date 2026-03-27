import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['reconciliation', 'reconcile', 'balance check', 'settlement', 'net position', 'discrepancy']
export function hasReconciliationDefined(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
