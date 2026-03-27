import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['compliance', 'regulatory', 'regulation', 'pci', 'gdpr', 'sox', 'aml', 'kyc', 'fca', 'legal requirement']
export function hasComplianceRequirements(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
