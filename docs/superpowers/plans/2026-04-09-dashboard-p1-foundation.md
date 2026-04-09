# Dashboard Redesign — Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the DB schema, event bus, SSE/polling transport, and orchestrator integration that every dashboard section depends on.

**Architecture:** New `lib/dashboard/` module owns the event bus, event counter, snapshot writer, and watchdog. The SSE endpoint at `/api/projects/[id]/dashboard-stream` and polling endpoint at `/api/projects/[id]/dashboard-poll` both serve from DB + in-memory EventEmitter. The execution orchestrator is modified to emit `DashboardEvent`s and write stubs before marking changes as completed.

**Tech Stack:** Next.js App Router, Supabase (adminClient for writes), Node.js EventEmitter, TypeScript, Vitest

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `supabase/migrations/017_dashboard_signals.sql` | Create | All new tables + change_requests columns + increment function |
| `lib/supabase/types.ts` | Modify | Add AnalysisStatus, AnalysisResultSnapshot types |
| `lib/dashboard/event-types.ts` | Create | DashboardEvent type, all event type literals |
| `lib/dashboard/event-bus.ts` | Create | In-memory EventEmitter singleton, emit + subscribe |
| `lib/dashboard/event-counter.ts` | Create | DB-backed monotonic version counter per project |
| `lib/dashboard/event-history.ts` | Create | Write to event_history ring buffer, enforce 500-event cap |
| `lib/dashboard/snapshot-writer.ts` | Create | Stub-first snapshot write, enrichment function |
| `lib/dashboard/watchdog.ts` | Create | isStalled pure function |
| `app/api/projects/[id]/dashboard-stream/route.ts` | Create | SSE endpoint — one connection per project |
| `app/api/projects/[id]/dashboard-poll/route.ts` | Create | Polling endpoint — returns current state for all active changes |
| `lib/execution/execution-orchestrator.ts` | Modify | Emit DashboardEvents, stub-first snapshot, stage tracking |
| `tests/lib/dashboard/event-bus.test.ts` | Create | Emit + subscribe + unsubscribe |
| `tests/lib/dashboard/event-counter.test.ts` | Create | Monotonic increment, concurrency |
| `tests/lib/dashboard/snapshot-writer.test.ts` | Create | Stub write, enrichment, failure separation |
| `tests/lib/dashboard/watchdog.test.ts` | Create | Stall detection logic |

---

### Task 1: DB Migration

**Files:**
- Create: `supabase/migrations/017_dashboard_signals.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/017_dashboard_signals.sql

-- ── Project event version counter ──────────────────────────────────────────
create table if not exists project_event_counter (
  project_id uuid primary key references projects(id) on delete cascade,
  version    bigint not null default 0
);

-- Upsert function: atomically increments version, inserts row on first call
create or replace function increment_project_event_version(p_project_id uuid)
returns bigint
language plpgsql
as $$
declare
  v bigint;
begin
  insert into project_event_counter (project_id, version)
  values (p_project_id, 1)
  on conflict (project_id) do update
    set version = project_event_counter.version + 1
  returning version into v;
  return v;
end;
$$;

-- ── SSE event replay buffer ────────────────────────────────────────────────
create table if not exists event_history (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  version    bigint not null,
  event_json jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists event_history_project_version_idx
  on event_history(project_id, version desc);

-- ── Analysis result snapshot ───────────────────────────────────────────────
create table if not exists analysis_result_snapshot (
  id               uuid primary key default gen_random_uuid(),
  change_id        uuid not null references change_requests(id) on delete cascade,
  version          bigint not null,
  execution_outcome text not null check (execution_outcome in ('success', 'failure')),
  snapshot_status  text not null default 'pending_enrichment'
    check (snapshot_status in ('pending_enrichment', 'ok', 'enrichment_failed')),
  minimal          boolean not null default true,
  analysis_status  text not null
    check (analysis_status in ('completed', 'failed', 'stalled')),
  stages_completed text[] not null default '{}',
  files_modified   text[] not null default '{}',
  components_affected text[] not null default '{}',
  jaccard_accuracy numeric,
  miss_rate        numeric,
  model_miss       jsonb,
  failure_cause    jsonb,
  duration_ms      bigint,
  completed_at     timestamptz not null default now(),
  unique (change_id)
);

create index if not exists analysis_result_snapshot_change_idx
  on analysis_result_snapshot(change_id);

alter table analysis_result_snapshot enable row level security;
create policy "project owner access" on analysis_result_snapshot for all using (
  exists (
    select 1 from change_requests cr
    join projects p on p.id = cr.project_id
    where cr.id = analysis_result_snapshot.change_id
      and p.owner_id = auth.uid()
  )
);

-- ── Risk scores (precomputed) ─────────────────────────────────────────────
create table if not exists risk_scores (
  component_id uuid not null references system_components(id) on delete cascade,
  project_id   uuid not null references projects(id) on delete cascade,
  risk_score   numeric not null,
  tier         text not null check (tier in ('HIGH', 'MEDIUM')),
  computed_at  timestamptz not null default now(),
  primary key (component_id)
);

create index if not exists risk_scores_project_idx
  on risk_scores(project_id, risk_score desc);

alter table risk_scores enable row level security;
create policy "project owner access" on risk_scores for all using (
  exists (select 1 from projects p where p.id = risk_scores.project_id and p.owner_id = auth.uid())
);

-- ── Action items (precomputed) ────────────────────────────────────────────
create table if not exists action_items (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects(id) on delete cascade,
  tier           int not null,
  priority_score numeric not null,
  source         text not null,
  payload_json   jsonb not null,
  resolved_at    timestamptz
);

create index if not exists action_items_project_idx
  on action_items(project_id, priority_score desc);

alter table action_items enable row level security;
create policy "project owner access" on action_items for all using (
  exists (select 1 from projects p where p.id = action_items.project_id and p.owner_id = auth.uid())
);

-- ── System signal snapshot (one row per project) ──────────────────────────
create table if not exists system_signal_snapshot (
  project_id   uuid primary key references projects(id) on delete cascade,
  payload_json jsonb not null,
  computed_at  timestamptz not null default now()
);

alter table system_signal_snapshot enable row level security;
create policy "project owner access" on system_signal_snapshot for all using (
  exists (select 1 from projects p where p.id = system_signal_snapshot.project_id and p.owner_id = auth.uid())
);

-- ── Extend change_requests ────────────────────────────────────────────────
alter table change_requests
  add column if not exists analysis_status text default 'pending'
    check (analysis_status in ('pending', 'running', 'completed', 'failed', 'stalled')),
  add column if not exists analysis_version int not null default 0,
  add column if not exists client_request_id uuid,
  add column if not exists snapshot_status text,
  add column if not exists last_stage_started_at timestamptz,
  add column if not exists expected_stage_duration_ms bigint;
```

