import type { ChangeType, ChangePriority } from '@/lib/supabase/types'

const CHANGE_TYPES: ChangeType[] = ['bug', 'feature', 'refactor', 'hotfix']
const CHANGE_PRIORITIES: ChangePriority[] = ['low', 'medium', 'high']

type CreateResult =
  | { valid: true; data: { title: string; intent: string; type: ChangeType; priority: ChangePriority; tags: string[] } }
  | { valid: false; error: string }

type PatchResult =
  | { valid: true; updates: Record<string, unknown> }
  | { valid: false; error: string }

export function validateCreateChangeRequest(body: unknown): CreateResult {
  if (typeof body !== 'object' || body === null) return { valid: false, error: 'body must be an object' }
  const b = body as Record<string, unknown>

  if (typeof b.title !== 'string' || !b.title.trim()) return { valid: false, error: 'title is required' }
  if (typeof b.intent !== 'string' || !b.intent.trim()) return { valid: false, error: 'intent is required' }
  if (!CHANGE_TYPES.includes(b.type as ChangeType)) {
    return { valid: false, error: `type must be one of: ${CHANGE_TYPES.join(', ')}` }
  }

  const priority: ChangePriority = CHANGE_PRIORITIES.includes(b.priority as ChangePriority)
    ? (b.priority as ChangePriority)
    : 'medium'

  const tags =
    Array.isArray(b.tags) && b.tags.every(t => typeof t === 'string')
      ? (b.tags as string[])
      : []

  return {
    valid: true,
    data: {
      title: b.title.trim(),
      intent: b.intent.trim(),
      type: b.type as ChangeType,
      priority,
      tags,
    },
  }
}

export function validatePatchChangeRequest(body: unknown): PatchResult {
  if (typeof body !== 'object' || body === null) return { valid: false, error: 'body must be an object' }
  const b = body as Record<string, unknown>
  const updates: Record<string, unknown> = {}

  if (b.title !== undefined) {
    if (typeof b.title !== 'string' || !b.title.trim()) return { valid: false, error: 'title must be a non-empty string' }
    updates.title = b.title.trim()
  }
  if (b.priority !== undefined) {
    if (!CHANGE_PRIORITIES.includes(b.priority as ChangePriority)) {
      return { valid: false, error: `priority must be one of: ${CHANGE_PRIORITIES.join(', ')}` }
    }
    updates.priority = b.priority
  }
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags) || !b.tags.every(t => typeof t === 'string')) {
      return { valid: false, error: 'tags must be an array of strings' }
    }
    updates.tags = b.tags
  }

  if (Object.keys(updates).length === 0) return { valid: false, error: 'nothing to update' }
  return { valid: true, updates }
}
