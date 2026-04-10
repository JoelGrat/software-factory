// lib/change-requests/validator.ts
import type { ChangeType, ChangePriority } from '@/lib/supabase/types'
import type { AIProvider } from '@/lib/ai/provider'

const CHANGE_TYPES: ChangeType[] = ['bug', 'feature', 'refactor', 'hotfix']
const CHANGE_PRIORITIES: ChangePriority[] = ['low', 'medium', 'high']

const ACTION_VERBS = ['add', 'update', 'remove', 'fix', 'implement', 'create', 'refactor', 'migrate', 'replace', 'delete', 'handle', 'resolve', 'improve', 'enable', 'disable', 'configure', 'integrate']
const VAGUE_PHRASES = ['update stuff', 'misc', 'general improvements', 'refactor code', 'various fixes', 'fix bugs', 'cleanup', 'changes', 'updates']
const TECHNICAL_NOUNS = ['endpoint', 'page', 'form', 'hook', 'service', 'table', 'schema', 'component', 'module', 'route', 'api', 'button', 'modal']
const FILLER_WORDS = ['system', 'feature', 'thing', 'part', 'stuff']
const AI_SCORE_THRESHOLD = 0.65

function countActionVerbs(text: string): number {
  const lower = text.toLowerCase()
  return ACTION_VERBS.filter(v => {
    const re = new RegExp(`\\b${v}\\b`)
    return re.test(lower)
  }).length
}

function hasTechnicalNoun(text: string): boolean {
  const lower = text.toLowerCase()
  return TECHNICAL_NOUNS.some(n => lower.includes(n))
}

function hasVaguePhrase(text: string): boolean {
  const lower = text.toLowerCase()
  return VAGUE_PHRASES.some(p => lower.includes(p))
}

export function computeSuspicionFlags(intent: string): number {
  let flags = 0
  if (intent.length < 60) flags++
  if (countActionVerbs(intent) < 2) flags++
  if (!hasTechnicalNoun(intent)) flags++
  const lower = intent.toLowerCase()
  if (FILLER_WORDS.some(w => new RegExp(`\\b${w}\\b`).test(lower))) flags++
  return flags
}

type CreateResult =
  | { valid: true; data: { title: string; intent: string; type: ChangeType; priority: ChangePriority; tags: string[] } }
  | { valid: false; error: string }

type ContentResult =
  | { valid: true }
  | { valid: false; error: 'INVALID_CHANGE_REQUEST'; reasons: string[]; suggestion: string }

type PatchResult =
  | { valid: true; updates: Record<string, unknown> }
  | { valid: false; error: string }

export function validateCreateChangeRequest(body: unknown): CreateResult {
  if (typeof body !== 'object' || body === null) return { valid: false, error: 'body must be an object' }
  const b = body as Record<string, unknown>

  if (typeof b.title !== 'string' || !b.title.trim()) return { valid: false, error: 'title is required' }
  if (typeof b.intent !== 'string' || !b.intent.trim()) return { valid: false, error: 'intent is required' }

  const title = b.title.trim()
  const intent = b.intent.trim()

  // Length gates
  if (title.length < 10) return { valid: false, error: 'title must be at least 10 characters' }
  if (intent.length < 30) return { valid: false, error: 'intent must be at least 30 characters' }

  // Vague phrase blocklist
  if (hasVaguePhrase(title) || hasVaguePhrase(intent)) {
    return { valid: false, error: 'title or intent contains vague phrases — be specific about what is changing and why' }
  }

  // Require ≥2 action verbs in intent
  if (countActionVerbs(intent) < 2) {
    return { valid: false, error: 'intent must include at least 2 action verbs (e.g. add, fix, update, implement, remove)' }
  }

  // Require technical noun OR multi-word phrase (>5 words)
  const wordCount = intent.split(/\s+/).filter(Boolean).length
  if (!hasTechnicalNoun(intent) && wordCount <= 5) {
    return { valid: false, error: 'intent must name a specific component/module or describe the change in at least 6 words' }
  }

  if (!CHANGE_TYPES.includes(b.type as ChangeType)) {
    return { valid: false, error: `type must be one of: ${CHANGE_TYPES.join(', ')}` }
  }

  const priority: ChangePriority = CHANGE_PRIORITIES.includes(b.priority as ChangePriority)
    ? (b.priority as ChangePriority)
    : 'medium'

  const tags =
    Array.isArray(b.tags) && b.tags.every((t: unknown) => typeof t === 'string')
      ? (b.tags as string[])
      : []

  return { valid: true, data: { title, intent, type: b.type as ChangeType, priority, tags } }
}

export async function runContentValidation(
  title: string,
  intent: string,
  type: string,
  ai: AIProvider
): Promise<ContentResult> {
  const suspicionFlags = computeSuspicionFlags(intent)
  if (suspicionFlags < 2) return { valid: true }

  async function scoreOnce(): Promise<{ score: number; reason: string } | null> {
    try {
      const result = await ai.complete(
        `Score this change request for implementation readiness.
Title: ${title}
Intent: ${intent}
Type: ${type}

Respond with JSON: { "score": 0.0, "reason": "one sentence" }

Score from 0.0 to 1.0 based on:
- Does it name a specific thing to change?
- Is the scope clear (what is in/out)?
- Could a developer start implementing without asking questions?`,
        { maxTokens: 200 }
      )
      const parsed = JSON.parse(result.content)
      if (typeof parsed.score !== 'number' || parsed.score < 0 || parsed.score > 1) return null
      if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) return null
      return { score: parsed.score, reason: parsed.reason.trim() }
    } catch {
      return null
    }
  }

  let scored = await scoreOnce()
  if (!scored) scored = await scoreOnce()  // one retry
  if (!scored) {
    return {
      valid: false,
      error: 'INVALID_CHANGE_REQUEST',
      reasons: ['Could not evaluate specificity — please rewrite with a clearer scope'],
      suggestion: 'Specify which component and what change (e.g. "Add retry logic to AuthService login endpoint")',
    }
  }

  if (scored.score < AI_SCORE_THRESHOLD) {
    return {
      valid: false,
      error: 'INVALID_CHANGE_REQUEST',
      reasons: [`AI specificity score ${scored.score}: ${scored.reason}`],
      suggestion: 'Specify which component and what change (e.g. "Add retry logic to AuthService login endpoint")',
    }
  }

  return { valid: true }
}

export function validatePatchChangeRequest(body: unknown): PatchResult {
  if (typeof body !== 'object' || body === null) return { valid: false, error: 'body must be an object' }
  const b = body as Record<string, unknown>
  const updates: Record<string, unknown> = {}

  if (b.title !== undefined) {
    if (typeof b.title !== 'string' || !(b.title as string).trim()) return { valid: false, error: 'title must be a non-empty string' }
    updates.title = (b.title as string).trim()
  }
  if (b.priority !== undefined) {
    if (!CHANGE_PRIORITIES.includes(b.priority as ChangePriority)) {
      return { valid: false, error: `priority must be one of: ${CHANGE_PRIORITIES.join(', ')}` }
    }
    updates.priority = b.priority
  }
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags) || !(b.tags as unknown[]).every(t => typeof t === 'string')) {
      return { valid: false, error: 'tags must be an array of strings' }
    }
    updates.tags = b.tags
  }

  if (Object.keys(updates).length === 0) return { valid: false, error: 'nothing to update' }
  return { valid: true, updates }
}
