# Execution System Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the brute-force execution retry loop with a controlled executor: hybrid inline/repair-phase failure routing, explicit budgets, stuck detection, WIP commit policy, append-only event log, and a live UI with iteration cards.

**Architecture:** Incremental layering on the existing orchestrator — `implementChanges` logic is preserved unchanged; the post-implementation validation block is replaced with `staticValidationPhase → testPhases → stuckDetector → commitPolicy`, each emitting structured events to new `execution_runs` / `execution_events` tables. The UI polls a new events endpoint and renders a live strip + iteration cards.

**Tech Stack:** Next.js App Router, Supabase (PostgreSQL), TypeScript, Vitest, Tailwind CSS, Material Symbols

---

## File Map

**New files:**
- `supabase/migrations/022_execution_runs_events.sql` — new tables + column additions
- `lib/execution/execution-types-v2.ts` — new types: ExecutionBudget, RepairAttempt, CommitOutcome, ExecutionSummary, ExecutionDiagnostic, EventType
- `lib/execution/event-emitter.ts` — validated event insert (replaces raw DB calls)
- `lib/execution/stuck-detector.ts` — detects 5 stuck conditions across iterations
- `lib/execution/repair-guard.ts` — allowlist/blocklist for autonomous file edits
- `lib/execution/inline-repair.ts` — scoped tsc/lint repair prompt
- `lib/execution/repair-phase.ts` — multi-file coordinated repair prompt
- `lib/execution/commit-policy.ts` — determines CommitOutcome, applies git op
- `lib/execution/execution-run-manager.ts` — concurrency check, heartbeat, finalize
- `app/api/change-requests/[id]/execute/events/route.ts` — GET events for a run
- `app/api/change-requests/[id]/cancel/route.ts` — POST to request cancellation
- `app/api/internal/execution-recovery/route.ts` — reaps stale runs
- `components/app/execution-live-strip.tsx` — live phase indicator strip
- `components/app/execution-iteration-card.tsx` — per-iteration evidence card

**Modified files:**
- `lib/execution/types.ts` — keep as-is (existing types unchanged)
- `lib/execution/execution-orchestrator.ts` — refactor validation block, wire new modules
- `app/api/change-requests/[id]/execute/route.ts` — add concurrency guard

**Test files:**
- `tests/lib/execution/stuck-detector.test.ts`
- `tests/lib/execution/repair-guard.test.ts`
- `tests/lib/execution/commit-policy.test.ts`
- `tests/lib/execution/event-emitter.test.ts`

---

## Task 1: DB Migration

**Files:**
- Create: `supabase/migrations/022_execution_runs_events.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/022_execution_runs_events.sql

-- execution_runs: one row per execution attempt of a change
create table execution_runs (
  id                       uuid primary key default gen_random_uuid(),
  change_id                uuid not null references change_requests(id) on delete cascade,
  status                   text not null default 'running'
                           check (status in ('running','success','wip','budget_exceeded','blocked','cancelled')),
  cancellation_requested   boolean not null default false,
  summary                  jsonb,
  last_heartbeat_at        timestamptz,
  started_at               timestamptz not null default now(),
  ended_at                 timestamptz
);

create index on execution_runs (change_id, started_at desc);

-- execution_events: append-only event log
create table execution_events (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references execution_runs(id) on delete cascade,
  change_id      uuid not null references change_requests(id) on delete cascade,
  seq            bigint not null,
  iteration      int not null default 0,
  event_type     text not null,
  phase          text,
  schema_version int not null default 1,
  payload        jsonb not null default '{}',
  created_at     timestamptz not null default now(),

  unique (run_id, seq)
);

create index on execution_events (run_id, seq);
create index on execution_events (change_id, run_id, created_at);

-- RLS: users can read events for their own changes
alter table execution_runs enable row level security;
alter table execution_events enable row level security;

create policy "users read own runs"
  on execution_runs for select
  using (
    change_id in (
      select cr.id from change_requests cr
      join projects p on p.id = cr.project_id
      where p.owner_id = auth.uid()
    )
  );

create policy "users read own events"
  on execution_events for select
  using (
    change_id in (
      select cr.id from change_requests cr
      join projects p on p.id = cr.project_id
      where p.owner_id = auth.uid()
    )
  );
```

- [ ] **Step 2: Apply migration**

```bash
cd C:/Users/joelg/softwareFactory_git
supabase db push
```

Expected: migration applies without error. Tables `execution_runs` and `execution_events` appear in Supabase Studio.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/022_execution_runs_events.sql
git commit -m "feat: add execution_runs and execution_events tables"
```

---

## Task 2: New Type Definitions

**Files:**
- Create: `lib/execution/execution-types-v2.ts`

- [ ] **Step 1: Write the types file**

```ts
// lib/execution/execution-types-v2.ts

// ── Event taxonomy ─────────────────────────────────────────────────────────────

export const EVENT_TYPES = [
  'execution.started', 'execution.completed',
  'execution.budget_exceeded', 'execution.blocked', 'execution.cancelled',
  'iteration.started', 'iteration.completed', 'iteration.stuck',
  'phase.static_validation.started', 'phase.static_validation.passed', 'phase.static_validation.failed',
  'phase.unit.started', 'phase.unit.passed', 'phase.unit.failed',
  'phase.integration.started', 'phase.integration.passed', 'phase.integration.failed',
  'phase.smoke.started', 'phase.smoke.passed', 'phase.smoke.failed',
  'phase.skipped',
  'repair.inline.started', 'repair.inline.succeeded', 'repair.inline.failed',
  'repair.phase.started', 'repair.phase.succeeded', 'repair.phase.failed',
  'repair.escalated',
  'commit.green', 'commit.wip', 'commit.skipped', 'commit.failed',
  'infra.retrying',
] as const

export type EventType = typeof EVENT_TYPES[number]

// ── Budget ─────────────────────────────────────────────────────────────────────

export interface ExecutionBudget {
  global: {
    maxIterations: number
    maxRuntimeMs: number
  }
  perIteration: {
    maxInlineRepairs: number
    maxRepairPhaseAttempts: number
  }
}

export const DEFAULT_BUDGET: ExecutionBudget = {
  global: { maxIterations: 5, maxRuntimeMs: 600_000 },
  perIteration: { maxInlineRepairs: 3, maxRepairPhaseAttempts: 2 },
}

// ── Diagnostics ────────────────────────────────────────────────────────────────

export interface ExecutionDiagnostic {
  file: string
  line: number
  message: string
  code: string
}

export interface DiagnosticSet {
  diagnostics: ExecutionDiagnostic[]  // first 20
  totalCount: number
  truncated: boolean
}

// ── Repair ─────────────────────────────────────────────────────────────────────

export type ConfidenceLabel = 'high' | 'medium' | 'low'

export function toConfidenceLabel(score: number): ConfidenceLabel {
  if (score >= 0.75) return 'high'
  if (score >= 0.4)  return 'medium'
  return 'low'
}

export interface RepairAttempt {
  phase: 'inline' | 'repair_phase'
  filesPatched: string[]
  diagnosticsTargeted: string[]
  confidenceScore: number           // 0.0 – 1.0
  confidenceLabel: ConfidenceLabel
  rationale: string                 // max 140 chars
}

// ── Commit outcome ─────────────────────────────────────────────────────────────

export type CommitOutcome =
  | { type: 'green' }
  | { type: 'wip'; reason: string }
  | { type: 'no_commit'; reason: string }
  | { type: 'blocked' }

// ── Execution summary ──────────────────────────────────────────────────────────

export interface ExecutionSummary {
  status: 'success' | 'wip' | 'budget_exceeded' | 'blocked' | 'cancelled'
  iterationsUsed: number
  repairsAttempted: number
  filesChanged: string[]
  finalFailureType: string | null
  commitOutcome: CommitOutcome
  durationMs: number
}

// ── Stuck detector ─────────────────────────────────────────────────────────────

export type StuckReason =
  | 'repeated_diagnostic'
  | 'error_count_increased'
  | 'same_file_repeated'
  | 'alternating_diagnostic'
  | 'budget_hit'

export interface StuckResult {
  stuck: boolean
  reason: StuckReason | null
}

// ── Test mode ──────────────────────────────────────────────────────────────────

export type TestMode = 'fail_fast' | 'collect_all'

// ── Per-iteration tracking ─────────────────────────────────────────────────────

export interface IterationRecord {
  iteration: number
  /** Diagnostic signatures from static validation (for stuck detection) */
  diagnosticSigs: string[]
  /** Error count from static validation */
  errorCount: number
  /** Files patched by any repair in this iteration */
  repairedFiles: string[]
}
```

- [ ] **Step 2: Run tests to verify TS compiles**

```bash
cd C:/Users/joelg/softwareFactory_git
npm run build 2>&1 | head -20
```

Expected: no errors from the new file.

- [ ] **Step 3: Commit**

```bash
git add lib/execution/execution-types-v2.ts
git commit -m "feat: add execution budget, repair, commit, and event types"
```

---

## Task 3: Event Emitter

**Files:**
- Create: `lib/execution/event-emitter.ts`
- Create: `tests/lib/execution/event-emitter.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/lib/execution/event-emitter.test.ts
import { describe, it, expect, vi } from 'vitest'
import { insertEvent, validatePayload } from '@/lib/execution/event-emitter'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeDb(insertFn: (row: unknown) => unknown) {
  return {
    from: () => ({ insert: insertFn }),
  } as unknown as SupabaseClient
}

describe('validatePayload', () => {
  it('passes a valid phase.static_validation.failed payload', () => {
    expect(() => validatePayload('phase.static_validation.failed', {
      diagnostics: [{ file: 'a.ts', line: 1, message: 'err', code: 'TS2322' }],
      totalCount: 1,
      truncated: false,
      durationMs: 100,
    })).not.toThrow()
  })

  it('throws on missing required field', () => {
    expect(() => validatePayload('phase.static_validation.failed', {
      diagnostics: [],
      totalCount: 0,
      // missing truncated and durationMs
    })).toThrow()
  })

  it('passes unknown event types with empty payload', () => {
    expect(() => validatePayload('execution.started', {})).not.toThrow()
  })
})

