import type { SupabaseClient } from '@supabase/supabase-js'
import type { EventType } from './execution-types-v2'

// ── Payload schemas (lightweight type-guard validation) ────────────────────────

type PayloadValidator = (payload: unknown) => void

function assertObject(payload: unknown): asserts payload is Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('payload must be an object')
  }
}

function assertField(obj: Record<string, unknown>, key: string, type: string) {
  if (typeof obj[key] !== type) {
    throw new Error(`payload.${key} must be ${type}, got ${typeof obj[key]}`)
  }
}

function assertArray(obj: Record<string, unknown>, key: string) {
  if (!Array.isArray(obj[key])) {
    throw new Error(`payload.${key} must be an array`)
  }
}

function validateFailedPhasePayload(p: unknown) {
  assertObject(p)
  assertArray(p, 'diagnostics')
  assertField(p, 'totalCount', 'number')
  assertField(p, 'truncated', 'boolean')
  assertField(p, 'durationMs', 'number')
}

const VALIDATORS: Partial<Record<EventType, PayloadValidator>> = {
  'phase.static_validation.failed': validateFailedPhasePayload,
  'phase.unit.failed': validateFailedPhasePayload,
  'phase.integration.failed': validateFailedPhasePayload,
  'phase.smoke.failed': validateFailedPhasePayload,
  'repair.inline.started': (p) => { assertObject(p) },
  'repair.inline.succeeded': (p) => { assertObject(p); assertField(p, 'durationMs', 'number') },
  'repair.inline.failed': (p) => { assertObject(p); assertField(p, 'durationMs', 'number') },
  'repair.phase.started': (p) => { assertObject(p) },
  'repair.phase.succeeded': (p) => { assertObject(p); assertField(p, 'durationMs', 'number') },
  'repair.phase.failed': (p) => { assertObject(p); assertField(p, 'durationMs', 'number') },
  'phase.skipped': (p) => { assertObject(p); assertField(p, 'phase', 'string'); assertField(p, 'reason', 'string') },
  'iteration.stuck': (p) => { assertObject(p); assertField(p, 'reason', 'string') },
  'commit.wip': (p) => { assertObject(p); assertField(p, 'reason', 'string') },
  'commit.skipped': (p) => { assertObject(p); assertField(p, 'reason', 'string') },
  'commit.failed': (p) => { assertObject(p); assertField(p, 'reason', 'string') },
  'execution.completed': (p) => { assertObject(p) },
}

export class EventPayloadValidationError extends Error {
  constructor(eventType: string, detail: string) {
    super(`EventPayloadValidationError [${eventType}]: ${detail}`)
    this.name = 'EventPayloadValidationError'
  }
}

export function validatePayload(eventType: EventType, payload: unknown): void {
  const validator = VALIDATORS[eventType]
  if (!validator) return  // unknown or open-payload events pass through
  try {
    validator(payload)
  } catch (err) {
    throw new EventPayloadValidationError(eventType, (err as Error).message)
  }
}

// ── Sequence counter (in-memory per run) ──────────────────────────────────────

// In-memory sequence counter per run. WARNING: resets on process restart.
// If the process restarts mid-run, the counter starts from 0 and subsequent inserts
// will violate the UNIQUE(run_id, seq) constraint. The error surface in insertEvent
// will catch this, but the run cannot be resumed cleanly without re-seeding from DB.
const seqCounters = new Map<string, number>()

export function nextSeq(runId: string): number {
  const n = (seqCounters.get(runId) ?? 0) + 1
  seqCounters.set(runId, n)
  return n
}

export function clearSeq(runId: string): void {
  seqCounters.delete(runId)
}

// ── Insert ────────────────────────────────────────────────────────────────────

export interface EventInput {
  runId: string
  changeId: string
  seq: number
  iteration: number
  eventType: EventType
  phase?: string
  payload: unknown
}

export async function insertEvent(db: SupabaseClient, input: EventInput): Promise<void> {
  validatePayload(input.eventType, input.payload)
  // TODO: remove 'as any' cast after Database type is regenerated to include execution_events
  const { error } = await (db.from('execution_events') as any).insert({
    run_id: input.runId,
    change_id: input.changeId,
    seq: input.seq,
    iteration: input.iteration,
    event_type: input.eventType,
    phase: input.phase ?? null,
    schema_version: 1,
    payload: input.payload,
  })
  if (error) throw new Error(`insertEvent failed: ${error.message}`)
}
