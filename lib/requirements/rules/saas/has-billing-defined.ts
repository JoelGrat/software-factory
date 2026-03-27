import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['billing', 'payment', 'subscription', 'pricing', 'invoice', 'charge', 'plan', 'tier', 'upgrade', 'downgrade']
export function hasBillingDefined(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