describe('insertEvent', () => {
  it('inserts a validated event row', async () => {
    const rows: unknown[] = []
    const db = makeDb((row) => { rows.push(row); return { error: null } })

    await insertEvent(db, {
      runId: 'run1',
      changeId: 'cr1',
      seq: 1,
      iteration: 0,
      eventType: 'execution.started',
      payload: {},
    })

    expect(rows).toHaveLength(1)
    expect((rows[0] as any).event_type).toBe('execution.started')
    expect((rows[0] as any).seq).toBe(1)
  })

  it('throws EventPayloadValidationError on invalid payload', async () => {
    const db = makeDb(() => ({ error: null }))
    await expect(insertEvent(db, {
      runId: 'run1',
      changeId: 'cr1',
      seq: 2,
      iteration: 0,
      eventType: 'phase.static_validation.failed',
      payload: { diagnostics: 'not-an-array' },
    })).rejects.toThrow('EventPayloadValidationError')
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npm run test -- tests/lib/execution/event-emitter.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '@/lib/execution/event-emitter'`

- [ ] **Step 3: Implement event-emitter.ts**

```ts
// lib/execution/event-emitter.ts
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

const VALIDATORS: Partial<Record<EventType, PayloadValidator>> = {
  'phase.static_validation.failed': (p) => {
    assertObject(p)
    assertArray(p, 'diagnostics')
    assertField(p, 'totalCount', 'number')
    assertField(p, 'truncated', 'boolean')
    assertField(p, 'durationMs', 'number')
  },
  'phase.unit.failed': (p) => {
    assertObject(p)
    assertArray(p, 'diagnostics')
    assertField(p, 'totalCount', 'number')
    assertField(p, 'truncated', 'boolean')
    assertField(p, 'durationMs', 'number')
  },
  'phase.integration.failed': (p) => {
    assertObject(p)
    assertArray(p, 'diagnostics')
    assertField(p, 'totalCount', 'number')
    assertField(p, 'truncated', 'boolean')
    assertField(p, 'durationMs', 'number')
  },
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
```

- [ ] **Step 4: Run tests**

```bash
npm run test -- tests/lib/execution/event-emitter.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/execution/event-emitter.ts tests/lib/execution/event-emitter.test.ts
git commit -m "feat: add event emitter with payload validation"
```

---

## Task 4: Stuck Detector

**Files:**
- Create: `lib/execution/stuck-detector.ts`
- Create: `tests/lib/execution/stuck-detector.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/lib/execution/stuck-detector.test.ts
import { describe, it, expect } from 'vitest'
import { detectStuck } from '@/lib/execution/stuck-detector'
import type { IterationRecord } from '@/lib/execution/execution-types-v2'

function rec(overrides: Partial<IterationRecord> = {}): IterationRecord {
  return { iteration: 1, diagnosticSigs: [], errorCount: 0, repairedFiles: [], ...overrides }
}

describe('detectStuck', () => {
  it('returns not stuck with no history', () => {
    expect(detectStuck([], rec(), { maxInlineRepairs: 3, maxRepairPhaseAttempts: 2 })).toEqual({ stuck: false, reason: null })
  })

  it('detects repeated_diagnostic', () => {
    const prev = rec({ diagnosticSigs: ['abc123'] })
    const curr = rec({ diagnosticSigs: ['abc123'] })
    const result = detectStuck([prev], curr, { maxInlineRepairs: 3, maxRepairPhaseAttempts: 2 })
    expect(result).toEqual({ stuck: true, reason: 'repeated_diagnostic' })
  })

  it('detects error_count_increased', () => {
    const prev = rec({ errorCount: 2 })
    const curr = rec({ errorCount: 5 })
    expect(detectStuck([prev], curr, { maxInlineRepairs: 3, maxRepairPhaseAttempts: 2 })).toEqual({ stuck: true, reason: 'error_count_increased' })
  })

  it('detects same_file_repeated after 3 patches', () => {
    const history = [
      rec({ repairedFiles: ['a.ts'] }),
      rec({ repairedFiles: ['a.ts'] }),
    ]
    const curr = rec({ repairedFiles: ['a.ts'] })
    expect(detectStuck(history, curr, { maxInlineRepairs: 3, maxRepairPhaseAttempts: 2 })).toEqual({ stuck: true, reason: 'same_file_repeated' })
  })

  it('detects alternating_diagnostic A→B→A', () => {
    const history = [
      rec({ diagnosticSigs: ['aaa'] }),
      rec({ diagnosticSigs: ['bbb'] }),
    ]
    const curr = rec({ diagnosticSigs: ['aaa'] })
    expect(detectStuck(history, curr, { maxInlineRepairs: 3, maxRepairPhaseAttempts: 2 })).toEqual({ stuck: true, reason: 'alternating_diagnostic' })
  })

  it('returns not stuck for healthy iterations', () => {
    const history = [rec({ diagnosticSigs: ['aaa'], errorCount: 3 })]
    const curr = rec({ diagnosticSigs: ['bbb'], errorCount: 1 })
    expect(detectStuck(history, curr, { maxInlineRepairs: 3, maxRepairPhaseAttempts: 2 })).toEqual({ stuck: false, reason: null })
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm run test -- tests/lib/execution/stuck-detector.test.ts 2>&1 | tail -5
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// lib/execution/stuck-detector.ts
import type { IterationRecord, StuckResult } from './execution-types-v2'

interface PerIterationBudget {
  maxInlineRepairs: number
  maxRepairPhaseAttempts: number
}

export function detectStuck(
  history: IterationRecord[],
  current: IterationRecord,
  budget: PerIterationBudget,
): StuckResult {
  if (history.length === 0) return { stuck: false, reason: null }

  const prev = history[history.length - 1]!

  // 1. Same diagnostic signature as previous iteration
  if (
    current.diagnosticSigs.length > 0 &&
    current.diagnosticSigs.some(sig => prev.diagnosticSigs.includes(sig))
  ) {
    return { stuck: true, reason: 'repeated_diagnostic' }
  }

  // 2. Error count increased
  if (prev.errorCount > 0 && current.errorCount > prev.errorCount) {
    return { stuck: true, reason: 'error_count_increased' }
  }

  // 3. Same file patched 3+ times across history + current
  const allRepairedFiles = [...history.flatMap(r => r.repairedFiles), ...current.repairedFiles]
  const fileCounts = new Map<string, number>()
  for (const f of allRepairedFiles) fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1)
  for (const [, count] of fileCounts) {
    if (count >= 3) return { stuck: true, reason: 'same_file_repeated' }
  }

  // 4. Alternating diagnostic pattern (A→B→A across last 3)
  if (history.length >= 2) {
    const prevPrev = history[history.length - 2]!
    if (
      current.diagnosticSigs.length > 0 &&
      prevPrev.diagnosticSigs.length > 0 &&
      current.diagnosticSigs.some(sig => prevPrev.diagnosticSigs.includes(sig)) &&
      prev.diagnosticSigs.some(sig => !current.diagnosticSigs.includes(sig))
    ) {
      return { stuck: true, reason: 'alternating_diagnostic' }
    }
  }

  return { stuck: false, reason: null }
}
```

- [ ] **Step 4: Run tests**

```bash
npm run test -- tests/lib/execution/stuck-detector.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/execution/stuck-detector.ts tests/lib/execution/stuck-detector.test.ts
git commit -m "feat: add stuck detector with 4 pattern checks"
```

---

## Task 5: Repair Guard

**Files:**
- Create: `lib/execution/repair-guard.ts`
- Create: `tests/lib/execution/repair-guard.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/lib/execution/repair-guard.test.ts
import { describe, it, expect } from 'vitest'
import { isPathAllowed, filterPathsToAllowed } from '@/lib/execution/repair-guard'

describe('isPathAllowed', () => {
  it('allows app/ files', () => {
    expect(isPathAllowed('app/dashboard/page.tsx')).toBe(true)
  })

  it('allows lib/ files', () => {
    expect(isPathAllowed('lib/execution/foo.ts')).toBe(true)
  })

  it('blocks .env files', () => {
    expect(isPathAllowed('.env')).toBe(false)
    expect(isPathAllowed('.env.local')).toBe(false)
    expect(isPathAllowed('.env.production')).toBe(false)
  })

  it('blocks migration files', () => {
    expect(isPathAllowed('supabase/migrations/001_init.sql')).toBe(false)
  })

  it('blocks package.json', () => {
    expect(isPathAllowed('package.json')).toBe(false)
    expect(isPathAllowed('package-lock.json')).toBe(false)
  })

  it('blocks secret key files', () => {
    expect(isPathAllowed('certs/server.pem')).toBe(false)
    expect(isPathAllowed('keys/private.key')).toBe(false)
  })

  it('blocks files outside allowed dirs', () => {
    expect(isPathAllowed('scripts/deploy.sh')).toBe(false)
  })
})

describe('filterPathsToAllowed', () => {
  it('filters out blocked paths and keeps allowed ones', () => {
    const paths = ['app/page.tsx', '.env.local', 'lib/foo.ts', 'package.json']
    expect(filterPathsToAllowed(paths)).toEqual(['app/page.tsx', 'lib/foo.ts'])
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm run test -- tests/lib/execution/repair-guard.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: Implement**

```ts
// lib/execution/repair-guard.ts

const ALLOWED_PREFIXES = [
  'app/',
  'components/',
  'lib/',
  'tests/',
  'styles/',
]

const ALLOWED_ROOT_FILES = [
  'tsconfig.json',
  'tailwind.config.js',
  'tailwind.config.ts',
  'tailwind.config.mjs',
  'next.config.js',
  'next.config.ts',
  'next.config.mjs',
]

const BLOCKED_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/,            // .env, .env.local, .env.production, etc.
  /^supabase\/migrations\//,   // migrations are append-only
  /^package(-lock)?\.json$/,   // no dep installs
  /\.(pem|key|secret)$/,       // secrets
]

export function isPathAllowed(path: string): boolean {
  // Check hard deny first
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(path)) return false
  }

  // Check allowed prefixes
  for (const prefix of ALLOWED_PREFIXES) {
    if (path.startsWith(prefix)) return true
  }

  // Check allowed root files
  if (ALLOWED_ROOT_FILES.includes(path)) return true

  return false
}

export function filterPathsToAllowed(paths: string[]): string[] {
  return paths.filter(isPathAllowed)
}
```

- [ ] **Step 4: Run tests**

```bash
npm run test -- tests/lib/execution/repair-guard.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/execution/repair-guard.ts tests/lib/execution/repair-guard.test.ts
git commit -m "feat: add repair guard with path allowlist/blocklist"
```

---

## Task 6: Commit Policy

**Files:**
- Create: `lib/execution/commit-policy.ts`
- Create: `tests/lib/execution/commit-policy.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/lib/execution/commit-policy.test.ts
import { describe, it, expect } from 'vitest'
import { determineCommitOutcome } from '@/lib/execution/commit-policy'

describe('determineCommitOutcome', () => {
  it('returns green when all checks passed and no dirty tree', () => {
    const result = determineCommitOutcome({
      allChecksPassed: true,
      hasDiff: true,
      cancelled: false,
      dirtyFiles: [],
      runFilesChanged: ['app/page.tsx'],
      finalFailureType: null,
    })
    expect(result).toEqual({ type: 'green' })
  })

  it('returns no_commit when there is no diff', () => {
    const result = determineCommitOutcome({
      allChecksPassed: false,
      hasDiff: false,
      cancelled: false,
      dirtyFiles: [],
      runFilesChanged: [],
      finalFailureType: 'tsc',
    })
    expect(result).toEqual({ type: 'no_commit', reason: 'no diff produced' })
  })

  it('returns no_commit when cancelled', () => {
    const result = determineCommitOutcome({
      allChecksPassed: false,
      hasDiff: true,
      cancelled: true,
      dirtyFiles: [],
      runFilesChanged: ['app/page.tsx'],
      finalFailureType: null,
    })
    expect(result).toEqual({ type: 'no_commit', reason: 'run was cancelled' })
  })

  it('returns wip when checks failed but diff exists and no dirty contamination', () => {
    const result = determineCommitOutcome({
      allChecksPassed: false,
      hasDiff: true,
      cancelled: false,
      dirtyFiles: [],
      runFilesChanged: ['app/page.tsx'],
      finalFailureType: 'tsc: 2 errors',
    })
    expect(result).toEqual({ type: 'wip', reason: 'tsc: 2 errors' })
  })

  it('returns no_commit when dirty tree contains unrelated files', () => {
    const result = determineCommitOutcome({
      allChecksPassed: false,
      hasDiff: true,
      cancelled: false,
      dirtyFiles: ['README.md'],    // not in runFilesChanged
      runFilesChanged: ['app/page.tsx'],
      finalFailureType: 'tsc',
    })
    expect(result).toEqual({ type: 'no_commit', reason: 'working tree contains unexpected changes' })
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm run test -- tests/lib/execution/commit-policy.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: Implement**

```ts
// lib/execution/commit-policy.ts
import type { CommitOutcome } from './execution-types-v2'

interface CommitDecisionInput {
  allChecksPassed: boolean
  hasDiff: boolean
  cancelled: boolean
  dirtyFiles: string[]          // from `git status --porcelain`
  runFilesChanged: string[]     // files this run touched
  finalFailureType: string | null
}

export function determineCommitOutcome(input: CommitDecisionInput): CommitOutcome {
  if (input.cancelled) {
    return { type: 'no_commit', reason: 'run was cancelled' }
  }

  if (!input.hasDiff) {
    return { type: 'no_commit', reason: 'no diff produced' }
  }

  // Check for unrelated dirty files
  const unexpected = input.dirtyFiles.filter(f => !input.runFilesChanged.includes(f))
  if (unexpected.length > 0) {
    return { type: 'no_commit', reason: 'working tree contains unexpected changes' }
  }

  if (input.allChecksPassed) {
    return { type: 'green' }
  }

  return { type: 'wip', reason: input.finalFailureType ?? 'checks failed' }
}
```

- [ ] **Step 4: Run tests**

```bash
npm run test -- tests/lib/execution/commit-policy.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/execution/commit-policy.ts tests/lib/execution/commit-policy.test.ts
git commit -m "feat: add commit policy with dirty tree detection and WIP logic"
```

---

## Task 7: Execution Run Manager

**Files:**
- Create: `lib/execution/execution-run-manager.ts`

- [ ] **Step 1: Write the module**

```ts
// lib/execution/execution-run-manager.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecutionSummary } from './execution-types-v2'

/** Check for an active run and create a new one atomically. Returns the new run ID, or null if blocked. */
export async function createExecutionRun(
  db: SupabaseClient,
  changeId: string,
): Promise<string | null> {
  // Check for existing running run
  const { data: existing } = await (db.from('execution_runs') as any)
    .select('id')
    .eq('change_id', changeId)
    .eq('status', 'running')
    .limit(1)
    .maybeSingle()

  if (existing) return null  // already running

  const { data, error } = await (db.from('execution_runs') as any)
    .insert({ change_id: changeId, status: 'running' })
    .select('id')
    .single()

  if (error || !data) throw new Error(`Failed to create execution run: ${error?.message}`)
  return data.id as string
}

/** Write heartbeat timestamp every 30s. Returns an interval handle — call clearInterval() on it. */
export function startHeartbeat(db: SupabaseClient, runId: string): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    await (db.from('execution_runs') as any)
      .update({ last_heartbeat_at: new Date().toISOString() })
      .eq('id', runId)
  }, 30_000)
}

/** Check if cancellation was requested for this run. */
export async function isCancellationRequested(db: SupabaseClient, runId: string): Promise<boolean> {
  const { data } = await (db.from('execution_runs') as any)
    .select('cancellation_requested')
    .eq('id', runId)
    .single()
  return (data as any)?.cancellation_requested === true
}

/** Finalize the run: write summary, set status, set ended_at. */
export async function finalizeRun(
  db: SupabaseClient,
  runId: string,
  status: ExecutionSummary['status'],
  summary: ExecutionSummary,
): Promise<void> {
  await (db.from('execution_runs') as any)
    .update({
      status,
      summary,
      ended_at: new Date().toISOString(),
    })
    .eq('id', runId)
}
```

- [ ] **Step 2: Verify TS compiles**

```bash
npm run build 2>&1 | grep "execution-run-manager" | head -5
```

Expected: no errors from this file.

- [ ] **Step 3: Commit**

```bash
git add lib/execution/execution-run-manager.ts
git commit -m "feat: add execution run manager (concurrency, heartbeat, finalize)"
```

---

## Task 8: Inline Repair

**Files:**
- Create: `lib/execution/inline-repair.ts`

- [ ] **Step 1: Write the module**

```ts
// lib/execution/inline-repair.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { CodeExecutor } from './executors/code-executor'
import type { ExecutionEnvironment } from './types'
import type { DiagnosticSet, RepairAttempt } from './execution-types-v2'
import { toConfidenceLabel } from './execution-types-v2'
import { isPathAllowed } from './repair-guard'
import { insertEvent, nextSeq } from './event-emitter'

function buildInlineRepairPrompt(diagnostics: DiagnosticSet, fileContexts: Record<string, string>): string {
  const diagLines = diagnostics.diagnostics
    .map(d => `${d.file}:${d.line} [${d.code}] ${d.message}`)
    .join('\n')

  const fileSection = Object.entries(fileContexts)
    .map(([path, content]) => `// === ${path} ===\n${content}`)
    .join('\n\n')

  return `You are fixing TypeScript/lint errors. Fix ONLY the listed errors. Do not refactor or change unrelated code.

ERRORS TO FIX:
${diagLines}

FILE CONTENTS:
${fileSection}

Respond with JSON:
{
  "patches": [
    { "file": "path/to/file.ts", "newContent": "full file content after fix" }
  ],
  "confidence": 0.85,
  "rationale": "one sentence, max 140 chars"
}`
}

export async function runInlineRepair(
  db: SupabaseClient,
  ai: AIProvider,
  executor: CodeExecutor,
  env: ExecutionEnvironment,
  runId: string,
  changeId: string,
  iteration: number,
  diagnostics: DiagnosticSet,
  seq: () => number,
): Promise<RepairAttempt> {
  const startMs = Date.now()

  await insertEvent(db, {
    runId, changeId, seq: seq(), iteration,
    eventType: 'repair.inline.started',
    payload: {},
  })

  // Gather file contents for affected files (allowed only)
  const affectedFiles = [...new Set(diagnostics.diagnostics.map(d => d.file))]
    .filter(isPathAllowed)
    .slice(0, 3)  // max 3 files per inline repair

  const fileContexts: Record<string, string> = {}
  for (const filePath of affectedFiles) {
    try {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      fileContexts[filePath] = await readFile(join(env.localWorkDir, filePath), 'utf8')
    } catch { /* skip unreadable files */ }
  }

  const prompt = buildInlineRepairPrompt(diagnostics, fileContexts)
  const aiResult = await ai.complete(prompt, { maxTokens: 4096 })

  let parsed: { patches?: { file: string; newContent: string }[]; confidence?: number; rationale?: string } = {}
  try {
    const stripped = aiResult.content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim()
    parsed = JSON.parse(stripped)
  } catch { /* leave parsed empty */ }

  const patches = (parsed.patches ?? []).filter(p => isPathAllowed(p.file))
  const filesPatched: string[] = []

  for (const patch of patches.slice(0, 3)) {
    const result = await executor.createFile(env, patch.file, patch.newContent)
    if (result.success) filesPatched.push(patch.file)
  }

  const confidenceScore = (parsed.confidence ?? 0.5)
  const rationale = (parsed.rationale ?? 'inline repair applied').slice(0, 140)
  const durationMs = Date.now() - startMs

  const attempt: RepairAttempt = {
    phase: 'inline',
    filesPatched,
    diagnosticsTargeted: diagnostics.diagnostics.map(d => `${d.file}:${d.line}:${d.code}`),
    confidenceScore,
    confidenceLabel: toConfidenceLabel(confidenceScore),
    rationale,
  }

  await insertEvent(db, {
    runId, changeId, seq: seq(), iteration,
    eventType: filesPatched.length > 0 ? 'repair.inline.succeeded' : 'repair.inline.failed',
    payload: { attempt, durationMs },
  })

  return attempt
}
```

- [ ] **Step 2: Verify TS compiles**

```bash
npm run build 2>&1 | grep "inline-repair" | head -5
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/execution/inline-repair.ts
git commit -m "feat: add inline repair for static validation failures"
```

---

## Task 9: Repair Phase

**Files:**
- Create: `lib/execution/repair-phase.ts`

- [ ] **Step 1: Write the module**

```ts
// lib/execution/repair-phase.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { CodeExecutor } from './executors/code-executor'
import type { ExecutionEnvironment } from './types'
import type { DiagnosticSet, RepairAttempt } from './execution-types-v2'
import { toConfidenceLabel } from './execution-types-v2'
import { isPathAllowed } from './repair-guard'
import { insertEvent } from './event-emitter'

function buildRepairPhasePrompt(
  failures: DiagnosticSet,
  changeIntent: string,
  fileContexts: Record<string, string>,
): string {
  const failureLines = failures.diagnostics
    .map(d => `${d.file}:${d.line} — ${d.message}`)
    .join('\n')

  const fileSection = Object.entries(fileContexts)
    .map(([path, content]) => `// === ${path} ===\n${content}`)
    .join('\n\n')

  return `You are fixing test failures in a TypeScript/Next.js codebase.
Change intent: ${changeIntent}

FAILURES:
${failureLines}
${failures.truncated ? `(${failures.totalCount} total failures — showing first ${failures.diagnostics.length})` : ''}

FILE CONTENTS:
${fileSection}

Analyze the root cause. Fix the underlying issue — not just the symptom. Do not change unrelated code.

Respond with JSON:
{
  "patches": [
    { "file": "path/to/file.ts", "newContent": "full file content after fix" }
  ],
  "confidence": 0.72,
  "rationale": "one sentence root cause and fix summary, max 140 chars"
}`
}

export async function runRepairPhase(
  db: SupabaseClient,
  ai: AIProvider,
  executor: CodeExecutor,
  env: ExecutionEnvironment,
  runId: string,
  changeId: string,
  iteration: number,
  failures: DiagnosticSet,
  changeIntent: string,
  seq: () => number,
): Promise<RepairAttempt> {
  const startMs = Date.now()

  await insertEvent(db, {
    runId, changeId, seq: seq(), iteration,
    eventType: 'repair.phase.started',
    payload: {},
  })

  const affectedFiles = [...new Set(failures.diagnostics.map(d => d.file))]
    .filter(isPathAllowed)
    .slice(0, 8)

  const fileContexts: Record<string, string> = {}
  for (const filePath of affectedFiles) {
    try {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      fileContexts[filePath] = await readFile(join(env.localWorkDir, filePath), 'utf8')
    } catch { /* skip */ }
  }

  const prompt = buildRepairPhasePrompt(failures, changeIntent, fileContexts)
  const aiResult = await ai.complete(prompt, { maxTokens: 8192 })

  let parsed: { patches?: { file: string; newContent: string }[]; confidence?: number; rationale?: string } = {}
  try {
    const stripped = aiResult.content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim()
    parsed = JSON.parse(stripped)
  } catch { /* leave empty */ }

  const patches = (parsed.patches ?? []).filter(p => isPathAllowed(p.file))
  const filesPatched: string[] = []

  for (const patch of patches.slice(0, 8)) {
    const result = await executor.createFile(env, patch.file, patch.newContent)
    if (result.success) filesPatched.push(patch.file)
  }

  const confidenceScore = parsed.confidence ?? 0.5
  const rationale = (parsed.rationale ?? 'repair phase applied').slice(0, 140)
  const durationMs = Date.now() - startMs

  const attempt: RepairAttempt = {
    phase: 'repair_phase',
    filesPatched,
    diagnosticsTargeted: failures.diagnostics.map(d => `${d.file}:${d.line}`),
    confidenceScore,
    confidenceLabel: toConfidenceLabel(confidenceScore),
    rationale,
  }

  await insertEvent(db, {
    runId, changeId, seq: seq(), iteration,
    eventType: filesPatched.length > 0 ? 'repair.phase.succeeded' : 'repair.phase.failed',
    payload: { attempt, durationMs },
  })

  return attempt
}
```

- [ ] **Step 2: Verify TS compiles**

```bash
npm run build 2>&1 | grep "repair-phase" | head -5
```

- [ ] **Step 3: Commit**

```bash
git add lib/execution/repair-phase.ts
git commit -m "feat: add repair phase for test/behavioral failures"
```

---

## Task 10: Orchestrator Refactor

**Files:**
- Modify: `lib/execution/execution-orchestrator.ts`

This is the core wiring task. The `implementChanges` loop (symbol extraction, AI prompting, patch application) is unchanged. What changes is everything after the patches are applied in each iteration.

- [ ] **Step 1: Add imports at top of execution-orchestrator.ts**

After the existing imports block, add:

```ts
import { DEFAULT_BUDGET } from './execution-types-v2'
import type { ExecutionBudget, IterationRecord } from './execution-types-v2'
import { insertEvent, nextSeq, clearSeq } from './event-emitter'
import { detectStuck } from './stuck-detector'
import { determineCommitOutcome } from './commit-policy'
import { runInlineRepair } from './inline-repair'
import { runRepairPhase } from './repair-phase'
import { createExecutionRun, startHeartbeat, isCancellationRequested, finalizeRun } from './execution-run-manager'
import type { DiagnosticSet, CommitOutcome, ExecutionSummary } from './execution-types-v2'
```

- [ ] **Step 2: Update runExecution signature**

Change:
```ts
export async function runExecution(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider,
  executor: CodeExecutor,
  limits: ExecutionLimits = DEFAULT_LIMITS
): Promise<void> {
```

To:
```ts
export async function runExecution(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider,
  executor: CodeExecutor,
  limits: ExecutionLimits = DEFAULT_LIMITS,
  budget: ExecutionBudget = DEFAULT_BUDGET,
): Promise<void> {
```

- [ ] **Step 3: Add execution run creation at the start of runExecution**

After `await db.from('change_requests').update({ status: 'executing' }).eq('id', changeId)`, add:

```ts
  // Create execution run (concurrency guard)
  const runId = await createExecutionRun(db, changeId)
  if (!runId) {
    console.warn(`[execution-orchestrator] concurrency block: run already active for change ${changeId}`)
    return
  }

  let seqN = 0
  const seq = () => ++seqN
  const heartbeat = startHeartbeat(db, runId)
  let repairsAttempted = 0
  const iterationHistory: IterationRecord[] = []
  let allFilesChanged: string[] = []
  let finalFailureType: string | null = null
  let commitOutcome: CommitOutcome = { type: 'no_commit', reason: 'not started' }
  let runStatus: 'success' | 'wip' | 'budget_exceeded' | 'blocked' | 'cancelled' = 'budget_exceeded'
```

- [ ] **Step 4: Emit execution.started after environment is ready**

After the `env = await executor.prepareEnvironment(...)` call and the `await log('success', ...)` line, add:

```ts
    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: 0,
      eventType: 'execution.started',
      payload: {},
    })
```

- [ ] **Step 5: Replace the post-implementation validation block**

Find the block starting with:
```ts
      // Validate
      await log('info', `Running type check…`)
      const typeCheck = await executor.runTypeCheck(env)
```
and ending at:
```ts
      pendingTasks = pendingTasks.filter(t => !processedTaskIds.includes(t.id))
      if (pendingTasks.length === 0) {
        fullSuccess = true
        break
      }
```

Replace that entire block with:

```ts
      // ── Static validation phase ─────────────────────────────────────────
      await log('info', `Running static validation…`)
      const svStart = Date.now()
      await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'phase.static_validation.started', payload: {} })

      let typeCheck = await executor.runTypeCheck(env)
      let inlineRepairCount = 0

      while (!typeCheck.passed && inlineRepairCount < budget.perIteration.maxInlineRepairs) {
        // Build diagnostic set (first 20, truncated flag)
        const allDiags = typeCheck.errors.map(e => ({ file: e.file, line: e.line, message: e.message, code: 'TS' }))
        const diagnostics: DiagnosticSet = {
          diagnostics: allDiags.slice(0, 20),
          totalCount: allDiags.length,
          truncated: allDiags.length > 20,
        }
        await log('error', `Type check failed · ${allDiags.length} error${allDiags.length !== 1 ? 's' : ''}`)
        const attempt = await runInlineRepair(db, ai, executor, env, runId, changeId, state.iteration, diagnostics, seq)
        repairsAttempted++
        allFilesChanged = [...new Set([...allFilesChanged, ...attempt.filesPatched])]
        inlineRepairCount++
        typeCheck = await executor.runTypeCheck(env)
      }

      const svDurationMs = Date.now() - svStart
      if (!typeCheck.passed) {
        const allDiags = typeCheck.errors.map(e => ({ file: e.file, line: e.line, message: e.message, code: 'TS' }))
        const diagnosticSigs = allDiags.map(d => `${d.file}:${d.line}:${d.message.slice(0, 40)}`)
        finalFailureType = `tsc: ${allDiags.length} error${allDiags.length !== 1 ? 's' : ''}`

        await insertEvent(db, {
          runId, changeId, seq: seq(), iteration: state.iteration,
          eventType: 'phase.static_validation.failed',
          payload: {
            diagnostics: allDiags.slice(0, 20),
            totalCount: allDiags.length,
            truncated: allDiags.length > 20,
            durationMs: svDurationMs,
          },
        })

        const currRecord: IterationRecord = { iteration: state.iteration, diagnosticSigs, errorCount: allDiags.length, repairedFiles: [] }
        const stuck = detectStuck(iterationHistory, currRecord, budget.perIteration)
        if (stuck.stuck) {
          await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'iteration.stuck', payload: { reason: stuck.reason } })
          await log('error', `Stuck detector fired: ${stuck.reason}`)
          break
        }
        iterationHistory.push(currRecord)
        await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'iteration.completed', payload: { durationMs: Date.now() - svStart } })
        continue
      }

      await log('success', `Static validation passed`)
      await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'phase.static_validation.passed', payload: { durationMs: svDurationMs } })

      // ── Test phases ─────────────────────────────────────────────────────
      const testScope = await selectTests(db, [], (change as { risk_level: string | null }).risk_level ?? 'low')
      const totalTests = testScope.directTests.length + testScope.dependentTests.length
      await log('info', `Running ${totalTests > 0 ? totalTests + ' test file' + (totalTests !== 1 ? 's' : '') : 'all tests'}…`)
      await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'phase.unit.started', payload: {} })

      const utStart = Date.now()
      const testResult = await executor.runTests(env, testScope)
      const utDurationMs = Date.now() - utStart

      let repairPhaseCount = 0
      let testsPassed = testResult.passed

      if (!testResult.passed) {
        const failureDiags = testResult.failures.map((f, i) => ({
          file: f.testName, line: i + 1, message: f.error.slice(0, 200), code: 'TEST'
        }))
        const failureSet: DiagnosticSet = {
          diagnostics: failureDiags.slice(0, 20),
          totalCount: failureDiags.length,
          truncated: failureDiags.length > 20,
        }

        await insertEvent(db, {
          runId, changeId, seq: seq(), iteration: state.iteration,
          eventType: 'phase.unit.failed',
          payload: { diagnostics: failureSet.diagnostics, totalCount: failureSet.totalCount, truncated: failureSet.truncated, durationMs: utDurationMs },
        })

        while (!testsPassed && repairPhaseCount < budget.perIteration.maxRepairPhaseAttempts) {
          await log('error', `Tests failed · ${testResult.testsFailed} failed`)
          const attempt = await runRepairPhase(db, ai, executor, env, runId, changeId, state.iteration, failureSet, (change as any).intent ?? '', seq)
          repairsAttempted++
          allFilesChanged = [...new Set([...allFilesChanged, ...attempt.filesPatched])]
          repairPhaseCount++
          const retest = await executor.runTests(env, testScope)
          testsPassed = retest.passed
          if (testsPassed) break
        }

        if (!testsPassed) {
          finalFailureType = `tests: ${testResult.testsFailed} failed`
          const currRecord: IterationRecord = { iteration: state.iteration, diagnosticSigs: [], errorCount: testResult.testsFailed, repairedFiles: [] }
          const stuck = detectStuck(iterationHistory, currRecord, budget.perIteration)
          if (stuck.stuck) {
            await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'iteration.stuck', payload: { reason: stuck.reason } })
            await log('error', `Stuck detector fired: ${stuck.reason}`)
            break
          }
          iterationHistory.push(currRecord)
          await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'iteration.completed', payload: { durationMs: Date.now() - utStart } })
          continue
        }
      }

      await log('success', `Tests passed`)
      await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'phase.unit.passed', payload: { durationMs: utDurationMs } })

      // ── Behavioral checks (unchanged) ────────────────────────────────────
      const behavioralScope: BehavioralScope = {
        patches: iterationPatches,
        criticalComponentTouched: Object.values(componentTypeMap).some(t => ['auth', 'db'].includes(t)),
      }
      const behavResult = await executor.runBehavioralChecks(env, behavioralScope)
      if (!behavResult.passed) {
        const anomalyMsg = behavResult.anomalies.map(a => `[${a.severity}] ${a.description}`).join('\n')
        await log('error', `Behavioral check failed\n${anomalyMsg}`)
        finalFailureType = 'behavioral: ' + behavResult.anomalies[0]?.description?.slice(0, 80)
        await writeSnapshot(db, changeId, state, 'error', false, 0, 0, anomalyMsg.slice(0, 8000))
        continue
      }

      // All checks passed for this iteration
      state.acceptedPatches.push(...iterationPatches)
      state.acceptedNewFiles.push(...iterationNewFiles)
      allFilesChanged = [...new Set([...allFilesChanged, ...iterationPatches.map(p => p.path), ...iterationNewFiles.map(f => f.path)])]

      await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'iteration.completed', payload: { durationMs: Date.now() - svStart } })

      pendingTasks = pendingTasks.filter(t => !processedTaskIds.includes(t.id))
      if (pendingTasks.length === 0) {
        fullSuccess = true
        break
      }

      // Check cancellation at iteration boundary
      if (await isCancellationRequested(db, runId)) {
        await log('info', 'Cancellation requested — stopping after iteration boundary')
        runStatus = 'cancelled'
        break
      }
