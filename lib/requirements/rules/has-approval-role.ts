import type { ParsedItem } from '@/lib/requirements/parser'

const APPROVAL_KEYWORDS = ['approv', 'sign-off', 'signoff', 'sign off', 'authorize', 'authorise', 'endorse', 'ratif', 'clearance']

export function hasApprovalRole(items: ParsedItem[]): boolean {
  return items.some(item =>
    APPROVAL_KEYWORDS.some(kw =>
      item.title.toLowerCase().includes(kw) || item.description.toLowerCase().includes(kw)
    )
  )
}
