import type { ParsedItem } from '@/lib/requirements/parser'

const KEYWORDS = ['permission', 'access control', 'role-based', 'rbac', 'authorization', 'authorise', 'authorize', 'allowed', 'restricted', 'admin only', 'readonly']

export function hasPermissionsMatrix(items: ParsedItem[]): boolean {
  return items.some(i =>
    KEYWORDS.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k))
  )
}