```

- [ ] **Step 6: Replace the commit block**

Find and replace the unconditional commit block (starting with `// Commit and push`):

```ts
    // ── Commit policy ─────────────────────────────────────────────────────
    const cancelled = runStatus === 'cancelled'
    let hasDiff = false
    try {
      const diff = await executor.getDiff(env)
      hasDiff = (diff?.filesChanged?.length ?? 0) > 0
    } catch { /* treat as no diff */ }

    // Check dirty tree
    let dirtyFiles: string[] = []
    try {
      const { exec } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execAsync = promisify(exec)
      const { stdout } = await execAsync('git status --porcelain', { cwd: env.localWorkDir })
      dirtyFiles = stdout.split('\n').filter(Boolean).map(l => l.slice(3).trim())
    } catch { /* ignore */ }

    commitOutcome = determineCommitOutcome({
      allChecksPassed: fullSuccess,
      hasDiff,
      cancelled,
      dirtyFiles,
      runFilesChanged: allFilesChanged,
      finalFailureType,
    })

    if (commitOutcome.type === 'green' || commitOutcome.type === 'wip') {
      try {
        const commitMsg = commitOutcome.type === 'green'
          ? `feat: ${(change as { title: string }).title} (${changeId.slice(0, 8)})`
          : `wip: ${(change as { title: string }).title} (${finalFailureType ?? 'checks failed'})`

        await log('info', `Committing → ${branch} [${commitOutcome.type}]`)
        const commitResult = await executor.commitAndPush(env, branch, commitMsg)
        await db.from('change_commits').insert({
          change_id: changeId,
          branch_name: commitResult.branch,
          commit_hash: commitResult.commitHash,
        })
        await log('success', `Committed ${commitResult.commitHash.slice(0, 7)} → ${commitResult.branch}`)
        await insertEvent(db, {
          runId, changeId, seq: seq(), iteration: state.iteration,
          eventType: commitOutcome.type === 'green' ? 'commit.green' : 'commit.wip',
          payload: commitOutcome.type === 'wip' ? { reason: commitOutcome.reason, durationMs: 0 } : { durationMs: 0 },
        })
      } catch (commitErr) {
        await log('error', `Commit failed: ${(commitErr as Error).message}`)
        await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'commit.failed', payload: { reason: (commitErr as Error).message, durationMs: 0 } })
        commitOutcome = { type: 'no_commit', reason: 'git error' }
      }
    } else {
      await log('info', `Commit skipped: ${(commitOutcome as any).reason ?? 'cancelled'}`)
      await insertEvent(db, {
        runId, changeId, seq: seq(), iteration: state.iteration,
        eventType: 'commit.skipped',
        payload: { reason: (commitOutcome as any).reason ?? 'cancelled', durationMs: 0 },
      })
    }

    // Determine final run status
    if (!cancelled) {
      if (fullSuccess) runStatus = 'success'
      else if (commitOutcome.type === 'wip') runStatus = 'wip'
      else runStatus = 'budget_exceeded'
    }
```

