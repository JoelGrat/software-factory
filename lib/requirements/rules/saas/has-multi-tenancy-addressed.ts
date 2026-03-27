import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['tenant', 'tenancy', 'multi-tenant', 'isolation', 'workspace', 'organisation', 'organization', 'account', 'single-tenant']
export function hasMultiTenancyAddressed(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