- [ ] **Step 2: Apply the migration**

```bash
npx supabase db push
```

Expected: migration applied without errors. Verify in Supabase Studio that all 5 new tables exist.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/017_dashboard_signals.sql
git commit -m "feat: add dashboard signals schema (event counter, SSE history, snapshots, risk scores)"
```

---

### Task 2: Event Types

**Files:**
- Create: `lib/dashboard/event-types.ts`
- Modify: `lib/supabase/types.ts`

- [ ] **Step 1: Write the event types module**

```ts
// lib/dashboard/event-types.ts

export type DashboardEventType =
  | 'queued'
  | 'started'
  | 'progress'
  | 'completed'
  | 'stalled'
  | 'resync_required'

export type DashboardEventScope = 'analysis' | 'execution' | 'system'

export interface DashboardEvent {
  type: DashboardEventType
  scope: DashboardEventScope
  changeId: string
  projectId: string
  /** Per-run counter from change_requests — discard events where this !== currentRunVersion */
  analysisVersion: number
  /** Project-level monotonic counter — used for dedup and replay ordering */
  version: number
  /** Present only on reconstructed lifecycle events — absent on real events */
  synthetic?: true
  payload: Record<string, unknown>
}

export interface ProgressPayload {
  stage: string
  pct: number
}

export interface CompletedPayload {
  outcome: 'success' | 'failure'
  /** Full snapshot included as optimization — client should not rely on this across sessions */
  snapshot?: AnalysisResultSnapshotData
}

export interface AnalysisResultSnapshotData {
  changeId: string
  version: number
  executionOutcome: 'success' | 'failure'
  snapshotStatus: 'pending_enrichment' | 'ok' | 'enrichment_failed'
  minimal: boolean
  analysisStatus: 'completed' | 'failed' | 'stalled'
  stagesCompleted: string[]
  filesModified: string[]
  componentsAffected: string[]
  jaccard_accuracy: number | null
  miss_rate: number | null
  modelMiss: {
    missed: Array<{ component_id: string; name: string }>
    overestimated: Array<{ component_id: string; name: string }>
    confidence_gap: { predicted: number; actual_severity: 'HIGH' | 'MEDIUM' | 'LOW' } | null
  } | null
  failureCause: {
    error_type: string
    component_id: string | null
    parse_confidence: number
    cascade: string[]
  } | null
  duration_ms: number | null
  completed_at: string
}
```

- [ ] **Step 2: Add AnalysisStatus type to `lib/supabase/types.ts`**

Find the block of `export type` declarations near the top of `lib/supabase/types.ts` and add:

```ts
export type AnalysisStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stalled'
```

- [ ] **Step 3: Write the failing test**

```ts
// tests/lib/dashboard/event-types.test.ts
import { describe, it, expect } from 'vitest'
import type { DashboardEvent } from '@/lib/dashboard/event-types'