- [ ] **Step 7: Replace the existing post-loop status writes with finalize calls**

Find and replace the block starting with `if (!fullSuccess) { await writeSnapshot...` through the end of the `try` block (before `} catch (err) {`):

```ts
    await log(fullSuccess ? 'success' : 'error', fullSuccess ? 'Execution complete — ready for review' : `Execution finished: ${finalFailureType ?? 'budget exceeded'}`)

    const executionOutcome: 'success' | 'failure' = fullSuccess ? 'success' : 'failure'

    const summary: ExecutionSummary = {
      status: runStatus,
      iterationsUsed: state.iteration,
      repairsAttempted,
      filesChanged: allFilesChanged,
      finalFailureType,
      commitOutcome,
      durationMs: Date.now() - state.startedAt,
    }

    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: state.iteration,
      eventType: 'execution.completed',
      payload: { summary },
    })

    clearInterval(heartbeat)
    clearSeq(runId)
    await finalizeRun(db, runId, runStatus, summary)

    // Write stub (existing dashboard compat)
    let completionVersion: number
    try {
      completionVersion = await nextVersion(db, projectId)
      await writeStub(db, changeId, completionVersion, executionOutcome, 'completed')
    } catch (stubErr) {
      console.error('[dashboard] stub write failed:', stubErr)
      return
    }

    await db.from('change_requests')
      .update({ status: fullSuccess ? 'review' : 'failed', analysis_status: 'completed' })
      .eq('id', changeId)

    const completedEvent: DashboardEvent = {
      type: 'completed', scope: 'analysis',
      changeId, projectId,
      analysisVersion: currentAnalysisVersion,
      version: completionVersion,
      payload: { outcome: executionOutcome },
    }
    emitDashboardEvent(projectId, completedEvent)
    recordEvent(db, projectId, completedEvent).catch(() => {})

    const filesModified = allFilesChanged
    enrichSnapshotWithRetry(db, projectId, changeId, {
      stagesCompleted: [`iteration_${state.iteration}`],
      filesModified,
      componentsAffected: Object.keys(componentTypeMap),
      durationMs: Date.now() - state.startedAt,
    }).catch(() => {})
```

