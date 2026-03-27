import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['audit trail', 'audit log', 'transaction log', 'event log', 'ledger', 'immutable record', 'transaction history']
export function hasAuditTrailDefined(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
