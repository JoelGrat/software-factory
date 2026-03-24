import type { ParsedItem } from '@/lib/requirements/parser'

const STATE_KEYWORDS = ['status', 'state', 'transition', 'workflow', 'pending', 'active', 'inactive', 'approved', 'rejected', 'draft', 'published', 'closed', 'in progress', 'complete']

export function hasWorkflowStates(items: ParsedItem[]): boolean {
  return items.some(item =>
    STATE_KEYWORDS.some(kw =>
      item.title.toLowerCase().includes(kw) || item.description.toLowerCase().includes(kw)
    )
  )
}
