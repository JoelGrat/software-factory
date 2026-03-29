import type { PlanTask } from '@/lib/supabase/types'

export function validateUpdateTasks(tasks: unknown): { valid: true } | { valid: false; error: string } {
  if (!Array.isArray(tasks)) return { valid: false, error: 'tasks must be an array' }
  for (const task of tasks) {
    if (typeof task !== 'object' || task === null) return { valid: false, error: 'each task must be an object' }
    const t = task as Record<string, unknown>
    if (typeof t.id !== 'string' || !t.id) return { valid: false, error: 'each task must have a string id' }
    if (typeof t.title !== 'string' || !t.title) return { valid: false, error: 'each task must have a string title' }
    if (typeof t.description !== 'string') return { valid: false, error: 'each task must have a string description' }
    if (!Array.isArray(t.files)) return { valid: false, error: 'each task must have a files array' }
    if (!Array.isArray(t.dependencies)) return { valid: false, error: 'each task must have a dependencies array' }
  }
  return { valid: true }
}