describe('DashboardEvent', () => {
  it('accepts a minimal queued event', () => {
    const event: DashboardEvent = {
      type: 'queued',
      scope: 'analysis',
      changeId: 'c1',
      projectId: 'p1',
      analysisVersion: 1,
      version: 1,
      payload: {},
    }
    expect(event.type).toBe('queued')
  })

  it('accepts synthetic flag', () => {
    const event: DashboardEvent = {
      type: 'progress',
      scope: 'analysis',
      changeId: 'c1',
      projectId: 'p1',
      analysisVersion: 1,
      version: 2,
      synthetic: true,
      payload: { stage: 'context_load', pct: 10 },
    }
    expect(event.synthetic).toBe(true)
  })
})
```

- [ ] **Step 4: Run test**

```bash
npx vitest run tests/lib/dashboard/event-types.test.ts
```

Expected: PASS (type-only, no runtime logic to fail)

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard/event-types.ts lib/supabase/types.ts tests/lib/dashboard/event-types.test.ts
git commit -m "feat: DashboardEvent types + AnalysisStatus"
```

---

### Task 3: Event Bus

**Files:**
- Create: `lib/dashboard/event-bus.ts`
- Create: `tests/lib/dashboard/event-bus.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/dashboard/event-bus.test.ts
import { describe, it, expect, vi } from 'vitest'

describe('event bus', () => {
  it('delivers events to subscribers for the right project', async () => {
    // dynamic import so the singleton is fresh per test run
    const { emitDashboardEvent, subscribeToDashboard } = await import('@/lib/dashboard/event-bus')

    const received: unknown[] = []
    const unsub = subscribeToDashboard('proj-1', (e) => received.push(e))

    emitDashboardEvent('proj-1', {
      type: 'queued', scope: 'analysis', changeId: 'c1', projectId: 'proj-1',
      analysisVersion: 1, version: 1, payload: {},
    })

    unsub()
    expect(received).toHaveLength(1)
  })

  it('does not deliver events for other projects', async () => {
    const { emitDashboardEvent, subscribeToDashboard } = await import('@/lib/dashboard/event-bus')

    const received: unknown[] = []
    const unsub = subscribeToDashboard('proj-A', (e) => received.push(e))

    emitDashboardEvent('proj-B', {
      type: 'queued', scope: 'analysis', changeId: 'c1', projectId: 'proj-B',
      analysisVersion: 1, version: 1, payload: {},
    })

    unsub()
    expect(received).toHaveLength(0)
  })

  it('unsubscribe stops delivery', async () => {
    const { emitDashboardEvent, subscribeToDashboard } = await import('@/lib/dashboard/event-bus')

    const received: unknown[] = []
    const unsub = subscribeToDashboard('proj-2', (e) => received.push(e))
    unsub()

    emitDashboardEvent('proj-2', {
      type: 'queued', scope: 'analysis', changeId: 'c1', projectId: 'proj-2',
      analysisVersion: 1, version: 1, payload: {},
    })

    expect(received).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/dashboard/event-bus.test.ts
```

Expected: FAIL with "Cannot find module '@/lib/dashboard/event-bus'"

- [ ] **Step 3: Implement event bus**

```ts
// lib/dashboard/event-bus.ts
import { EventEmitter } from 'node:events'
import type { DashboardEvent } from './event-types'

// One singleton per server process. Acceptable for single-process deployment.
// Multi-process scaling requires replacing this with Redis pub/sub.
const emitter = new EventEmitter()
emitter.setMaxListeners(200)

function projectKey(projectId: string): string {
  return `project:${projectId}`
}

export function emitDashboardEvent(projectId: string, event: DashboardEvent): void {
  emitter.emit(projectKey(projectId), event)
}

export function subscribeToDashboard(
  projectId: string,
  handler: (e: DashboardEvent) => void
): () => void {
  const key = projectKey(projectId)
  emitter.on(key, handler)
  return () => emitter.off(key, handler)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/lib/dashboard/event-bus.test.ts
```

Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard/event-bus.ts tests/lib/dashboard/event-bus.test.ts
git commit -m "feat: in-memory dashboard event bus with project-scoped delivery"
```

---

### Task 4: Event Counter + Event History

**Files:**
- Create: `lib/dashboard/event-counter.ts`
- Create: `lib/dashboard/event-history.ts`
- Create: `tests/lib/dashboard/event-counter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/dashboard/event-counter.test.ts
import { describe, it, expect, vi } from 'vitest'
import { nextVersion } from '@/lib/dashboard/event-counter'

const mockRpc = vi.fn()
const mockDb = { rpc: mockRpc } as unknown as import('@supabase/supabase-js').SupabaseClient