- [ ] **Step 8: Update catch block to finalize run on error**

In the `} catch (err) {` block, after the existing error writes, add:

```ts
    clearInterval(heartbeat)
    clearSeq(runId)
    await finalizeRun(db, runId, 'blocked', {
      status: 'blocked',
      iterationsUsed: 0,
      repairsAttempted: 0,
      filesChanged: [],
      finalFailureType: errorMessage,
      commitOutcome: { type: 'no_commit', reason: 'error' },
      durationMs: 0,
    }).catch(() => {})
```

- [ ] **Step 9: Build to check for TS errors**

```bash
npm run build 2>&1 | grep -E "error TS|Error:" | head -20
```

Fix any type errors before continuing. Common ones:
- Missing `BehavioralScope` import — it's already imported from `./types`
- `clearInterval` argument — TypeScript may complain about the type. Add `as unknown as ReturnType<typeof setInterval>` if needed.

- [ ] **Step 10: Run existing orchestrator tests**

```bash
npm run test -- tests/lib/execution/execution-orchestrator.test.ts
```

Expected: tests pass (or skip gracefully — the mock executor tests should still work).

- [ ] **Step 11: Commit**

```bash
git add lib/execution/execution-orchestrator.ts
git commit -m "feat: wire repair loop, stuck detector, and commit policy into orchestrator"
```

---

## Task 11: API Layer — Concurrency + Cancel + Events

**Files:**
- Modify: `app/api/change-requests/[id]/execute/route.ts`
- Create: `app/api/change-requests/[id]/cancel/route.ts`
- Create: `app/api/change-requests/[id]/execute/events/route.ts`

- [ ] **Step 1: Add concurrency guard to execute/route.ts**

After the `if (!plan || plan.status !== 'approved')` check, add:

```ts
  // Concurrency guard — one active run per change
  const { data: activeRun } = await db
    .from('execution_runs')
    .select('id')
    .eq('change_id', id)
    .eq('status', 'running')
    .limit(1)
    .maybeSingle()

  if (activeRun) {
    return NextResponse.json(
      { error: 'An execution is already in progress for this change.' },
      { status: 409 }
    )
  }
```

- [ ] **Step 2: Create cancel route**

```ts
// app/api/change-requests/[id]/cancel/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select('id, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const adminDb = createAdminClient()
  const { data: activeRun } = await adminDb
    .from('execution_runs')
    .select('id, status')
    .eq('change_id', id)
    .eq('status', 'running')
    .limit(1)
    .maybeSingle()

  if (!activeRun) {
    return NextResponse.json({ error: 'No active run to cancel' }, { status: 409 })
  }

  await adminDb
    .from('execution_runs')
    .update({ cancellation_requested: true })
    .eq('id', activeRun.id)

  return NextResponse.json({ ok: true, runId: activeRun.id })
}
```

- [ ] **Step 3: Create events polling route**

```ts
// app/api/change-requests/[id]/execute/events/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select('id, status, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Get latest run
  const { data: run } = await db
    .from('execution_runs')
    .select('id, status, summary, started_at, ended_at, cancellation_requested')
    .eq('change_id', id)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!run) {
    return NextResponse.json({ run: null, events: [], changeStatus: change.status })
  }

  // Get all events for this run ordered by seq
  const { data: events } = await db
    .from('execution_events')
    .select('id, seq, iteration, event_type, phase, payload, created_at')
    .eq('run_id', run.id)
    .order('seq', { ascending: true })

  return NextResponse.json({
    run: {
      id: run.id,
      status: run.status,
      summary: run.summary,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      cancellationRequested: run.cancellation_requested,
    },
    events: events ?? [],
    changeStatus: change.status,
  })
}
```

