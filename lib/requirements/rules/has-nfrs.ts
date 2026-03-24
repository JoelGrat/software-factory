import type { ParsedItem } from '@/lib/requirements/parser'

export function hasNonFunctionalRequirements(items: ParsedItem[]): boolean {
  return items.some(item => item.type === 'non-functional')
}