describe('nextVersion', () => {
  it('calls increment_project_event_version and returns the version', async () => {
    mockRpc.mockResolvedValueOnce({ data: 42, error: null })
    const v = await nextVersion(mockDb, 'proj-1')
    expect(v).toBe(42)
    expect(mockRpc).toHaveBeenCalledWith('increment_project_event_version', { p_project_id: 'proj-1' })
  })

  it('throws if rpc returns an error', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: new Error('db error') })
    await expect(nextVersion(mockDb, 'proj-1')).rejects.toThrow('db error')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/dashboard/event-counter.test.ts
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement event counter**

```ts
// lib/dashboard/event-counter.ts
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Atomically increments the project's event version counter in the DB.
 * Returns the new version number. Uses a DB function to ensure atomicity
 * under concurrent writes.
 */
export async function nextVersion(db: SupabaseClient, projectId: string): Promise<number> {
  const { data, error } = await db.rpc('increment_project_event_version', {
    p_project_id: projectId,
  })
  if (error) throw error
  return data as number
}
```

- [ ] **Step 4: Implement event history writer**

```ts
// lib/dashboard/event-history.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DashboardEvent } from './event-types'

const MAX_HISTORY_PER_PROJECT = 500

/**
 * Appends an event to the project's event_history ring buffer.
 * Prunes oldest events when the count exceeds MAX_HISTORY_PER_PROJECT.
 * Fire-and-forget — callers should not await if they don't need confirmation.
 */
export async function recordEvent(
  db: SupabaseClient,
  projectId: string,
  event: DashboardEvent
): Promise<void> {
  await db.from('event_history').insert({
    project_id: projectId,
    version: event.version,
    event_json: event,
  })

  // Prune: keep only the most recent MAX_HISTORY_PER_PROJECT events
  const { data: oldest } = await db
    .from('event_history')
    .select('id')
    .eq('project_id', projectId)
    .order('version', { ascending: false })
    .range(MAX_HISTORY_PER_PROJECT, MAX_HISTORY_PER_PROJECT)
    .maybeSingle()

  if (oldest) {
    await db
      .from('event_history')
      .delete()
      .eq('project_id', projectId)
      .lt('version', (event.version - MAX_HISTORY_PER_PROJECT + 1))
  }
}

/**
 * Returns events since `sinceVersion` for replay on SSE reconnect.
 * Returns null if sinceVersion is older than the oldest stored event (triggers resync).
 */
export async function getEventsSince(
  db: SupabaseClient,
  projectId: string,
  sinceVersion: number
): Promise<DashboardEvent[] | null> {
  // Check oldest stored event
  const { data: oldest } = await db
    .from('event_history')
    .select('version')
    .eq('project_id', projectId)
    .order('version', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (oldest && sinceVersion < oldest.version) {
    return null // client is behind buffer — trigger resync
  }

  const { data } = await db
    .from('event_history')
    .select('event_json')
    .eq('project_id', projectId)
    .gt('version', sinceVersion)
    .order('version', { ascending: true })

  return (data ?? []).map((row) => row.event_json as DashboardEvent)
}
```

- [ ] **Step 5: Run event counter test**

```bash
npx vitest run tests/lib/dashboard/event-counter.test.ts
```

Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add lib/dashboard/event-counter.ts lib/dashboard/event-history.ts tests/lib/dashboard/event-counter.test.ts
git commit -m "feat: DB-backed event version counter and event_history ring buffer"
```

---

### Task 5: Snapshot Writer (Stub-First)

**Files:**
- Create: `lib/dashboard/snapshot-writer.ts`
- Create: `tests/lib/dashboard/snapshot-writer.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/dashboard/snapshot-writer.test.ts
import { describe, it, expect, vi } from 'vitest'
import { writeStub, enrichSnapshot } from '@/lib/dashboard/snapshot-writer'
import type { AnalysisResultSnapshotData } from '@/lib/dashboard/event-types'

const mockInsert = vi.fn().mockReturnValue({ error: null })
const mockUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ error: null }) })
const mockFrom = vi.fn((table: string) => ({
  insert: mockInsert,
  update: mockUpdate,
}))
const mockDb = { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient

describe('writeStub', () => {
  it('inserts a minimal stub row', async () => {
    mockInsert.mockReturnValueOnce({ error: null })
    await writeStub(mockDb, 'c1', 7, 'success', 'completed')
    expect(mockFrom).toHaveBeenCalledWith('analysis_result_snapshot')
    const inserted = mockInsert.mock.calls[0][0]
    expect(inserted.change_id).toBe('c1')
    expect(inserted.version).toBe(7)
    expect(inserted.execution_outcome).toBe('success')
    expect(inserted.minimal).toBe(true)
    expect(inserted.snapshot_status).toBe('pending_enrichment')
  })

  it('throws if insert fails', async () => {
    mockInsert.mockReturnValueOnce({ error: new Error('db failure') })
    await expect(writeStub(mockDb, 'c1', 7, 'success', 'completed')).rejects.toThrow('db failure')
  })
})

describe('enrichSnapshot', () => {
  it('updates snapshot_status to ok and minimal to false', async () => {
    const eqMock = vi.fn().mockReturnValue({ error: null })
    mockUpdate.mockReturnValueOnce({ eq: eqMock })
    const data: Partial<AnalysisResultSnapshotData> = {
      jaccard_accuracy: 0.82,
      miss_rate: 0.18,
    }
    await enrichSnapshot(mockDb, 'c1', data)
    expect(mockUpdate).toHaveBeenCalled()
    const updated = mockUpdate.mock.calls[0][0]
    expect(updated.snapshot_status).toBe('ok')
    expect(updated.minimal).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/dashboard/snapshot-writer.test.ts
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement snapshot writer**

```ts
// lib/dashboard/snapshot-writer.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AnalysisResultSnapshotData } from './event-types'

/**
 * Step 1 of stub-first completion: write a minimal snapshot row immediately.
 * This is the canonical completion signal. If this fails, do NOT proceed to
 * mark the change as completed — keep it running and retry.
 */
export async function writeStub(
  db: SupabaseClient,
  changeId: string,
  version: number,
  executionOutcome: 'success' | 'failure',
  analysisStatus: 'completed' | 'failed' | 'stalled'
): Promise<void> {
  const { error } = await db.from('analysis_result_snapshot').insert({
    change_id: changeId,
    version,
    execution_outcome: executionOutcome,
    snapshot_status: 'pending_enrichment',
    minimal: true,
    analysis_status: analysisStatus,
    stages_completed: [],
    files_modified: [],
    components_affected: [],
    completed_at: new Date().toISOString(),
  })
  if (error) throw error
}

/**
 * Step 2 (background): write the full analysis fields and mark the snapshot as enriched.
 * If this fails, snapshot_status becomes 'enrichment_failed' — the stub remains and the
 * UI shows a "details loading" banner. execution_outcome is never altered here.
 */
export async function enrichSnapshot(
  db: SupabaseClient,
  changeId: string,
  data: Partial<AnalysisResultSnapshotData>
): Promise<void> {
  const { error } = await db
    .from('analysis_result_snapshot')
    .update({
      snapshot_status: 'ok',
      minimal: false,
      stages_completed: data.stagesCompleted ?? [],
      files_modified: data.filesModified ?? [],
      components_affected: data.componentsAffected ?? [],
      jaccard_accuracy: data.jaccard_accuracy ?? null,
      miss_rate: data.miss_rate ?? null,
      model_miss: data.modelMiss ?? null,
      failure_cause: data.failureCause ?? null,
      duration_ms: data.duration_ms ?? null,
    })
    .eq('change_id', changeId)
  if (error) throw error
}

/**
 * Called when enrichment fails after all retries — marks snapshot so UI can
 * show a banner without blocking the completed state.
 */
export async function markEnrichmentFailed(
  db: SupabaseClient,
  changeId: string
): Promise<void> {
  await db
    .from('analysis_result_snapshot')
    .update({ snapshot_status: 'enrichment_failed' })
    .eq('change_id', changeId)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/lib/dashboard/snapshot-writer.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard/snapshot-writer.ts tests/lib/dashboard/snapshot-writer.test.ts
git commit -m "feat: stub-first snapshot writer with enrichment separation"
```

---

### Task 6: Watchdog

**Files:**
- Create: `lib/dashboard/watchdog.ts`
- Create: `tests/lib/dashboard/watchdog.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/dashboard/watchdog.test.ts
import { describe, it, expect } from 'vitest'
import { isStalled } from '@/lib/dashboard/watchdog'

interface ChangeRow {
  last_stage_started_at: Date | null
  expected_stage_duration_ms: number | null
}

describe('isStalled', () => {
  it('returns false when stage started recently', () => {
    const change: ChangeRow = {
      last_stage_started_at: new Date(Date.now() - 30_000), // 30s ago
      expected_stage_duration_ms: 60_000, // 1 min expected
    }
    // threshold = 2 * 60000 = 120s. Elapsed = 30s. Not stalled.
    expect(isStalled(change)).toBe(false)
  })

  it('returns true when elapsed > 2x expected stage duration', () => {
    const change: ChangeRow = {
      last_stage_started_at: new Date(Date.now() - 300_000), // 5 min ago
      expected_stage_duration_ms: 60_000, // 1 min expected
    }
    // threshold = 120s. Elapsed = 300s. Stalled.
    expect(isStalled(change)).toBe(true)
  })

  it('falls back to 10 min threshold when no expected duration', () => {
    const recentChange: ChangeRow = {
      last_stage_started_at: new Date(Date.now() - 5 * 60_000), // 5 min ago
      expected_stage_duration_ms: null,
    }
    expect(isStalled(recentChange)).toBe(false)

    const oldChange: ChangeRow = {
      last_stage_started_at: new Date(Date.now() - 11 * 60_000), // 11 min ago
      expected_stage_duration_ms: null,
    }
    expect(isStalled(oldChange)).toBe(true)
  })

  it('returns false when last_stage_started_at is null (stage not yet started)', () => {
    const change: ChangeRow = {
      last_stage_started_at: null,
      expected_stage_duration_ms: null,
    }
    expect(isStalled(change)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/dashboard/watchdog.test.ts
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement watchdog**

```ts
// lib/dashboard/watchdog.ts

interface ChangeRow {
  last_stage_started_at: Date | null
  expected_stage_duration_ms: number | null
}

const FALLBACK_THRESHOLD_MS = 10 * 60 * 1000  // 10 minutes

/**
 * Pure function — determines whether a running analysis is stalled.
 * Uses stage-level timing: compares elapsed time since the current stage
 * started against 2× the expected stage duration.
 *
 * Called identically from:
 * - SSE connect (check all running changes for project)
 * - Dashboard page load (server-side)
 * - Background watchdog job (every 5 minutes)
 */
export function isStalled(change: ChangeRow): boolean {
  if (!change.last_stage_started_at) return false

  const threshold = change.expected_stage_duration_ms != null
    ? 2 * change.expected_stage_duration_ms
    : FALLBACK_THRESHOLD_MS

  return Date.now() - change.last_stage_started_at.getTime() > threshold
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/lib/dashboard/watchdog.test.ts
```

Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard/watchdog.ts tests/lib/dashboard/watchdog.test.ts
git commit -m "feat: isStalled pure function with stage-level stall detection"
```

---

### Task 7: SSE Endpoint

**Files:**
- Create: `app/api/projects/[id]/dashboard-stream/route.ts`

- [ ] **Step 1: Create the SSE stream route**

```ts
// app/api/projects/[id]/dashboard-stream/route.ts
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { subscribeToDashboard } from '@/lib/dashboard/event-bus'
import { getEventsSince } from '@/lib/dashboard/event-history'
import { isStalled } from '@/lib/dashboard/watchdog'
import type { DashboardEvent } from '@/lib/dashboard/event-types'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  // Verify project ownership
  const { data: project } = await db
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('owner_id', user.id)
    .single()
  if (!project) return new Response('Not found', { status: 404 })

  const sinceVersion = Number(new URL(req.url).searchParams.get('since') ?? '0')
  const adminDb = createAdminClient()

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: DashboardEvent | { type: 'heartbeat' }) {
        try {
          controller.enqueue(`event: dashboard\ndata: ${JSON.stringify(event)}\n\n`)
        } catch {
          // client disconnected
        }
      }

      // 1. Replay missed events if reconnecting
      if (sinceVersion > 0) {
        const missed = await getEventsSince(adminDb, projectId, sinceVersion)
        if (missed === null) {
          // Client is behind the buffer — send resync
          send({
            type: 'resync_required',
            scope: 'system',
            changeId: '',
            projectId,
            analysisVersion: 0,
            version: 0,
            payload: {},
          } as DashboardEvent)
        } else {
          for (const e of missed) send(e)
        }
      }

      // 2. Reconstruct synthetic lifecycle for any currently-running change
      const { data: runningChanges } = await adminDb
        .from('change_requests')
        .select('id, analysis_version, analysis_status, last_stage_started_at, expected_stage_duration_ms')
        .eq('project_id', projectId)
        .eq('analysis_status', 'running')

      for (const change of runningChanges ?? []) {
        // Check for stall
        if (isStalled({
          last_stage_started_at: change.last_stage_started_at ? new Date(change.last_stage_started_at) : null,
          expected_stage_duration_ms: change.expected_stage_duration_ms,
        })) {
          await adminDb
            .from('change_requests')
            .update({ analysis_status: 'stalled' })
            .eq('id', change.id)
            .eq('analysis_status', 'running')
          send({
            type: 'stalled', scope: 'analysis',
            changeId: change.id, projectId,
            analysisVersion: change.analysis_version, version: 0,
            synthetic: true, payload: {},
          } as DashboardEvent)
        } else {
          // Emit synthetic queued → started sequence
          for (const type of ['queued', 'started'] as const) {
            send({
              type, scope: 'analysis',
              changeId: change.id, projectId,
              analysisVersion: change.analysis_version, version: 0,
              synthetic: true, payload: {},
            } as DashboardEvent)
          }
        }
      }

      // 3. Subscribe to live events
      const unsub = subscribeToDashboard(projectId, send)

      // 4. Heartbeat every 25s
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(': heartbeat\n\n')
        } catch {
          clearInterval(heartbeat)
        }
      }, 25_000)

      // 5. Cleanup on disconnect
      req.signal.addEventListener('abort', () => {
        clearInterval(heartbeat)
        unsub()
        try { controller.close() } catch { /* already closed */ }
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
```

- [ ] **Step 2: Manually verify the endpoint starts**

Start the dev server (`npm run dev`) and open:
`http://localhost:3000/api/projects/<any-project-id>/dashboard-stream`

Expected: SSE stream opens, browser shows `: heartbeat` comments every 25s. No errors in console.

- [ ] **Step 3: Commit**

```bash
git add app/api/projects/[id]/dashboard-stream/route.ts
git commit -m "feat: SSE dashboard stream endpoint with synthetic lifecycle reconstruction"
```

---

### Task 8: Polling Endpoint

**Files:**
- Create: `app/api/projects/[id]/dashboard-poll/route.ts`

- [ ] **Step 1: Create the polling route**

```ts
// app/api/projects/[id]/dashboard-poll/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('owner_id', user.id)
    .single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Return current state for all active changes in the project
  const { data: activeChanges } = await db
    .from('change_requests')
    .select('id, status, analysis_status, analysis_version, updated_at')
    .eq('project_id', projectId)
    .not('analysis_status', 'in', '("completed","failed","stalled")')
    .order('updated_at', { ascending: false })

  // Return latest snapshots for recently-completed changes (last 5)
  const { data: snapshots } = await db
    .from('analysis_result_snapshot')
    .select('change_id, execution_outcome, snapshot_status, minimal, analysis_status, completed_at')
    .in(
      'change_id',
      (activeChanges ?? []).map((c) => c.id)
    )

  return NextResponse.json({
    activeChanges: activeChanges ?? [],
    snapshots: snapshots ?? [],
    polledAt: new Date().toISOString(),
  })
}
```

- [ ] **Step 2: Verify polling returns correct shape**

With dev server running, call the endpoint with a valid project ID.
Expected: JSON with `activeChanges`, `snapshots`, `polledAt` keys.

- [ ] **Step 3: Commit**

```bash
git add app/api/projects/[id]/dashboard-poll/route.ts
git commit -m "feat: dashboard polling endpoint for SSE fallback + reconciliation"
```

---

### Task 9: Orchestrator Integration

Modify the execution orchestrator to: (a) emit DashboardEvents at stage transitions, (b) write stub-first snapshot on completion, (c) update `last_stage_started_at` + `expected_stage_duration_ms` at each stage start.

**Files:**
- Modify: `lib/execution/execution-orchestrator.ts`

- [ ] **Step 1: Read the current orchestrator to find the right insertion points**

```bash
grep -n "writeSnapshot\|db.from\|change_id\|analysis_status\|runExecution" lib/execution/execution-orchestrator.ts | head -40
```

Note the line numbers for: `runExecution` function definition, `writeSnapshot` call sites, and any `status` updates on `change_requests`.

- [ ] **Step 2: Add imports at the top of the orchestrator**

Add after the existing imports in `lib/execution/execution-orchestrator.ts`:

```ts
import { emitDashboardEvent } from '@/lib/dashboard/event-bus'
import { nextVersion } from '@/lib/dashboard/event-counter'
import { recordEvent } from '@/lib/dashboard/event-history'
import { writeStub, enrichSnapshot, markEnrichmentFailed } from '@/lib/dashboard/snapshot-writer'
import type { DashboardEvent } from '@/lib/dashboard/event-types'
```

- [ ] **Step 3: Add a helper to emit + record events atomically**

Add this function near the top of `execution-orchestrator.ts`, after the imports:

```ts
async function emitAndRecord(
  db: SupabaseClient,
  projectId: string,
  changeId: string,
  analysisVersion: number,
  type: DashboardEvent['type'],
  scope: DashboardEvent['scope'],
  payload: Record<string, unknown>
): Promise<void> {
  const version = await nextVersion(db, projectId)
  const event: DashboardEvent = {
    type, scope, changeId, projectId, analysisVersion, version, payload,
  }
  emitDashboardEvent(projectId, event)
  // fire-and-forget — don't let history write failures block execution
  recordEvent(db, projectId, event).catch(err =>
    console.warn('[dashboard] event_history write failed:', err)
  )
}
```

- [ ] **Step 4: Locate `runExecution` and find the `analysis_status = 'running'` transition**

Find the section where `change_requests` is updated to `executing` or `status = 'executing'`. This is likely near the top of `runExecution`. After the existing status update, add:

```ts
// After the existing: await db.from('change_requests').update({ status: 'executing' }).eq('id', changeId)
// Fetch projectId for event emission
const { data: changeRow } = await db
  .from('change_requests')
  .select('project_id, analysis_version')
  .eq('id', changeId)
  .single()
const projectId = changeRow?.project_id ?? ''
const analysisVersion = (changeRow?.analysis_version ?? 0)

// Atomic transition: pending → running
await db
  .from('change_requests')
  .update({
    analysis_status: 'running',
    analysis_version: analysisVersion + 1,
  })
  .eq('id', changeId)
  .eq('analysis_status', 'pending')

const currentAnalysisVersion = analysisVersion + 1

await emitAndRecord(db, projectId, changeId, currentAnalysisVersion, 'started', 'analysis', {})
```

- [ ] **Step 5: Add stage tracking and progress events**

Find where each major stage begins (context load, impact analysis, patch generation, type check, test run). At the start of each stage, add:

```ts
const STAGE_WEIGHTS: Record<string, number> = {
  context_load: 10,
  impact_analysis: 25,
  patch_generation: 35,
  type_check: 15,
  test_run: 15,
}

// At start of each stage (example for 'patch_generation'):
const stageName = 'patch_generation'
const expectedDurationMs = 60_000 // estimate — update based on history later
await db
  .from('change_requests')
  .update({
    last_stage_started_at: new Date().toISOString(),
    expected_stage_duration_ms: expectedDurationMs,
  })
  .eq('id', changeId)

const completedPct = Object.entries(STAGE_WEIGHTS)
  .filter(([s]) => completedStages.includes(s))
  .reduce((sum, [, w]) => sum + w, 0)

await emitAndRecord(db, projectId, changeId, currentAnalysisVersion, 'progress', 'analysis', {
  stage: stageName, pct: completedPct,
})
```

Track `completedStages: string[]` as you go through stages.

- [ ] **Step 6: Replace the completion logic with stub-first pattern**

Find the existing `writeSnapshot` call (at the end of `runExecution`). Replace the section that updates `change_requests` status to `done`/`failed` with:

```ts
const executionOutcome: 'success' | 'failure' = testsPassedOverall ? 'success' : 'failure'
const version = await nextVersion(db, projectId)

// Step 1: Write stub (blocks completion if it fails)
try {
  await writeStub(db, changeId, version, executionOutcome, 'completed')
} catch (err) {
  console.error('[dashboard] stub write failed — not marking as completed:', err)
  return // keep analysis_status = 'running', caller retries
}

// Step 2: Mark change as completed
await db
  .from('change_requests')
  .update({
    status: executionOutcome === 'success' ? 'review' : 'failed',
    analysis_status: 'completed',
    analysis_version: currentAnalysisVersion + 1,
  })
  .eq('id', changeId)

// Step 3: Emit completed event (with stub as optimization payload)
const completedEvent: DashboardEvent = {
  type: 'completed', scope: 'analysis',
  changeId, projectId,
  analysisVersion: currentAnalysisVersion + 1,
  version,
  payload: { outcome: executionOutcome },
}
emitDashboardEvent(projectId, completedEvent)
recordEvent(db, projectId, completedEvent).catch(() => {})

// Step 4: Enrich snapshot in background (fire-and-forget with retries)
enrichSnapshotWithRetry(db, changeId, {
  stagesCompleted: completedStages,
  filesModified: filesModified,
  componentsAffected: [],
  duration_ms: Date.now() - startedAt,
}).catch(() => {})
```

Add the retry helper:

```ts
async function enrichSnapshotWithRetry(
  db: SupabaseClient,
  changeId: string,
  data: Parameters<typeof enrichSnapshot>[2],
  attempts = 3
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await enrichSnapshot(db, changeId, data)
      return
    } catch (err) {
      if (i === attempts - 1) {
        console.error('[dashboard] enrichment failed after retries:', err)
        await markEnrichmentFailed(db, changeId).catch(() => {})
      } else {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)))
      }
    }
  }
}
```

- [ ] **Step 7: Verify the server starts without TypeScript errors**

```bash
npx tsc --noEmit
```

Expected: no new type errors. Fix any that appear (usually missing imports or wrong property names).

- [ ] **Step 8: Commit**

```bash
git add lib/execution/execution-orchestrator.ts
git commit -m "feat: integrate dashboard events into execution orchestrator (stub-first, stage tracking)"
```

---

### Task 10: Wire Up + Smoke Test

**Files:**
- Modify: `app/api/change-requests/[id]/execute/route.ts` (add client_request_id passthrough)

- [ ] **Step 1: Pass client_request_id from execute route**

In `app/api/change-requests/[id]/execute/route.ts`, add to the POST handler after verifying the change exists:

```ts
const clientRequestId = _req.headers.get('X-Client-Request-Id')
if (clientRequestId) {
  await adminDb
    .from('change_requests')
    .update({ client_request_id: clientRequestId })
    .eq('id', id)
}
```

- [ ] **Step 2: Run the full test suite**

```bash
npx vitest run tests/lib/dashboard/
```

Expected: all dashboard tests PASS.

- [ ] **Step 3: Manual smoke test**

1. Open a project in the app
2. Open browser DevTools → Network → filter "dashboard-stream"
3. Execute a change
4. Verify SSE events arrive: `queued` → `started` → `progress` (multiple) → `completed`
5. Verify the `analysis_result_snapshot` row exists in Supabase Studio after completion

- [ ] **Step 4: Final commit**

```bash
git add app/api/change-requests/[id]/execute/route.ts
git commit -m "feat: pass client_request_id through execute route for optimistic insert reconciliation"
```

---

## Self-Review Checklist

- [ ] Migration includes `project_event_counter` with increment function ✓
- [ ] `analysis_result_snapshot` has `unique (change_id)` constraint ✓
- [ ] Stub write blocks completion if it fails ✓
- [ ] `synthetic: true` flag present on all reconstructed events ✓
- [ ] `analysisVersion` incremented on new run ✓
- [ ] `isStalled` uses stage-level timing, not global log time ✓
- [ ] SSE heartbeat comment format (`: heartbeat`) doesn't trigger client event handlers ✓
- [ ] Event history ring buffer pruned to 500 ✓
- [ ] `resync_required` emitted when client is behind buffer ✓