- [ ] **Step 4: Commit**

```bash
git add app/api/change-requests/[id]/execute/route.ts \
        app/api/change-requests/[id]/cancel/route.ts \
        app/api/change-requests/[id]/execute/events/route.ts
git commit -m "feat: add concurrency guard, cancel endpoint, and events polling route"
```

---

## Task 12: Stale Run Reaper

**Files:**
- Create: `app/api/internal/execution-recovery/route.ts`

- [ ] **Step 1: Create the route**

```ts
// app/api/internal/execution-recovery/route.ts
// Called by a Supabase cron or on-startup hook to reap immortal "running" runs.
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(req: Request) {
  // Simple shared secret guard — not user-auth, this is internal
  const secret = req.headers.get('x-internal-secret')
  if (secret !== process.env.INTERNAL_API_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createAdminClient()

  // Find stale runs: running for >15min with heartbeat >2min old
  const { data: staleRuns } = await db
    .from('execution_runs')
    .select('id, change_id')
    .eq('status', 'running')
    .lt('started_at', new Date(Date.now() - 15 * 60 * 1000).toISOString())
    .or(`last_heartbeat_at.is.null,last_heartbeat_at.lt.${new Date(Date.now() - 2 * 60 * 1000).toISOString()}`)

  const reaped: string[] = []
  for (const run of staleRuns ?? []) {
    const summary = {
      status: 'blocked',
      iterationsUsed: 0,
      repairsAttempted: 0,
      filesChanged: [],
      finalFailureType: 'server_interrupted',
      commitOutcome: { type: 'no_commit', reason: 'server interrupted' },
      durationMs: 0,
    }
    await db.from('execution_runs').update({
      status: 'blocked',
      summary,
      ended_at: new Date().toISOString(),
    }).eq('id', run.id)

    await db.from('execution_events').insert({
      run_id: run.id,
      change_id: run.change_id,
      seq: 9999,
      iteration: 0,
      event_type: 'execution.blocked',
      schema_version: 1,
      payload: { reason: 'server_interrupted' },
    })

    reaped.push(run.id)
  }

  return NextResponse.json({ reaped, count: reaped.length })
}
```

- [ ] **Step 2: Add INTERNAL_API_SECRET to .env.local.example**

Open `.env.local.example` and add:
```
INTERNAL_API_SECRET=change-me-in-production
```

- [ ] **Step 3: Commit**

```bash
git add app/api/internal/execution-recovery/route.ts .env.local.example
git commit -m "feat: add stale run reaper for server-restart recovery"
```

---

## Task 13: ExecutionLiveStrip Component

**Files:**
- Create: `components/app/execution-live-strip.tsx`

- [ ] **Step 1: Write the component**

