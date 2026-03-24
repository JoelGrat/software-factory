import type { ParsedItem } from '@/lib/requirements/parser'

const ACTOR_KEYWORDS = ['admin', 'user', 'customer', 'manager', 'operator', 'reviewer', 'approver', 'service', 'api', 'gateway', 'client', 'vendor', 'staff', 'role', 'actor', 'stakeholder']

export function hasActorsDefined(items: ParsedItem[]): boolean {
  return items.some(item =>
    ACTOR_KEYWORDS.some(kw =>
      item.title.toLowerCase().includes(kw) || item.description.toLowerCase().includes(kw)
    )
  )
}