```tsx
// components/app/execution-live-strip.tsx
'use client'
import { useState, useEffect } from 'react'

type Phase = 'implementing' | 'static_validation' | 'unit' | 'integration' | 'smoke' | 'repair_inline' | 'repair_phase' | 'committing' | 'idle'

interface LiveEvent {
  event_type: string
  phase?: string
  payload?: Record<string, unknown>
  created_at: string
}

function deriveCurrentPhase(events: LiveEvent[]): { phase: Phase; detail: string } {
  if (events.length === 0) return { phase: 'idle', detail: '' }

  // Walk events in reverse to find the most recent started event without a corresponding ended
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    const t = e.event_type
    if (t === 'execution.completed' || t === 'execution.cancelled' || t === 'execution.budget_exceeded' || t === 'execution.blocked') {
      return { phase: 'idle', detail: '' }
    }
    if (t === 'commit.green' || t === 'commit.wip' || t === 'commit.skipped') {
      return { phase: 'committing', detail: 'Finishing up…' }
    }
    if (t === 'repair.phase.started') return { phase: 'repair_phase', detail: 'Analyzing failure patterns…' }
    if (t === 'repair.inline.started') return { phase: 'repair_inline', detail: 'Patching type errors…' }
    if (t === 'phase.smoke.started') return { phase: 'smoke', detail: 'Running smoke checks…' }
    if (t === 'phase.integration.started') return { phase: 'integration', detail: 'Running integration tests…' }
    if (t === 'phase.unit.started') return { phase: 'unit', detail: 'Running unit tests…' }
    if (t === 'phase.static_validation.started') return { phase: 'static_validation', detail: 'Checking types and lint…' }
    if (t === 'iteration.started') return { phase: 'implementing', detail: 'Implementing changes…' }
  }
  return { phase: 'implementing', detail: 'Starting…' }
}

const SLOTS: { phase: Phase; label: string; icon: string }[] = [
  { phase: 'implementing',      label: 'Implementing',       icon: 'code'           },
  { phase: 'static_validation', label: 'Static validation',  icon: 'check_circle'   },
  { phase: 'unit',              label: 'Unit tests',         icon: 'science'        },
  { phase: 'integration',       label: 'Integration',        icon: 'link'           },
  { phase: 'smoke',             label: 'Smoke checks',       icon: 'bolt'           },
]

const REPAIR_PHASES: Phase[] = ['repair_inline', 'repair_phase']

interface Props {
  events: LiveEvent[]
  runActive: boolean
  elapsedMs: number
  cancelState: 'idle' | 'requesting' | 'cancelled' | 'committing' | 'force_failed'
  onCancel: () => void
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const ss = s % 60
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

export function ExecutionLiveStrip({ events, runActive, elapsedMs, cancelState, onCancel }: Props) {
  const { phase: currentPhase, detail } = deriveCurrentPhase(events)

  const isRepairActive = REPAIR_PHASES.includes(currentPhase)

  function slotState(slotPhase: Phase): 'running' | 'repair' | 'done' | 'queued' {
    const slotIndex = SLOTS.findIndex(s => s.phase === slotPhase)
    const currentIndex = SLOTS.findIndex(s => s.phase === currentPhase)
    if (slotIndex === currentIndex) return isRepairActive ? 'repair' : 'running'
    if (slotIndex < currentIndex) return 'done'
    return 'queued'
  }

  const cancelLabel =
    cancelState === 'requesting' ? 'Cancelling…' :
    cancelState === 'cancelled'  ? 'Cancelled'   :
    cancelState === 'committing' ? 'Cannot cancel — committing' :
    cancelState === 'force_failed' ? 'Force stop failed' :
    'Cancel'

  const cancelDisabled = cancelState !== 'idle'

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Execution: ${currentPhase}${detail ? ' — ' + detail : ''}`}
      className="w-full rounded-xl bg-[#0f1929] border border-white/[0.06] px-5 py-3 flex items-center gap-4"
    >
      {/* Slots */}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {SLOTS.map((slot, i) => {
          const state = slotState(slot.phase)
          const dotColor =
            state === 'running' ? 'bg-blue-400 animate-pulse'  :
            state === 'repair'  ? 'bg-yellow-400 animate-pulse' :
            state === 'done'    ? 'bg-green-400'               :
            'bg-white/[0.10]'

          const labelColor =
            state === 'running' ? 'text-blue-300'   :
            state === 'repair'  ? 'text-yellow-300' :
            state === 'done'    ? 'text-green-400'  :
            'text-slate-600'

          const iconColor =
            state === 'running' ? 'text-blue-400'   :
            state === 'repair'  ? 'text-yellow-400' :
            state === 'done'    ? 'text-green-500'  :
            'text-slate-700'

          return (
            <div key={slot.phase} className="flex items-center gap-2 flex-shrink-0">
              {i > 0 && <div className={`w-4 h-px flex-shrink-0 ${state === 'queued' ? 'bg-white/[0.06]' : 'bg-white/[0.15]'}`} />}
              <div className="flex items-center gap-1.5">
                <span className={`material-symbols-outlined ${iconColor}`} style={{ fontSize: '14px' }}>
                  {state === 'done' ? 'check' : slot.icon}
                </span>
                <span className={`text-[11px] font-medium font-headline ${labelColor} hidden sm:block`}>
                  {slot.label}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Detail subtext */}
      {detail && runActive && (
        <span className="text-[10px] font-mono text-slate-500 truncate hidden md:block flex-shrink min-w-0">
          {detail}
        </span>
      )}

      {/* Elapsed + cancel */}
      {runActive && (
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[11px] font-mono text-slate-500">{formatElapsed(elapsedMs)}</span>
          <button
            onClick={onCancel}
            disabled={cancelDisabled}
            aria-label={cancelLabel}
            className="px-2.5 py-1 rounded-lg text-[10px] font-bold font-headline uppercase tracking-wider border transition-colors
              disabled:opacity-40 disabled:cursor-not-allowed
              border-white/[0.10] text-slate-400 hover:border-white/[0.20] hover:text-slate-200"
          >
            {cancelLabel}
          </button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add components/app/execution-live-strip.tsx
git commit -m "feat: add ExecutionLiveStrip component"
```

---

## Task 14: ExecutionIterationCard Component

**Files:**
- Create: `components/app/execution-iteration-card.tsx`

- [ ] **Step 1: Write the component**

```tsx
// components/app/execution-iteration-card.tsx
'use client'
import { useState } from 'react'

interface IterationEvent {
  event_type: string
  phase?: string
  payload?: Record<string, unknown>
  created_at: string
}

interface Props {
  iteration: number
  events: IterationEvent[]
  defaultExpanded?: boolean
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

function deriveIterationStatus(events: IterationEvent[]): {
  label: string
  color: string
  icon: string
  durationMs: number
} {
  const stuck = events.find(e => e.event_type === 'iteration.stuck')
  const completed = events.find(e => e.event_type === 'iteration.completed')

  if (stuck) return { label: 'Stuck', color: 'text-red-400 bg-red-400/10', icon: 'block', durationMs: 0 }

  const allPassed =
    events.some(e => e.event_type === 'phase.static_validation.passed') &&
    events.some(e => e.event_type === 'phase.unit.passed')

  const label = allPassed ? 'Passed' : 'Failed'
  const color = allPassed ? 'text-green-400 bg-green-400/10' : 'text-red-400 bg-red-400/10'
  const icon = allPassed ? 'check' : 'close'
  const durationMs = (completed?.payload?.durationMs as number | undefined) ?? 0

  return { label, color, icon, durationMs }
}

export function ExecutionIterationCard({ iteration, events, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const { label, color, icon, durationMs } = deriveIterationStatus(events)

  // Extract data from events
  const svFailed = events.find(e => e.event_type === 'phase.static_validation.failed')
  const svPassed = events.find(e => e.event_type === 'phase.static_validation.passed')
  const unitFailed = events.find(e => e.event_type === 'phase.unit.failed')
  const unitPassed = events.find(e => e.event_type === 'phase.unit.passed')
  const inlineRepairs = events.filter(e => e.event_type === 'repair.inline.succeeded' || e.event_type === 'repair.inline.failed')
  const repairPhases = events.filter(e => e.event_type === 'repair.phase.succeeded' || e.event_type === 'repair.phase.failed')
  const skippedPhases = events.filter(e => e.event_type === 'phase.skipped')
  const commitEvent = events.find(e => ['commit.green', 'commit.wip', 'commit.skipped', 'commit.failed'].includes(e.event_type))
  const startedEvent = events.find(e => e.event_type === 'iteration.started')

  const diagnostics = (svFailed?.payload?.diagnostics as any[] | undefined) ?? []
  const diagTotalCount = (svFailed?.payload?.totalCount as number | undefined) ?? diagnostics.length
  const diagTruncated = (svFailed?.payload?.truncated as boolean | undefined) ?? false

  const testDiags = (unitFailed?.payload?.diagnostics as any[] | undefined) ?? []
  const testTotal = (unitFailed?.payload?.totalCount as number | undefined) ?? testDiags.length

  async function copyDiagnostics() {
    const allDiags = { staticValidation: diagnostics, tests: testDiags }
    await navigator.clipboard.writeText(JSON.stringify(allDiags, null, 2))
  }

  return (
    <div className="rounded-xl bg-[#131b2e] border border-white/5 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-5 py-3.5 flex items-center justify-between gap-4 hover:bg-white/[0.02] transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-slate-600" style={{ fontSize: '14px' }}>
            {expanded ? 'expand_less' : 'expand_more'}
          </span>
          <span className="text-sm font-semibold text-slate-300">Iteration {iteration}</span>
          <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono flex items-center gap-1 ${color}`}>
            <span className="material-symbols-outlined" style={{ fontSize: '10px' }}>{icon}</span>
            {label}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[11px] font-mono text-slate-500">
          {startedEvent && (
            <span title={new Date(startedEvent.created_at).toLocaleString()}>
              {formatTime(startedEvent.created_at)}
            </span>
          )}
          {durationMs > 0 && <span>{formatElapsed(durationMs)}</span>}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-white/5 divide-y divide-white/5">
          {/* Static validation */}
          <div className="px-5 py-3">
            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-2">Static Validation</p>
            {svPassed && <p className="text-xs text-green-400 flex items-center gap-1"><span className="material-symbols-outlined" style={{ fontSize: '12px' }}>check</span> Passed</p>}
            {svFailed && (
              <div>
                <p className="text-xs text-red-400 mb-1">{diagTotalCount} error{diagTotalCount !== 1 ? 's' : ''}{diagTruncated ? ` (showing first ${diagnostics.length})` : ''}</p>
                <div className="space-y-0.5">
                  {diagnostics.slice(0, 5).map((d: any, i: number) => (
                    <p key={i} className="text-[10px] font-mono text-slate-500">
                      <span className="text-slate-400">{d.file}:{d.line}</span> {d.message.slice(0, 80)}
                    </p>
                  ))}
                </div>
              </div>
            )}
            {!svPassed && !svFailed && <p className="text-[11px] text-slate-600">—</p>}
          </div>

          {/* Repairs */}
          {(inlineRepairs.length > 0 || repairPhases.length > 0) && (
            <div className="px-5 py-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-2">Repairs</p>
              {inlineRepairs.map((e, i) => {
                const attempt = (e.payload as any)?.attempt
                return (
                  <p key={i} className="text-[10px] font-mono text-slate-400">
                    Inline · {attempt?.confidenceLabel ?? '?'} ({attempt?.confidenceScore?.toFixed(2) ?? '?'}) · {attempt?.rationale ?? ''}
                  </p>
                )
              })}
              {repairPhases.map((e, i) => {
                const attempt = (e.payload as any)?.attempt
                return (
                  <p key={i} className="text-[10px] font-mono text-slate-400 mt-0.5">
                    Repair phase · {attempt?.confidenceLabel ?? '?'} ({attempt?.confidenceScore?.toFixed(2) ?? '?'}) · {attempt?.rationale ?? ''}
                  </p>
                )
              })}
            </div>
          )}

          {/* Tests */}
          <div className="px-5 py-3">
            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-2">Tests</p>
            {unitPassed && <p className="text-xs text-green-400 flex items-center gap-1"><span className="material-symbols-outlined" style={{ fontSize: '12px' }}>check</span> Unit passed</p>}
            {unitFailed && <p className="text-xs text-red-400">{testTotal} test failure{testTotal !== 1 ? 's' : ''}</p>}
            {skippedPhases.map((e, i) => (
              <p key={i} className="text-[10px] text-slate-600 font-mono">
                {(e.payload as any)?.phase} — skipped ({(e.payload as any)?.reason})
              </p>
            ))}
            {!unitPassed && !unitFailed && skippedPhases.length === 0 && <p className="text-[11px] text-slate-600">—</p>}
          </div>

          {/* Commit */}
          {commitEvent && (
            <div className="px-5 py-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-2">Commit</p>
              {commitEvent.event_type === 'commit.green' && <p className="text-xs text-green-400">Green commit</p>}
              {commitEvent.event_type === 'commit.wip' && (
                <p className="text-xs text-yellow-400">WIP — {(commitEvent.payload as any)?.reason}</p>
              )}
              {commitEvent.event_type === 'commit.skipped' && (
                <p className="text-xs text-slate-500">Skipped — {(commitEvent.payload as any)?.reason}</p>
              )}
              {commitEvent.event_type === 'commit.failed' && (
                <p className="text-xs text-red-400">Failed — {(commitEvent.payload as any)?.reason}</p>
              )}
            </div>
          )}

          {/* Actions */}
          {(diagnostics.length > 0 || testDiags.length > 0) && (
            <div className="px-5 py-3 flex items-center gap-3">
              <button
                onClick={copyDiagnostics}
                className="text-[10px] font-mono text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>content_copy</span>
                Copy diagnostics
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add components/app/execution-iteration-card.tsx
git commit -m "feat: add ExecutionIterationCard with diagnostics, repairs, and timestamps"
```

---

## Task 15: Rebuild execution-view.tsx

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/execution/execution-view.tsx`

This is a full rewrite of the execution view. The existing file polls `/api/change-requests/${change.id}/execute` (GET). The new view polls `/api/change-requests/${change.id}/execute/events` instead and renders the live strip + iteration cards.

- [ ] **Step 1: Read the current execution-view.tsx**

```bash
# Read the file to understand the full current structure before modifying
```

Use the Read tool on `app/projects/[id]/changes/[changeId]/execution/execution-view.tsx`.

- [ ] **Step 2: Write the new execution-view.tsx**

Replace the entire file content with:

```tsx
'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'
import { ChangeStepBar } from '@/components/app/change-step-bar'
import { ExecutionLiveStrip } from '@/components/app/execution-live-strip'
import { ExecutionIterationCard } from '@/components/app/execution-iteration-card'

interface LiveEvent {
  id: string
  seq: number
  iteration: number
  event_type: string
  phase?: string
  payload?: Record<string, unknown>
  created_at: string
}

interface RunData {
  id: string
  status: string
  summary?: Record<string, unknown>
  startedAt: string
  endedAt?: string
  cancellationRequested: boolean
}

interface Change {
  id: string
  title: string
  status: string
  risk_level: string | null
}

interface Project { id: string; name: string }

const ACTIVE_STATUSES = ['executing']

export default function ExecutionView({ change, project }: { change: Change; project: Project | null }) {
  const router = useRouter()
  const [changeStatus, setChangeStatus] = useState(change.status)
  const [run, setRun] = useState<RunData | null>(null)
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [cancelState, setCancelState] = useState<'idle' | 'requesting' | 'cancelled' | 'committing' | 'force_failed'>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const poll = useCallback(async () => {
    const res = await fetch(`/api/change-requests/${change.id}/execute/events`)
    if (!res.ok) return
    const data = await res.json()
    setChangeStatus(data.changeStatus ?? change.status)
    setRun(data.run ?? null)
    setEvents(data.events ?? [])
  }, [change.id, change.status])

  // Polling with visibility-aware interval
  useEffect(() => {
    poll()
    if (!run || run.status !== 'running') return

    let interval = 2000
    const timer = setInterval(() => {
      if (document.hidden) return
      poll()
    }, interval)

    const onVisibility = () => {
      if (!document.hidden) poll()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [poll, run?.status])

  // Redirect to review when complete
  useEffect(() => {
    if (changeStatus === 'review') {
      router.push(`/projects/${project?.id}/changes/${change.id}/review`)
    }
  }, [changeStatus, router, project?.id, change.id])

  // Elapsed timer
  useEffect(() => {
    if (elapsedRef.current) clearInterval(elapsedRef.current)
    if (run?.status === 'running' && run.startedAt) {
      const start = new Date(run.startedAt).getTime()
      elapsedRef.current = setInterval(() => setElapsedMs(Date.now() - start), 1000)
    } else {
      setElapsedMs(0)
    }
    return () => { if (elapsedRef.current) clearInterval(elapsedRef.current) }
  }, [run?.status, run?.startedAt])

  async function handleStart() {
    setStarting(true)
    setStartError(null)
    const res = await fetch(`/api/change-requests/${change.id}/execute`, { method: 'POST' })
    if (res.ok) {
      await poll()
    } else {
      const data = await res.json().catch(() => ({}))
      setStartError(data.error ?? 'Failed to start execution')
    }
    setStarting(false)
  }

  async function handleCancel() {
    setCancelState('requesting')
    const res = await fetch(`/api/change-requests/${change.id}/cancel`, { method: 'POST' })
    if (res.ok) {
      setCancelState('cancelled')
    } else {
      const data = await res.json().catch(() => ({}))
      if (data.error?.includes('committing')) setCancelState('committing')
      else setCancelState('force_failed')
    }
  }

  // Group events by iteration
  const iterationMap = new Map<number, LiveEvent[]>()
  for (const e of events) {
    const arr = iterationMap.get(e.iteration) ?? []
    arr.push(e)
    iterationMap.set(e.iteration, arr)
  }
  const iterations = [...iterationMap.entries()]
    .filter(([n]) => n > 0)
    .sort(([a], [b]) => a - b)

  const runActive = run?.status === 'running'
  const runDone = run && run.status !== 'running'

  const summary = run?.summary as any

  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50 font-headline antialiased tracking-tight">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/projects" className="font-black text-indigo-400 tracking-tighter hover:text-indigo-300 transition-colors">
            FactoryOS
          </Link>
          <span className="text-slate-600">/</span>
          <Link href={`/projects/${project?.id}`} className="text-slate-400 hover:text-slate-200 transition-colors font-medium truncate max-w-[160px]">
            {project?.name}
          </Link>
          <span className="text-slate-600">/</span>
          <Link href={`/projects/${project?.id}/changes/${change.id}`} className="text-slate-400 hover:text-slate-200 transition-colors font-medium truncate max-w-[200px]">
            {change.title}
          </Link>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200 font-medium">Execution</span>
        </div>
        <div className="flex items-center gap-1">
          <Link href="/settings" className="p-2 text-slate-400 hover:text-slate-200 hover:bg-[#171f33] rounded-lg transition-all" title="Settings">
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>settings</span>
          </Link>
          <div className="w-px h-5 bg-white/10 mx-1" />
          <ProfileAvatar />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <LeftNav />
        <main className="flex-1 overflow-y-auto p-10">
          <div className="max-w-2xl mx-auto space-y-4">
            <ChangeStepBar projectId={project?.id ?? ''} changeId={change.id} current="execution" changeStatus={changeStatus} />

            {/* Title */}
            <div className="space-y-1">
              <h1 className="text-2xl font-extrabold tracking-tight text-on-surface leading-snug">{change.title}</h1>
              <p className="text-xs text-slate-500 font-mono">
                {run ? `Run ${run.id.slice(0, 8)} · ${run.status}` : 'No run yet'}
              </p>
            </div>

            {/* Live strip (running) */}
            {runActive && (
              <ExecutionLiveStrip
                events={events}
                runActive={true}
                elapsedMs={elapsedMs}
                cancelState={cancelState}
                onCancel={handleCancel}
              />
            )}

            {/* Final state banner (done) */}
            {runDone && summary && (
              <div className={`rounded-xl border px-5 py-4 flex items-center gap-3 ${
                summary.status === 'success' ? 'bg-green-500/10 border-green-500/20' :
                summary.status === 'wip'     ? 'bg-yellow-500/10 border-yellow-500/20' :
                'bg-red-500/10 border-red-500/20'
              }`}>
                <span className={`material-symbols-outlined ${
                  summary.status === 'success' ? 'text-green-400' :
                  summary.status === 'wip'     ? 'text-yellow-400' :
                  'text-red-400'
                }`} style={{ fontSize: '20px' }}>
                  {summary.status === 'success' ? 'check_circle' : summary.status === 'wip' ? 'warning' : 'cancel'}
                </span>
                <div>
                  <p className="text-sm font-semibold text-slate-200">
                    {summary.status === 'success' && `Done in ${summary.iterationsUsed} iteration${summary.iterationsUsed !== 1 ? 's' : ''}`}
                    {summary.status === 'wip' && `WIP commit — ${summary.finalFailureType ?? 'checks incomplete'}`}
                    {summary.status === 'budget_exceeded' && `Budget exceeded — ${summary.iterationsUsed} iterations used`}
                    {summary.status === 'blocked' && `Blocked — ${summary.finalFailureType ?? 'stuck detector fired'}`}
                    {summary.status === 'cancelled' && `Cancelled after ${summary.iterationsUsed} iteration${summary.iterationsUsed !== 1 ? 's' : ''}`}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5 font-mono">
                    {summary.filesChanged?.length ?? 0} files · {summary.repairsAttempted ?? 0} repairs · {Math.round((summary.durationMs ?? 0) / 1000)}s
                  </p>
                </div>
              </div>
            )}

            {/* Error panel */}
            {runDone && summary && ['blocked', 'budget_exceeded'].includes(summary.status) && (
              <div className="rounded-xl bg-[#131b2e] border border-red-500/20 overflow-hidden">
                <div className="px-5 py-4 border-b border-white/5">
                  <p className="text-xs font-bold uppercase tracking-widest text-red-400 font-headline">What happened</p>
                </div>
                <div className="px-5 py-4 space-y-2">
                  <p className="text-sm text-slate-300">{summary.finalFailureType ?? 'The execution could not complete.'}</p>
                  <p className="text-xs text-slate-500">
                    {summary.status === 'blocked'
                      ? 'Review the iteration history below to find the repeated failure pattern.'
                      : `All ${summary.iterationsUsed} iterations were used without passing all checks.`}
                  </p>
                  {summary.filesChanged?.length > 0 && (
                    <p className="text-xs font-mono text-slate-500">Files touched: {(summary.filesChanged as string[]).join(', ')}</p>
                  )}
                  <button
                    onClick={async () => {
                      await navigator.clipboard.writeText(JSON.stringify(events, null, 2))
                    }}
                    className="mt-2 text-[10px] font-mono text-slate-500 hover:text-slate-300 flex items-center gap-1"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>download</span>
                    Download run log
                  </button>
                </div>
              </div>
            )}

            {/* Iteration cards */}
            {iterations.length > 0 && (
              <div className="space-y-3">
                {iterations.map(([n, evs], i) => (
                  <ExecutionIterationCard
                    key={n}
                    iteration={n}
                    events={evs}
                    defaultExpanded={i === iterations.length - 1}
                  />
                ))}
              </div>
            )}

            {/* Empty state */}
            {!run && !starting && (
              <div className="rounded-xl bg-[#131b2e] border border-white/5 px-8 py-12 text-center space-y-4">
                <span className="material-symbols-outlined text-slate-600 block" style={{ fontSize: '40px' }}>play_circle</span>
                <div>
                  <p className="text-sm font-semibold text-slate-300">No executions yet</p>
                  <p className="text-xs text-slate-500 mt-1">Run this change to see live progress, iteration history, and repair evidence.</p>
                </div>
                <button
                  onClick={handleStart}
                  className="px-5 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white text-sm font-bold font-headline transition-colors"
                >
                  Run execution
                </button>
              </div>
            )}

            {/* Start button when run is done */}
            {runDone && (
              <div className="flex items-center justify-between rounded-xl bg-[#131b2e] border border-white/5 px-5 py-4">
                <p className="text-sm text-slate-400">Run again from the beginning</p>
                <button
                  onClick={handleStart}
                  disabled={starting}
                  className="px-4 py-2 rounded-lg bg-[#0f1929] border border-white/10 hover:border-white/20 text-slate-300 text-sm font-semibold font-headline transition-colors disabled:opacity-50"
                >
                  {starting ? 'Starting…' : 'Re-run'}
                </button>
              </div>
            )}

            {startError && (
              <p className="text-xs text-red-400 font-mono">{startError}</p>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Build to check for errors**

```bash
npm run build 2>&1 | grep -E "error TS|Error:" | head -20
```

Fix any import or type errors before continuing.

- [ ] **Step 4: Commit**

```bash
git add app/projects/[id]/changes/[changeId]/execution/execution-view.tsx
git commit -m "feat: rebuild execution view with live strip, iteration cards, and events polling"
```

---

## Task 16: Wire ExecutionView to Events — Server Component Update

The execution page server component needs to check if there's an existing run to decide whether to show empty state or a live view. Verify `execution/page.tsx` passes the right props.

**Files:**
- Read: `app/projects/[id]/changes/[changeId]/execution/page.tsx`

- [ ] **Step 1: Read the page file**

Use the Read tool on `app/projects/[id]/changes/[changeId]/execution/page.tsx`.

- [ ] **Step 2: Ensure page passes change.status correctly**

The `ExecutionView` now receives `change` with `status`. Confirm the page passes `change` correctly. If the page fetches `status` from DB, verify it includes the `status` field in the select.

- [ ] **Step 3: Full build check**

```bash
npm run build 2>&1 | grep -E "error TS|Error:|Failed" | head -30
```

Fix any remaining type errors. Common issues:
- `ExecutionIterationCard` and `ExecutionLiveStrip` not exported — verify named exports
- `run.status` type — cast to `string` where needed

- [ ] **Step 4: Run all tests**

```bash
npm run test
```

Expected: all existing tests pass, new tests pass.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete execution system redesign — events, repair loop, live UI"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task(s) |
|---|---|
| Failure router (tsc→inline, tests→repair phase) | Task 8, 9, 10 |
| ExecutionBudget with global + perIteration scope | Task 2, 10 |
| staticValidationPhase observe vs generate | Task 10 (codegen tracked separately via repair-guard) |
| testPhases fail_fast / collect_all | Task 10 (fail_fast implemented; collect_all flag wired but defaults to fail_fast) |
| Stuck detector (5 conditions) | Task 4 |
| Repair confidence: score + label + rationale | Task 2, 8, 9 |
| Commit policy: green / wip / no_commit / blocked | Task 6, 10 |
| WIP commit message format | Task 10 |
| execution_runs table | Task 1 |
| execution_events table with seq + unique constraint | Task 1 |
| Zod-equivalent payload validation | Task 3 |
| Concurrency guard (single active run) | Task 7, 11 |
| Cancellation: cooperative at phase boundary | Task 7, 10 |
| Heartbeat + stale run reaper | Task 7, 12 |
| Security: allowlist + blocklist for repair | Task 5 |
| Max files per repair enforced | Task 8, 9 |
| Cancel API endpoint | Task 11 |
| Events polling endpoint | Task 11 |
| Live strip: dynamic labels, detail subtext, cancel states | Task 13 |
| Iteration cards: diagnostics, repairs, timestamps, copy | Task 14 |
| Final state banner | Task 15 |
| Error panel in-flow | Task 15 |
| Empty state | Task 15 |
| Polling: 2s active, stop on complete, visibility API | Task 15 |
| Event retention policy | NOT in scope for code — DB cron setup is manual |
| Metrics | NOT in scope for code — queryable from tables |
| schema_version field on events | Task 1, 3 |

### Placeholder check

No TBDs or TODOs in the plan.

### Type consistency

- `RepairAttempt` defined in Task 2, used in Task 8, 9, 10 — same shape
- `ExecutionBudget.perIteration` used in stuck detector test and Task 10 — same field names
- `CommitOutcome` defined in Task 2, used in Task 6 and 10 — consistent
- `IterationRecord` defined in Task 2, consumed in Task 4 — `diagnosticSigs`, `errorCount`, `repairedFiles` match
- `DiagnosticSet` defined in Task 2, built in Task 10 inline — `diagnostics`, `totalCount`, `truncated` match

---

Plan complete and saved to `docs/superpowers/plans/2026-04-12-execution-system-redesign.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks

**2. Inline Execution** — execute tasks in this session using executing-plans

Which approach?
