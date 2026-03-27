# Requirements Intelligence v2 — Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the infrastructure layer to v2: new DB schema (pgvector, validated gaps, relations, knowledge cases), types overhaul, hardened AI provider with retry/repair/cost-logging, expanded rule set with domain packs, and gap detector updated to use domain packs + validation defaults.

**Architecture:** Additive DB migration — new tables and columns, nothing dropped from v1 (v1 tables left in place until Plan E removes them from active use). AI provider interface changes from returning `string` to `CompletionResult` — every adapter and every caller is updated in the same task to keep the codebase consistent. Rule reorganisation: existing five rules stay in place; five new core rules added in `lib/requirements/rules/core/`; domain packs in `lib/requirements/rules/saas/`, `fintech/`, `workflow/`; a `lib/requirements/rules/index.ts` registry wires them together. Gap detector updated to call the registry by domain and stamp `validated` defaults per source.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase (Postgres + pgvector), Vitest, @anthropic-ai/sdk, openai

**What this plan does NOT include (Plan E):** relation detection, gap validation API, risk acceptance, scoring v2, knowledge layer, risk predictor, partial re-eval v2, API/UI updates.

---

## File Map

**New files:**
- `supabase/migrations/002_v2_schema.sql` — all new tables, columns, RLS, pgvector RPC
- `lib/ai/repair.ts` — `repairJson`, `repairAndParse`
- `lib/requirements/rules/core/has-data-model.ts`
- `lib/requirements/rules/core/has-input-output-contracts.ts`
- `lib/requirements/rules/core/has-edge-cases-covered.ts`
- `lib/requirements/rules/core/has-permissions-matrix.ts`
- `lib/requirements/rules/core/has-external-dependencies.ts`
- `lib/requirements/rules/saas/has-billing-defined.ts`
- `lib/requirements/rules/saas/has-multi-tenancy-addressed.ts`
- `lib/requirements/rules/saas/has-auth-strategy-defined.ts`
- `lib/requirements/rules/fintech/has-compliance-requirements.ts`
- `lib/requirements/rules/fintech/has-audit-trail-defined.ts`
- `lib/requirements/rules/fintech/has-reconciliation-defined.ts`
- `lib/requirements/rules/workflow/has-rollback-defined.ts`
- `lib/requirements/rules/workflow/has-idempotency-addressed.ts`
- `lib/requirements/rules/workflow/has-retry-strategy-defined.ts`
- `lib/requirements/rules/index.ts` — `RuleCheck` type + `selectRulePack(domain)`
- `tests/lib/ai/repair.test.ts`
- `tests/lib/requirements/rules/core/has-data-model.test.ts`
- `tests/lib/requirements/rules/core/has-input-output-contracts.test.ts`
- `tests/lib/requirements/rules/core/has-edge-cases-covered.test.ts`
- `tests/lib/requirements/rules/core/has-permissions-matrix.test.ts`
- `tests/lib/requirements/rules/core/has-external-dependencies.test.ts`
- `tests/lib/requirements/rules/saas/has-billing-defined.test.ts`
- `tests/lib/requirements/rules/saas/has-multi-tenancy-addressed.test.ts`
- `tests/lib/requirements/rules/saas/has-auth-strategy-defined.test.ts`
- `tests/lib/requirements/rules/fintech/has-compliance-requirements.test.ts`
- `tests/lib/requirements/rules/fintech/has-audit-trail-defined.test.ts`
- `tests/lib/requirements/rules/fintech/has-reconciliation-defined.test.ts`
- `tests/lib/requirements/rules/workflow/has-rollback-defined.test.ts`
- `tests/lib/requirements/rules/workflow/has-idempotency-addressed.test.ts`
- `tests/lib/requirements/rules/workflow/has-retry-strategy-defined.test.ts`
- `tests/lib/requirements/rules/rule-index.test.ts`

**Modified files:**
- `lib/supabase/types.ts` — v2 types (new tables, updated Gap/Requirement/CompletenessScore)
- `lib/ai/provider.ts` — `CompletionResult` return type, `AIProviderError`, `AIProvider.complete()` signature
- `lib/ai/adapters/mock.ts` — return `CompletionResult`, add `callCount` for test assertions
- `lib/ai/adapters/claude.ts` — return `CompletionResult`, add retry + repair loop
- `lib/ai/adapters/openai.ts` — return `CompletionResult`, add retry + repair loop
- `lib/ai/registry.ts` — update for new interface, add `getProviderByName()`
- `lib/requirements/gap-detector.ts` — accept `domain`, use `selectRulePack`, stamp `validated` per source, update `DetectedGap` type
- `lib/requirements/question-generator.ts` — update `ai.complete()` call to use `result.content`
- `lib/requirements/parser.ts` — update `ai.complete()` call to use `result.content`
- `lib/requirements/pipeline.ts` — update all `ai.complete()` call sites, log `CompletionResult` to `ai_usage_log`
- `lib/requirements/re-evaluator.ts` — update `ai.complete()` call to use `result.content`
- `tests/lib/ai/provider.test.ts` — update for new interface (remove `parseStructuredResponse` tests)
- `tests/lib/ai/adapters/mock.test.ts` — update for `CompletionResult`
- `tests/lib/ai/adapters/adapters.test.ts` — update for `CompletionResult`
- `tests/lib/requirements/gap-detector.test.ts` — update for domain + validated fields
- `tests/lib/requirements/pipeline.test.ts` — update mock calls for `CompletionResult`
- `tests/lib/requirements/scorer.test.ts` — update mock provider calls
- `tests/lib/requirements/re-evaluator.test.ts` — update mock provider calls
- `tests/lib/requirements/question-generator.test.ts` — update mock calls
- `tests/api/requirements/status.test.ts` — update for validated gap gate logic
- `tests/api/requirements/decisions.test.ts` — update mock calls

---

## Task 1: DB Migration v2

**Files:**
- Create: `supabase/migrations/002_v2_schema.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/002_v2_schema.sql`:

```sql
-- 002_v2_schema.sql

-- pgvector for knowledge layer
create extension if not exists vector;

-- ── requirements ──────────────────────────────────────────────────────────────
alter table requirements
  add column if not exists domain text
    check (domain in ('saas', 'fintech', 'workflow', 'general'));

-- ── gaps ──────────────────────────────────────────────────────────────────────
-- 'relation' added as a valid source (stored as free text — no check constraint to avoid migration lock)
alter table gaps
  add column if not exists validated        boolean not null default false,
  add column if not exists validated_by     uuid references auth.users(id);

-- resolution_source gains two new values: 'risk_accepted', 'dismissed'
-- (column is already TEXT with no check constraint — no change needed)

-- ── requirement_relations ─────────────────────────────────────────────────────
create table if not exists requirement_relations (
  id          uuid primary key default gen_random_uuid(),
  source_id   uuid not null references requirement_items(id) on delete cascade,
  target_id   uuid not null references requirement_items(id) on delete cascade,
  type        text not null check (type in ('depends_on', 'conflicts_with', 'refines')),
  detected_by text not null check (detected_by in ('rule', 'ai')),
  created_at  timestamptz not null default now()
);

-- ── risk_acceptances ──────────────────────────────────────────────────────────
create table if not exists risk_acceptances (
  id          uuid primary key default gen_random_uuid(),
  gap_id      uuid not null references gaps(id) on delete cascade,
  accepted_by uuid not null references auth.users(id),
  rationale   text not null,
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);

-- ── ai_usage_log ──────────────────────────────────────────────────────────────
create table if not exists ai_usage_log (
  id              uuid primary key default gen_random_uuid(),
  requirement_id  uuid references requirements(id) on delete set null,
  pipeline_step   text not null,
  provider        text not null,
  model           text not null,
  input_tokens    integer not null default 0,
  output_tokens   integer not null default 0,
  latency_ms      integer not null default 0,
  retry_count     integer not null default 0,
  created_at      timestamptz not null default now()
);

-- ── knowledge_cases ───────────────────────────────────────────────────────────
create table if not exists knowledge_cases (
  id                          uuid primary key default gen_random_uuid(),
  project_id                  uuid references projects(id) on delete set null,
  requirement_item_snapshot   jsonb not null,
  gap_snapshot                jsonb not null,
  resolution_snapshot         jsonb not null,
  context_tags                text[] not null default '{}',
  embedding                   vector(1536),
  created_at                  timestamptz not null default now()
);

create index if not exists knowledge_cases_embedding_idx
  on knowledge_cases using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- ── case_feedback ─────────────────────────────────────────────────────────────
create table if not exists case_feedback (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references knowledge_cases(id) on delete cascade,
  user_id     uuid not null references auth.users(id),
  helpful     boolean not null,
  used        boolean not null default false,
  overridden  boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ── completeness_scores (v2 columns) ─────────────────────────────────────────
alter table completeness_scores
  add column if not exists blocking_count    integer not null default 0,
  add column if not exists high_risk_count   integer not null default 0,
  add column if not exists coverage_pct      integer not null default 0,
  add column if not exists internal_score    integer not null default 0,
  add column if not exists complexity_score  integer not null default 0,
  add column if not exists risk_flags        jsonb   not null default '[]',
  add column if not exists gap_density       decimal not null default 0;

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table requirement_relations enable row level security;
alter table risk_acceptances       enable row level security;
alter table ai_usage_log           enable row level security;
alter table knowledge_cases        enable row level security;
alter table case_feedback          enable row level security;

create policy "requirement_relations_owner" on requirement_relations
  using (
    exists (
      select 1 from requirement_items ri
        join requirements r  on r.id  = ri.requirement_id
        join projects      p on p.id  = r.project_id
      where ri.id = requirement_relations.source_id
        and p.owner_id = auth.uid()
    )
  );

create policy "risk_acceptances_owner" on risk_acceptances
  using (
    exists (
      select 1 from gaps g
        join requirements r on r.id = g.requirement_id
        join projects      p on p.id = r.project_id
      where g.id = risk_acceptances.gap_id
        and p.owner_id = auth.uid()
    )
  );

create policy "ai_usage_log_owner" on ai_usage_log
  using (
    requirement_id is null or
    exists (
      select 1 from requirements r
        join projects p on p.id = r.project_id
      where r.id = ai_usage_log.requirement_id
        and p.owner_id = auth.uid()
    )
  );

create policy "knowledge_cases_owner" on knowledge_cases
  using (
    project_id is null or
    exists (
      select 1 from projects p
      where p.id = knowledge_cases.project_id
        and p.owner_id = auth.uid()
    )
  );

create policy "case_feedback_user" on case_feedback
  using (user_id = auth.uid());

-- ── pgvector similarity RPC (used by Plan E knowledge retriever) ──────────────
create or replace function match_knowledge_cases (
  query_embedding     vector(1536),
  context_tags_filter text[],
  match_count         int default 5
)
returns table (
  id                        uuid,
  gap_snapshot              jsonb,
  resolution_snapshot       jsonb,
  context_tags              text[],
  similarity                float
)
language sql stable
as $$
  select
    kc.id,
    kc.gap_snapshot,
    kc.resolution_snapshot,
    kc.context_tags,
    1 - (kc.embedding <=> query_embedding) as similarity
  from knowledge_cases kc
  where kc.embedding is not null
    and kc.context_tags && context_tags_filter
  order by kc.embedding <=> query_embedding
  limit match_count;
$$;
```

- [ ] **Step 2: Apply the migration**

```bash
npx supabase db push
```

Expected: migration applies without errors. If running locally: `npx supabase db reset` then re-seed.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/002_v2_schema.sql
git commit -m "feat: add v2 DB schema — relations, risk acceptances, knowledge cases, ai_usage_log, pgvector"
```

---

## Task 2: Types Overhaul

**Files:**
- Modify: `lib/supabase/types.ts`

No tests needed — types are compile-time only. TypeScript errors after this task are expected and fixed in subsequent tasks.

- [ ] **Step 1: Replace `lib/supabase/types.ts`**

```typescript
// lib/supabase/types.ts

export type RequirementStatus =
  | 'draft'
  | 'analyzing'
  | 'incomplete'
  | 'review_required'
  | 'ready_for_dev'
  | 'blocked'

export type RequirementDomain = 'saas' | 'fintech' | 'workflow' | 'general'

export type GapSeverity  = 'critical' | 'major' | 'minor'
export type GapCategory  = 'missing' | 'ambiguous' | 'conflicting' | 'incomplete'
export type GapSource    = 'rule' | 'ai' | 'relation'
export type RelationType = 'depends_on' | 'conflicts_with' | 'refines'
export type NfrCategory  = 'security' | 'performance' | 'auditability'
export type TargetRole   = 'ba' | 'architect' | 'po' | 'dev'
export type TaskStatus   = 'open' | 'in-progress' | 'resolved' | 'dismissed'
export type QuestionStatus = 'open' | 'answered' | 'dismissed'
export type ItemType     = 'functional' | 'non-functional' | 'constraint' | 'assumption'

export interface Project {
  id: string
  name: string
  owner_id: string
  created_at: string
}

export interface Requirement {
  id: string
  project_id: string
  title: string
  raw_input: string
  domain: RequirementDomain | null
  status: RequirementStatus
  blocked_reason: string | null
  created_at: string
  updated_at: string
}

export interface RequirementItem {
  id: string
  requirement_id: string
  type: ItemType
  title: string
  description: string
  priority: 'high' | 'medium' | 'low'
  source_text: string | null
  nfr_category: NfrCategory | null
  created_at: string
}

export interface RequirementRelation {
  id: string
  source_id: string
  target_id: string
  type: RelationType
  detected_by: 'rule' | 'ai'
  created_at: string
}

export interface Gap {
  id: string
  requirement_id: string
  item_id: string | null
  severity: GapSeverity
  category: GapCategory
  description: string
  source: GapSource
  rule_id: string | null
  priority_score: number
  confidence: number
  validated: boolean
  validated_by: string | null
  question_generated: boolean
  merged_into: string | null
  resolved_at: string | null
  resolution_source:
    | 'question_answered'
    | 'task_resolved'
    | 'decision_recorded'
    | 'risk_accepted'
    | 'dismissed'
    | null
  created_at: string
}

export interface RiskAcceptance {
  id: string
  gap_id: string
  accepted_by: string
  rationale: string
  expires_at: string | null
  created_at: string
}

export interface Question {
  id: string
  gap_id: string
  requirement_id: string
  question_text: string
  target_role: TargetRole
  status: QuestionStatus
  answer: string | null
  answered_at: string | null
  created_at: string
}

export interface InvestigationTask {
  id: string
  requirement_id: string
  linked_gap_id: string | null
  title: string
  description: string
  priority: 'high' | 'medium' | 'low'
  status: TaskStatus
  created_at: string
}

export interface AuditLog {
  id: string
  entity_type: string
  entity_id: string
  action: 'created' | 'updated' | 'deleted' | 'analyzed' | 'scored' | 'risk_accepted'
  actor_id: string | null
  diff: Record<string, unknown> | null
  created_at: string
}

export interface DecisionLog {
  id: string
  requirement_id: string
  related_gap_id: string | null
  related_question_id: string | null
  decision: string
  rationale: string
  decided_by: string
  created_at: string
}

export interface AiUsageLog {
  id: string
  requirement_id: string | null
  pipeline_step: string
  provider: string
  model: string
  input_tokens: number
  output_tokens: number
  latency_ms: number
  retry_count: number
  created_at: string
}

export interface KnowledgeCase {
  id: string
  project_id: string | null
  requirement_item_snapshot: Record<string, unknown>
  gap_snapshot: Record<string, unknown>
  resolution_snapshot: Record<string, unknown>
  context_tags: string[]
  embedding: number[] | null
  created_at: string
}

export interface CaseFeedback {
  id: string
  case_id: string
  user_id: string
  helpful: boolean
  used: boolean
  overridden: boolean
  created_at: string
}

export interface CompletenessScore {
  id: string
  requirement_id: string
  // Primary signals (shown in UI)
  blocking_count: number
  high_risk_count: number
  coverage_pct: number
  // Secondary (internal)
  internal_score: number
  nfr_score: number
  // Risk
  complexity_score: number
  risk_flags: string[]
  // Metadata
  gap_density: number
  breakdown: ScoreBreakdown
  scored_at: string
}

export interface ScoreBreakdown {
  blocking_count: number
  high_risk_count: number
  coverage_pct: number
  internal_score: number
  nfr_score: number
  gap_density: number
  complexity_score: number
  risk_flags: string[]
  gap_counts: { critical: number; major: number; minor: number; unvalidated: number }
  nfr_coverage: { security: boolean; performance: boolean; auditability: boolean }
}

export interface RequirementSummary {
  blocking_count: number
  high_risk_count: number
  coverage_pct: number
  unvalidated_count: number
  internal_score: number
  complexity_score: number
  risk_flags: string[]
  status: RequirementStatus
  blocked_reason: string | null
}
```

- [ ] **Step 2: Run the TypeScript compiler to find all type errors introduced**

```bash
npx tsc --noEmit 2>&1 | head -60
```

Expected: a list of type errors in files that used the old types — these are fixed in subsequent tasks. Do not fix them yet.

- [ ] **Step 3: Commit**

```bash
git add lib/supabase/types.ts
git commit -m "feat: overhaul types for v2 — relations, risk acceptances, knowledge cases, v2 scoring"
```

---

## Task 3: AI Provider v2 Interface + Repair Module

**Files:**
- Modify: `lib/ai/provider.ts`
- Create: `lib/ai/repair.ts`
- Create: `tests/lib/ai/repair.test.ts`

- [ ] **Step 1: Write the failing tests for repair.ts**

Create `tests/lib/ai/repair.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { repairJson, repairAndParse } from '@/lib/ai/repair'

describe('repairJson', () => {
  it('strips markdown code fences', () => {
    const input = '```json\n{"a": 1}\n```'
    expect(JSON.parse(repairJson(input))).toEqual({ a: 1 })
  })

  it('removes trailing comma before }', () => {
    const input = '{"a": 1, "b": 2,}'
    expect(JSON.parse(repairJson(input))).toEqual({ a: 1, b: 2 })
  })

  it('removes trailing comma before ]', () => {
    const input = '[1, 2, 3,]'
    expect(JSON.parse(repairJson(input))).toEqual([1, 2, 3])
  })

  it('extracts JSON from surrounding prose', () => {
    const input = 'Here is the result:\n{"gaps": []}\nHope that helps!'
    expect(JSON.parse(repairJson(input))).toEqual({ gaps: [] })
  })

  it('handles nested objects with trailing commas', () => {
    const input = '{"outer": {"inner": "value",},}'
    expect(JSON.parse(repairJson(input))).toEqual({ outer: { inner: 'value' } })
  })
})

describe('repairAndParse', () => {
  it('parses valid JSON directly', () => {
    expect(repairAndParse<{ x: number }>('{"x": 42}')).toEqual({ x: 42 })
  })

  it('repairs and parses JSON with trailing comma', () => {
    expect(repairAndParse<{ x: number }>('{"x": 42,}')).toEqual({ x: 42 })
  })

  it('returns null for unparseable input', () => {
    expect(repairAndParse('not json at all {{{')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(repairAndParse('')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/ai/repair.test.ts
```

Expected: FAIL — `repairJson` and `repairAndParse` not found.

- [ ] **Step 3: Write `lib/ai/repair.ts`**

```typescript
// lib/ai/repair.ts

/**
 * Attempts common JSON fixes on a raw string:
 * - Strips markdown code fences (```json ... ```)
 * - Removes trailing commas before } or ]
 * - Extracts the outermost { } or [ ] block from surrounding prose
 */
export function repairJson(raw: string): string {
  let s = raw.trim()
  // Strip markdown code fences
  s = s.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '')
  // Remove trailing commas before closing braces/brackets (handles nested)
  s = s.replace(/,(\s*[}\]])/g, '$1')
  // Extract outermost JSON object or array from surrounding prose
  const start = s.search(/[{[]/)
  const lastBrace   = s.lastIndexOf('}')
  const lastBracket = s.lastIndexOf(']')
  const end = Math.max(lastBrace, lastBracket)
  if (start !== -1 && end > start) {
    s = s.slice(start, end + 1)
  }
  return s
}

/** Try JSON.parse directly, then try after repair. Returns null on total failure. */
export function repairAndParse<T>(raw: string): T | null {
  if (!raw) return null
  try { return JSON.parse(raw) as T } catch { /* fall through to repair */ }
  try { return JSON.parse(repairJson(raw)) as T } catch { return null }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/ai/repair.test.ts
```

Expected: PASS — all 9 tests green.

- [ ] **Step 5: Update `lib/ai/provider.ts`**

```typescript
// lib/ai/provider.ts

export interface CompletionOptions {
  /** JSON Schema for structured output. When provided, adapter MUST return valid JSON string. */
  responseSchema?: Record<string, unknown>
  temperature?: number
  maxTokens?: number
  /** Request timeout in milliseconds. Default: 30000 */
  timeout?: number
  /** Max retry attempts on JSON failure or transient error. Default: 3 */
  maxRetries?: number
  /** Provider ID to try if primary provider exhausts retries */
  fallbackProvider?: string
}

export interface CompletionResult {
  content: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  retryCount: number
  latencyMs: number
}

export interface AIProvider {
  complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult>
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    public readonly step: string,
    public readonly provider: string,
    public readonly attemptCount: number,
    public readonly lastError: unknown
  ) {
    super(message)
    this.name = 'AIProviderError'
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add lib/ai/repair.ts tests/lib/ai/repair.test.ts lib/ai/provider.ts
git commit -m "feat: add repair.ts (JSON auto-repair) and upgrade AIProvider to return CompletionResult"
```

---

## Task 4: Update Mock Adapter

**Files:**
- Modify: `lib/ai/adapters/mock.ts`
- Modify: `tests/lib/ai/adapters/mock.test.ts`

- [ ] **Step 1: Update the mock adapter tests**

Replace `tests/lib/ai/adapters/mock.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

describe('MockAIProvider', () => {
  it('returns CompletionResult with default response', async () => {
    const provider = new MockAIProvider()
    const result = await provider.complete('any prompt')
    expect(result.content).toBe('{}')
    expect(result.provider).toBe('mock')
    expect(result.model).toBe('mock')
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
    expect(result.retryCount).toBe(0)
    expect(result.latencyMs).toBe(0)
  })

  it('matches on prompt substring', async () => {
    const provider = new MockAIProvider()
    provider.setResponse('GAPS', '{"gaps": []}')
    const result = await provider.complete('detect GAPS in this')
    expect(result.content).toBe('{"gaps": []}')
  })

  it('falls through to default when no key matches', async () => {
    const provider = new MockAIProvider()
    provider.setResponse('GAPS', '{"gaps": []}')
    const result = await provider.complete('unrelated prompt')
    expect(result.content).toBe('{}')
  })

  it('tracks call count', async () => {
    const provider = new MockAIProvider()
    await provider.complete('a')
    await provider.complete('b')
    expect(provider.callCount).toBe(2)
  })

  it('setDefaultResponse overrides default', async () => {
    const provider = new MockAIProvider()
    provider.setDefaultResponse('{"ok": true}')
    const result = await provider.complete('anything')
    expect(result.content).toBe('{"ok": true}')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/ai/adapters/mock.test.ts
```

Expected: FAIL — `complete()` returns `string`, not `CompletionResult`; `callCount` not defined.

- [ ] **Step 3: Update `lib/ai/adapters/mock.ts`**

```typescript
// lib/ai/adapters/mock.ts
import type { AIProvider, CompletionOptions, CompletionResult } from '@/lib/ai/provider'

export class MockAIProvider implements AIProvider {
  private responses: Map<string, string> = new Map()
  private defaultResponse = '{}'
  callCount = 0

  setResponse(promptContains: string, response: string) {
    this.responses.set(promptContains, response)
  }

  setDefaultResponse(response: string) {
    this.defaultResponse = response
  }

  async complete(prompt: string, _options?: CompletionOptions): Promise<CompletionResult> {
    this.callCount++
    let content = this.defaultResponse
    for (const [key, response] of this.responses) {
      if (prompt.includes(key)) { content = response; break }
    }
    return { content, provider: 'mock', model: 'mock', inputTokens: 0, outputTokens: 0, retryCount: 0, latencyMs: 0 }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/ai/adapters/mock.test.ts
```

Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/adapters/mock.ts tests/lib/ai/adapters/mock.test.ts
git commit -m "feat: upgrade MockAIProvider to return CompletionResult, add callCount"
```

---

## Task 5: Update Claude + OpenAI Adapters + Registry

**Files:**
- Modify: `lib/ai/adapters/claude.ts`
- Modify: `lib/ai/adapters/openai.ts`
- Modify: `lib/ai/registry.ts`
- Modify: `tests/lib/ai/provider.test.ts`
- Modify: `tests/lib/ai/adapters/adapters.test.ts`

- [ ] **Step 1: Update `tests/lib/ai/provider.test.ts`**

`parseStructuredResponse` is removed — update the test file:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { getProvider } from '@/lib/ai/registry'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

describe('AI provider registry', () => {
  afterEach(() => {
    delete process.env.AI_PROVIDER
  })

  it('returns MockAIProvider when AI_PROVIDER=mock', () => {
    process.env.AI_PROVIDER = 'mock'
    const provider = getProvider()
    expect(provider).toBeInstanceOf(MockAIProvider)
  })

  it('throws when AI_PROVIDER is unrecognised', () => {
    process.env.AI_PROVIDER = 'unknown-provider'
    expect(() => getProvider()).toThrow('Unknown AI_PROVIDER: unknown-provider')
  })

  it('complete() returns a CompletionResult with provider=mock', async () => {
    process.env.AI_PROVIDER = 'mock'
    const provider = getProvider()
    const result = await provider.complete('hello')
    expect(result.provider).toBe('mock')
    expect(typeof result.content).toBe('string')
    expect(typeof result.latencyMs).toBe('number')
  })
})
```

- [ ] **Step 2: Update `lib/ai/adapters/claude.ts`**

```typescript
// lib/ai/adapters/claude.ts
import Anthropic from '@anthropic-ai/sdk'
import type { AIProvider, CompletionOptions, CompletionResult } from '@/lib/ai/provider'
import { AIProviderError } from '@/lib/ai/provider'
import { repairAndParse } from '@/lib/ai/repair'

export class ClaudeAIProvider implements AIProvider {
  private client: Anthropic
  readonly providerName = 'claude'
  readonly modelName: string

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    this.modelName = process.env.CLAUDE_MODEL ?? 'claude-opus-4-6'
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const maxRetries = options?.maxRetries ?? 3
    const timeout    = options?.timeout    ?? 30_000
    const startMs    = Date.now()
    let lastError: unknown
    let retryCount = 0

    const systemPrompt = options?.responseSchema
      ? `You must respond with valid JSON only. No prose, no markdown. JSON Schema: ${JSON.stringify(options.responseSchema)}`
      : 'You are a helpful requirements engineering assistant.'

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const message = await Promise.race([
          this.client.messages.create({
            model: this.modelName,
            max_tokens: options?.maxTokens ?? 4096,
            temperature: attempt > 0 ? 0 : (options?.temperature ?? 0),
            system: systemPrompt,
            messages: [{ role: 'user', content: prompt }],
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('request timeout')), timeout)
          ),
        ])

        const block = message.content[0]
        if (block.type !== 'text') throw new Error('Unexpected Claude response block type')

        let content = block.text

        // JSON repair when schema was requested
        if (options?.responseSchema) {
          const parsed = repairAndParse(content)
          if (parsed === null) {
            lastError = new Error('Invalid JSON — repair failed')
            retryCount = attempt + 1
            continue
          }
          content = JSON.stringify(parsed)
        }

        return {
          content,
          provider: this.providerName,
          model: this.modelName,
          inputTokens:  message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          retryCount,
          latencyMs: Date.now() - startMs,
        }
      } catch (err) {
        lastError = err
        retryCount = attempt + 1
      }
    }

    throw new AIProviderError(
      `Claude failed after ${maxRetries + 1} attempts`,
      'unknown',
      this.providerName,
      maxRetries + 1,
      lastError
    )
  }
}
```

- [ ] **Step 3: Update `lib/ai/adapters/openai.ts`**

```typescript
// lib/ai/adapters/openai.ts
import OpenAI from 'openai'
import type { AIProvider, CompletionOptions, CompletionResult } from '@/lib/ai/provider'
import { AIProviderError } from '@/lib/ai/provider'
import { repairAndParse } from '@/lib/ai/repair'

export class OpenAIProvider implements AIProvider {
  private client: OpenAI
  readonly providerName = 'openai'
  readonly modelName: string

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    this.modelName = process.env.OPENAI_MODEL ?? 'gpt-4o'
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const maxRetries = options?.maxRetries ?? 3
    const timeout    = options?.timeout    ?? 30_000
    const startMs    = Date.now()
    let lastError: unknown
    let retryCount = 0

    const systemPrompt = options?.responseSchema
      ? `You must respond with valid JSON only. No prose, no markdown. JSON Schema: ${JSON.stringify(options.responseSchema)}`
      : 'You are a helpful requirements engineering assistant.'

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await Promise.race([
          this.client.chat.completions.create({
            model: this.modelName,
            temperature: attempt > 0 ? 0 : (options?.temperature ?? 0),
            max_tokens: options?.maxTokens ?? 4096,
            response_format: options?.responseSchema ? { type: 'json_object' } : { type: 'text' },
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('request timeout')), timeout)
          ),
        ])

        if (!response.choices.length) throw new Error('OpenAI returned no choices')
        const raw = response.choices[0].message.content
        if (raw === null) throw new Error('OpenAI returned null content')

        let content = raw

        if (options?.responseSchema) {
          const parsed = repairAndParse(content)
          if (parsed === null) {
            lastError = new Error('Invalid JSON — repair failed')
            retryCount = attempt + 1
            continue
          }
          content = JSON.stringify(parsed)
        }

        const usage = response.usage

        return {
          content,
          provider: this.providerName,
          model: this.modelName,
          inputTokens:  usage?.prompt_tokens     ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
          retryCount,
          latencyMs: Date.now() - startMs,
        }
      } catch (err) {
        lastError = err
        retryCount = attempt + 1
      }
    }

    throw new AIProviderError(
      `OpenAI failed after ${maxRetries + 1} attempts`,
      'unknown',
      this.providerName,
      maxRetries + 1,
      lastError
    )
  }
}
```

- [ ] **Step 4: Update `lib/ai/registry.ts`**

```typescript
// lib/ai/registry.ts
import type { AIProvider } from './provider'
import { MockAIProvider }  from './adapters/mock'
import { ClaudeAIProvider } from './adapters/claude'
import { OpenAIProvider }  from './adapters/openai'

export function getProviderByName(name: string): AIProvider {
  switch (name) {
    case 'mock':   return new MockAIProvider()
    case 'claude': return new ClaudeAIProvider()
    case 'openai': return new OpenAIProvider()
    default: throw new Error(`Unknown AI_PROVIDER: ${name}`)
  }
}

export function getProvider(): AIProvider {
  return getProviderByName(process.env.AI_PROVIDER ?? 'mock')
}
```

- [ ] **Step 5: Run provider tests**

```bash
npx vitest run tests/lib/ai/provider.test.ts
```

Expected: PASS — 3 tests green.

- [ ] **Step 6: Commit**

```bash
git add lib/ai/adapters/claude.ts lib/ai/adapters/openai.ts lib/ai/registry.ts tests/lib/ai/provider.test.ts
git commit -m "feat: upgrade Claude + OpenAI adapters to return CompletionResult with retry and JSON repair"
```

---

## Task 6: Fix All Callers of `ai.complete()`

Every file that calls `ai.complete()` must be updated: it now returns `Promise<CompletionResult>` not `Promise<string>`. The call becomes `(await ai.complete(...)).content` everywhere `parseStructuredResponse` was previously called on the raw string.

**Files:**
- Modify: `lib/requirements/parser.ts`
- Modify: `lib/requirements/gap-detector.ts` (partial — full update in Task 9)
- Modify: `lib/requirements/question-generator.ts`
- Modify: `lib/requirements/re-evaluator.ts`
- Modify: `lib/requirements/pipeline.ts`

- [ ] **Step 1: Update `lib/requirements/parser.ts`**

Find the `ai.complete(...)` call. Change it from:

```typescript
const raw = await ai.complete(prompt, { responseSchema: PARSE_REQUIREMENTS_SCHEMA })
const parsed = parseStructuredResponse<...>(raw, PARSE_REQUIREMENTS_SCHEMA)
```

To:

```typescript
const result = await ai.complete(prompt, { responseSchema: PARSE_REQUIREMENTS_SCHEMA })
const parsed = JSON.parse(result.content) as { ... }
```

Read `lib/requirements/parser.ts` first, then apply the exact change to that file's actual `ai.complete` call site. Remove the `parseStructuredResponse` import.

- [ ] **Step 2: Update `lib/requirements/question-generator.ts`**

Change:

```typescript
const raw = await ai.complete(prompt, { responseSchema: GENERATE_QUESTION_SCHEMA })
const parsed = parseStructuredResponse<{ question_text: string; target_role: TargetRole }>(
  raw,
  GENERATE_QUESTION_SCHEMA
)
```

To:

```typescript
const result = await ai.complete(prompt, { responseSchema: GENERATE_QUESTION_SCHEMA })
const parsed = JSON.parse(result.content) as { question_text: string; target_role: TargetRole }
```

Remove the `parseStructuredResponse` import.

- [ ] **Step 3: Update `lib/requirements/gap-detector.ts`**

Change:

```typescript
const raw = await ai.complete(prompt, { responseSchema: DETECT_GAPS_SCHEMA })
const parsed = parseStructuredResponse<{ gaps: ... }>(raw, DETECT_GAPS_SCHEMA)
```

To:

```typescript
const result = await ai.complete(prompt, { responseSchema: DETECT_GAPS_SCHEMA })
const parsed = JSON.parse(result.content) as { gaps: Array<{
  item_id?: string | null
  severity: GapSeverity
  category: GapCategory
  description: string
  confidence: number
}> }
```

Remove the `parseStructuredResponse` import.

- [ ] **Step 4: Check `lib/requirements/re-evaluator.ts` for any `ai.complete()` calls**

Read the file. If there are `ai.complete()` calls, apply the same pattern (`result.content`). If none, skip.

- [ ] **Step 5: Update `lib/requirements/pipeline.ts`**

`pipeline.ts` calls `ai` only through the module functions (`parseRequirements`, `detectGaps`, etc.) — it doesn't call `ai.complete()` directly. No change needed. Verify by reading `pipeline.ts` for direct `ai.complete` references.

- [ ] **Step 6: Run the full test suite**

```bash
npx vitest run
```

Expected: tests that previously passed should still pass. Some tests may fail because `pipeline.test.ts`, `gap-detector.test.ts`, `scorer.test.ts` etc. set up mock responses as plain strings — those will fail because `MockAIProvider.complete()` now wraps them in `CompletionResult`. Fix those tests by checking that they use `MockAIProvider` (which already wraps correctly) rather than a manual mock returning a string. If any test manually mocks `complete` to return a string, update it to return a `CompletionResult`:

```typescript
// Old:
vi.fn().mockResolvedValue('{"gaps":[]}')
// New:
vi.fn().mockResolvedValue({ content: '{"gaps":[]}', provider: 'mock', model: 'mock', inputTokens: 0, outputTokens: 0, retryCount: 0, latencyMs: 0 })
```

- [ ] **Step 7: Commit**

```bash
git add lib/requirements/parser.ts lib/requirements/gap-detector.ts lib/requirements/question-generator.ts lib/requirements/re-evaluator.ts
git commit -m "fix: update all ai.complete() callers to use result.content"
```

---

## Task 7: Five New Core Rules

**Files:**
- Create: `lib/requirements/rules/core/has-data-model.ts`
- Create: `lib/requirements/rules/core/has-input-output-contracts.ts`
- Create: `lib/requirements/rules/core/has-edge-cases-covered.ts`
- Create: `lib/requirements/rules/core/has-permissions-matrix.ts`
- Create: `lib/requirements/rules/core/has-external-dependencies.ts`
- Create: `tests/lib/requirements/rules/core/has-data-model.test.ts`
- Create: `tests/lib/requirements/rules/core/has-input-output-contracts.test.ts`
- Create: `tests/lib/requirements/rules/core/has-edge-cases-covered.test.ts`
- Create: `tests/lib/requirements/rules/core/has-permissions-matrix.test.ts`
- Create: `tests/lib/requirements/rules/core/has-external-dependencies.test.ts`

All new rule functions follow the same contract as the existing ones: `(items: ParsedItem[]) => boolean`, return `true` when the requirement area is addressed (no gap), `false` when it is missing (gap fires).

- [ ] **Step 1: Write failing tests for all five rules**

Create `tests/lib/requirements/rules/core/has-data-model.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { hasDataModelDefined } from '@/lib/requirements/rules/core/has-data-model'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null,
}

describe('hasDataModelDefined', () => {
  it('returns false when no data model keywords present', () => {
    expect(hasDataModelDefined([{ ...base, description: 'The system processes the form.' }])).toBe(false)
  })
  it('returns true when description mentions entity', () => {
    expect(hasDataModelDefined([{ ...base, description: 'The User entity has name and email fields.' }])).toBe(true)
  })
  it('returns true when title mentions schema', () => {
    expect(hasDataModelDefined([{ ...base, title: 'Database schema for orders' }])).toBe(true)
  })
  it('returns true when description mentions data structure', () => {
    expect(hasDataModelDefined([{ ...base, description: 'Define the data structure for invoice records.' }])).toBe(true)
  })
})
```

Create `tests/lib/requirements/rules/core/has-input-output-contracts.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { hasInputOutputContracts } from '@/lib/requirements/rules/core/has-input-output-contracts'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null,
}

describe('hasInputOutputContracts', () => {
  it('returns false when no contract keywords present', () => {
    expect(hasInputOutputContracts([{ ...base, description: 'The system validates the user.' }])).toBe(false)
  })
  it('returns true when description mentions API', () => {
    expect(hasInputOutputContracts([{ ...base, description: 'The REST API accepts a JSON payload.' }])).toBe(true)
  })
  it('returns true when description mentions request/response', () => {
    expect(hasInputOutputContracts([{ ...base, description: 'The response returns a 200 status.' }])).toBe(true)
  })
  it('returns true when title mentions endpoint', () => {
    expect(hasInputOutputContracts([{ ...base, title: 'POST /orders endpoint' }])).toBe(true)
  })
})
```

Create `tests/lib/requirements/rules/core/has-edge-cases-covered.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { hasEdgeCasesCovered } from '@/lib/requirements/rules/core/has-edge-cases-covered'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null,
}

describe('hasEdgeCasesCovered', () => {
  it('returns false when no edge case keywords present', () => {
    expect(hasEdgeCasesCovered([{ ...base, description: 'Users can create orders.' }])).toBe(false)
  })
  it('returns true when description mentions edge case', () => {
    expect(hasEdgeCasesCovered([{ ...base, description: 'Edge cases for empty cart must be handled.' }])).toBe(true)
  })
  it('returns true when description mentions boundary', () => {
    expect(hasEdgeCasesCovered([{ ...base, description: 'The boundary of 1000 items per order is enforced.' }])).toBe(true)
  })
  it('returns true when description mentions null handling', () => {
    expect(hasEdgeCasesCovered([{ ...base, description: 'Null values must return a 400 error.' }])).toBe(true)
  })
})
```

Create `tests/lib/requirements/rules/core/has-permissions-matrix.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { hasPermissionsMatrix } from '@/lib/requirements/rules/core/has-permissions-matrix'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null,
}

describe('hasPermissionsMatrix', () => {
  it('returns false when no permission keywords present', () => {
    expect(hasPermissionsMatrix([{ ...base, description: 'The user submits the form.' }])).toBe(false)
  })
  it('returns true when description mentions permission', () => {
    expect(hasPermissionsMatrix([{ ...base, description: 'Permissions are role-based.' }])).toBe(true)
  })
  it('returns true when description mentions access control', () => {
    expect(hasPermissionsMatrix([{ ...base, description: 'Access control restricts admin features.' }])).toBe(true)
  })
  it('returns true when title mentions authorization', () => {
    expect(hasPermissionsMatrix([{ ...base, title: 'Authorization rules for editors' }])).toBe(true)
  })
})
```

Create `tests/lib/requirements/rules/core/has-external-dependencies.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { hasExternalDependenciesDefined } from '@/lib/requirements/rules/core/has-external-dependencies'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null,
}

describe('hasExternalDependenciesDefined', () => {
  it('returns true when no external systems are mentioned', () => {
    // no external = no gap
    expect(hasExternalDependenciesDefined([{ ...base, description: 'The system stores orders.' }])).toBe(true)
  })
  it('returns false when external system mentioned without a contract', () => {
    expect(hasExternalDependenciesDefined([
      { ...base, description: 'The system integrates with Stripe for payments.' },
    ])).toBe(false)
  })
  it('returns true when external system mentioned AND a contract item exists', () => {
    expect(hasExternalDependenciesDefined([
      { ...base, description: 'The system integrates with Stripe for payments.' },
      { ...base, description: 'The Stripe API contract requires a webhook endpoint at /webhooks/stripe.' },
    ])).toBe(true)
  })
  it('returns true when vendor mentioned and specification item present', () => {
    expect(hasExternalDependenciesDefined([
      { ...base, description: 'The vendor sends data via webhook.' },
      { ...base, description: 'The webhook protocol uses HMAC-SHA256 signatures.' },
    ])).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they all fail**

```bash
npx vitest run tests/lib/requirements/rules/core/
```

Expected: FAIL — all modules not found.

- [ ] **Step 3: Implement the five rules**

Create `lib/requirements/rules/core/has-data-model.ts`:

```typescript
import type { ParsedItem } from '@/lib/requirements/parser'

const KEYWORDS = ['entity', 'model', 'schema', 'table', 'record', 'field', 'attribute', 'data structure', 'database', 'struct', 'store']

export function hasDataModelDefined(items: ParsedItem[]): boolean {
  return items.some(i =>
    KEYWORDS.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k))
  )
}
```

Create `lib/requirements/rules/core/has-input-output-contracts.ts`:

```typescript
import type { ParsedItem } from '@/lib/requirements/parser'

const KEYWORDS = ['input', 'output', 'request', 'response', 'payload', 'api', 'endpoint', 'parameter', 'accepts', 'returns', 'contract']

export function hasInputOutputContracts(items: ParsedItem[]): boolean {
  return items.some(i =>
    KEYWORDS.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k))
  )
}
```

Create `lib/requirements/rules/core/has-edge-cases-covered.ts`:

```typescript
import type { ParsedItem } from '@/lib/requirements/parser'

const KEYWORDS = ['edge case', 'boundary', 'limit', 'maximum', 'minimum', 'overflow', 'empty', 'null', 'zero', 'invalid', 'out of range', 'corner case']

export function hasEdgeCasesCovered(items: ParsedItem[]): boolean {
  return items.some(i =>
    KEYWORDS.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k))
  )
}
```

Create `lib/requirements/rules/core/has-permissions-matrix.ts`:

```typescript
import type { ParsedItem } from '@/lib/requirements/parser'

const KEYWORDS = ['permission', 'access control', 'role-based', 'rbac', 'authorization', 'authorise', 'authorize', 'allowed', 'restricted', 'admin only', 'readonly']

export function hasPermissionsMatrix(items: ParsedItem[]): boolean {
  return items.some(i =>
    KEYWORDS.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k))
  )
}
```

Create `lib/requirements/rules/core/has-external-dependencies.ts`:

```typescript
import type { ParsedItem } from '@/lib/requirements/parser'

const EXTERNAL_KW  = ['third-party', 'external', 'integration', 'vendor', 'stripe', 'twilio', 'sendgrid', 'webhook']
const CONTRACT_KW  = ['contract', 'interface', 'specification', 'protocol', 'format', 'schema', 'sla', 'endpoint', 'signature']

export function hasExternalDependenciesDefined(items: ParsedItem[]): boolean {
  const mentionsExternal = items.some(i =>
    EXTERNAL_KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k))
  )
  if (!mentionsExternal) return true  // no external system mentioned → no gap
  return items.some(i =>
    CONTRACT_KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k))
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/requirements/rules/core/
```

Expected: PASS — all 20 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/requirements/rules/core/ tests/lib/requirements/rules/core/
git commit -m "feat: add 5 new core rules — data-model, io-contracts, edge-cases, permissions, external-deps"
```

---

## Task 8: Domain Rule Packs — SaaS, Fintech, Workflow

**Files:**
- Create: `lib/requirements/rules/saas/has-billing-defined.ts`
- Create: `lib/requirements/rules/saas/has-multi-tenancy-addressed.ts`
- Create: `lib/requirements/rules/saas/has-auth-strategy-defined.ts`
- Create: `lib/requirements/rules/fintech/has-compliance-requirements.ts`
- Create: `lib/requirements/rules/fintech/has-audit-trail-defined.ts`
- Create: `lib/requirements/rules/fintech/has-reconciliation-defined.ts`
- Create: `lib/requirements/rules/workflow/has-rollback-defined.ts`
- Create: `lib/requirements/rules/workflow/has-idempotency-addressed.ts`
- Create: `lib/requirements/rules/workflow/has-retry-strategy-defined.ts`
- Create (tests): all corresponding test files

- [ ] **Step 1: Write failing tests for all nine rules**

Create `tests/lib/requirements/rules/saas/has-billing-defined.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { hasBillingDefined } from '@/lib/requirements/rules/saas/has-billing-defined'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasBillingDefined', () => {
  it('returns false when no billing keywords present', () => {
    expect(hasBillingDefined([{ ...base, description: 'Users can log in.' }])).toBe(false)
  })
  it('returns true when subscription is mentioned', () => {
    expect(hasBillingDefined([{ ...base, description: 'Users can choose a monthly subscription plan.' }])).toBe(true)
  })
  it('returns true when payment is in the title', () => {
    expect(hasBillingDefined([{ ...base, title: 'Payment processing flow' }])).toBe(true)
  })
})
```

Create `tests/lib/requirements/rules/saas/has-multi-tenancy-addressed.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { hasMultiTenancyAddressed } from '@/lib/requirements/rules/saas/has-multi-tenancy-addressed'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasMultiTenancyAddressed', () => {
  it('returns false when no tenancy keywords present', () => {
    expect(hasMultiTenancyAddressed([{ ...base, description: 'Users can create orders.' }])).toBe(false)
  })
  it('returns true when tenant isolation is mentioned', () => {
    expect(hasMultiTenancyAddressed([{ ...base, description: 'Each tenant has isolated data storage.' }])).toBe(true)
  })
  it('returns true when organisation workspace is mentioned', () => {
    expect(hasMultiTenancyAddressed([{ ...base, description: 'Users belong to an organisation workspace.' }])).toBe(true)
  })
})
```

Create `tests/lib/requirements/rules/saas/has-auth-strategy-defined.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { hasAuthStrategyDefined } from '@/lib/requirements/rules/saas/has-auth-strategy-defined'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasAuthStrategyDefined', () => {
  it('returns false when no auth keywords present', () => {
    expect(hasAuthStrategyDefined([{ ...base, description: 'The system exports a CSV report.' }])).toBe(false)
  })
  it('returns true when authentication is mentioned', () => {
    expect(hasAuthStrategyDefined([{ ...base, description: 'Authentication uses JWT tokens.' }])).toBe(true)
  })
  it('returns true when login is mentioned', () => {
    expect(hasAuthStrategyDefined([{ ...base, description: 'Users log in with email and password.' }])).toBe(true)
  })
})
```

Create `tests/lib/requirements/rules/fintech/has-compliance-requirements.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { hasComplianceRequirements } from '@/lib/requirements/rules/fintech/has-compliance-requirements'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasComplianceRequirements', () => {
  it('returns false when no compliance keywords present', () => {
    expect(hasComplianceRequirements([{ ...base, description: 'Users submit payment forms.' }])).toBe(false)
  })
  it('returns true when regulatory compliance is mentioned', () => {
    expect(hasComplianceRequirements([{ ...base, description: 'The system must comply with PCI-DSS regulations.' }])).toBe(true)
  })
  it('returns true when GDPR is mentioned in title', () => {
    expect(hasComplianceRequirements([{ ...base, title: 'GDPR data retention policy' }])).toBe(true)
  })
})
```

Create `tests/lib/requirements/rules/fintech/has-audit-trail-defined.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { hasAuditTrailDefined } from '@/lib/requirements/rules/fintech/has-audit-trail-defined'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasAuditTrailDefined', () => {
  it('returns false when no audit keywords present', () => {
    expect(hasAuditTrailDefined([{ ...base, description: 'Users create accounts.' }])).toBe(false)
  })
  it('returns true when audit trail is mentioned', () => {
    expect(hasAuditTrailDefined([{ ...base, description: 'Every transaction is recorded in the audit trail.' }])).toBe(true)
  })
  it('returns true when transaction log is in title', () => {
    expect(hasAuditTrailDefined([{ ...base, title: 'Transaction log for all financial events' }])).toBe(true)
  })
})
```

Create `tests/lib/requirements/rules/fintech/has-reconciliation-defined.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { hasReconciliationDefined } from '@/lib/requirements/rules/fintech/has-reconciliation-defined'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasReconciliationDefined', () => {
  it('returns false when no reconciliation keywords present', () => {
    expect(hasReconciliationDefined([{ ...base, description: 'Users place orders.' }])).toBe(false)
  })
  it('returns true when reconciliation is mentioned', () => {
    expect(hasReconciliationDefined([{ ...base, description: 'Daily reconciliation verifies account balances.' }])).toBe(true)
  })
  it('returns true when balance check is in description', () => {
    expect(hasReconciliationDefined([{ ...base, description: 'Balance checks run after each settlement.' }])).toBe(true)
  })
})
```

Create `tests/lib/requirements/rules/workflow/has-rollback-defined.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { hasRollbackDefined } from '@/lib/requirements/rules/workflow/has-rollback-defined'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasRollbackDefined', () => {
  it('returns false when no rollback keywords present', () => {
    expect(hasRollbackDefined([{ ...base, description: 'The pipeline processes files.' }])).toBe(false)
  })
  it('returns true when rollback is mentioned', () => {
    expect(hasRollbackDefined([{ ...base, description: 'On failure, the pipeline rolls back all completed steps.' }])).toBe(true)
  })
  it('returns true when compensation is mentioned', () => {
    expect(hasRollbackDefined([{ ...base, description: 'A compensation transaction undoes partial writes.' }])).toBe(true)
  })
})
```

Create `tests/lib/requirements/rules/workflow/has-idempotency-addressed.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { hasIdempotencyAddressed } from '@/lib/requirements/rules/workflow/has-idempotency-addressed'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasIdempotencyAddressed', () => {
  it('returns false when no idempotency keywords present', () => {
    expect(hasIdempotencyAddressed([{ ...base, description: 'The pipeline reads events.' }])).toBe(false)
  })
  it('returns true when idempotency is mentioned', () => {
    expect(hasIdempotencyAddressed([{ ...base, description: 'All operations are idempotent using an idempotency key.' }])).toBe(true)
  })
  it('returns true when duplicate handling is mentioned', () => {
    expect(hasIdempotencyAddressed([{ ...base, description: 'Duplicate events are detected and discarded.' }])).toBe(true)
  })
})
```

Create `tests/lib/requirements/rules/workflow/has-retry-strategy-defined.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { hasRetryStrategyDefined } from '@/lib/requirements/rules/workflow/has-retry-strategy-defined'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasRetryStrategyDefined', () => {
  it('returns false when no retry keywords present', () => {
    expect(hasRetryStrategyDefined([{ ...base, description: 'The job processes tasks sequentially.' }])).toBe(false)
  })
  it('returns true when retry behaviour is described', () => {
    expect(hasRetryStrategyDefined([{ ...base, description: 'Failed tasks are retried up to 3 times with exponential backoff.' }])).toBe(true)
  })
  it('returns true when backoff is in the title', () => {
    expect(hasRetryStrategyDefined([{ ...base, title: 'Exponential backoff for failed webhook deliveries' }])).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they all fail**

```bash
npx vitest run tests/lib/requirements/rules/saas/ tests/lib/requirements/rules/fintech/ tests/lib/requirements/rules/workflow/
```

Expected: FAIL — all modules not found.

- [ ] **Step 3: Implement all nine rule files**

Create `lib/requirements/rules/saas/has-billing-defined.ts`:

```typescript
import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['billing', 'payment', 'subscription', 'pricing', 'invoice', 'charge', 'plan', 'tier', 'upgrade', 'downgrade']
export function hasBillingDefined(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
```

Create `lib/requirements/rules/saas/has-multi-tenancy-addressed.ts`:

```typescript
import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['tenant', 'tenancy', 'multi-tenant', 'isolation', 'workspace', 'organisation', 'organization', 'account', 'single-tenant']
export function hasMultiTenancyAddressed(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
```

Create `lib/requirements/rules/saas/has-auth-strategy-defined.ts`:

```typescript
import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['authentication', 'login', 'sign in', 'session', 'token', 'oauth', 'sso', 'jwt', 'password', 'credential']
export function hasAuthStrategyDefined(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
```

Create `lib/requirements/rules/fintech/has-compliance-requirements.ts`:

```typescript
import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['compliance', 'regulatory', 'regulation', 'pci', 'gdpr', 'sox', 'aml', 'kyc', 'fca', 'legal requirement']
export function hasComplianceRequirements(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
```

Create `lib/requirements/rules/fintech/has-audit-trail-defined.ts`:

```typescript
import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['audit trail', 'audit log', 'transaction log', 'event log', 'ledger', 'immutable record', 'transaction history']
export function hasAuditTrailDefined(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
```

Create `lib/requirements/rules/fintech/has-reconciliation-defined.ts`:

```typescript
import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['reconciliation', 'reconcile', 'balance check', 'settlement', 'net position', 'discrepancy']
export function hasReconciliationDefined(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
```

Create `lib/requirements/rules/workflow/has-rollback-defined.ts`:

```typescript
import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['rollback', 'roll back', 'undo', 'revert', 'compensation', 'compensating transaction', 'saga']
export function hasRollbackDefined(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
```

Create `lib/requirements/rules/workflow/has-idempotency-addressed.ts`:

```typescript
import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['idempoten', 'idempotency key', 'duplicate', 'deduplication', 'exactly-once', 'at-most-once']
export function hasIdempotencyAddressed(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
```

Create `lib/requirements/rules/workflow/has-retry-strategy-defined.ts`:

```typescript
import type { ParsedItem } from '@/lib/requirements/parser'
const KW = ['retry', 'retries', 'backoff', 'exponential backoff', 'dead letter', 'dlq', 'max attempts']
export function hasRetryStrategyDefined(items: ParsedItem[]): boolean {
  return items.some(i => KW.some(k => i.title.toLowerCase().includes(k) || i.description.toLowerCase().includes(k)))
}
```

- [ ] **Step 4: Run tests to verify they all pass**

```bash
npx vitest run tests/lib/requirements/rules/saas/ tests/lib/requirements/rules/fintech/ tests/lib/requirements/rules/workflow/
```

Expected: PASS — all 27 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/requirements/rules/saas/ lib/requirements/rules/fintech/ lib/requirements/rules/workflow/ tests/lib/requirements/rules/saas/ tests/lib/requirements/rules/fintech/ tests/lib/requirements/rules/workflow/
git commit -m "feat: add SaaS, Fintech, and Workflow domain rule packs (9 rules)"
```

---

## Task 9: Rule Index + `selectRulePack`

**Files:**
- Create: `lib/requirements/rules/index.ts`
- Create: `tests/lib/requirements/rules/rule-index.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/requirements/rules/rule-index.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { selectRulePack } from '@/lib/requirements/rules/index'

describe('selectRulePack', () => {
  it('returns 10 rules for domain=general', () => {
    const rules = selectRulePack('general')
    expect(rules).toHaveLength(10)
  })

  it('returns 10 rules for domain=null (defaults to general)', () => {
    const rules = selectRulePack(null)
    expect(rules).toHaveLength(10)
  })

  it('returns 13 rules for domain=saas (10 core + 3 saas)', () => {
    const rules = selectRulePack('saas')
    expect(rules).toHaveLength(13)
  })

  it('returns 13 rules for domain=fintech (10 core + 3 fintech)', () => {
    const rules = selectRulePack('fintech')
    expect(rules).toHaveLength(13)
  })

  it('returns 13 rules for domain=workflow (10 core + 3 workflow)', () => {
    const rules = selectRulePack('workflow')
    expect(rules).toHaveLength(13)
  })

  it('every rule has id, check, severity, category, description', () => {
    const rules = selectRulePack('saas')
    for (const rule of rules) {
      expect(typeof rule.id).toBe('string')
      expect(typeof rule.check).toBe('function')
      expect(['critical', 'major', 'minor']).toContain(rule.severity)
      expect(typeof rule.description).toBe('string')
    }
  })

  it('saas pack contains hasBillingDefined rule', () => {
    const rules = selectRulePack('saas')
    expect(rules.some(r => r.id === 'hasBillingDefined')).toBe(true)
  })

  it('fintech pack contains hasAuditTrailDefined rule', () => {
    const rules = selectRulePack('fintech')
    expect(rules.some(r => r.id === 'hasAuditTrailDefined')).toBe(true)
  })

  it('general pack does NOT contain domain-specific rules', () => {
    const rules = selectRulePack('general')
    const ids = rules.map(r => r.id)
    expect(ids).not.toContain('hasBillingDefined')
    expect(ids).not.toContain('hasRollbackDefined')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/requirements/rules/rule-index.test.ts
```

Expected: FAIL — `selectRulePack` not found.

- [ ] **Step 3: Create `lib/requirements/rules/index.ts`**

```typescript
// lib/requirements/rules/index.ts
import type { ParsedItem } from '@/lib/requirements/parser'
import type { RequirementDomain } from '@/lib/supabase/types'

// Existing core rules (unchanged location)
import { hasActorsDefined }             from './has-actors-defined'
import { hasApprovalRole }              from './has-approval-role'
import { hasWorkflowStates }            from './has-workflow-states'
import { hasNonFunctionalRequirements } from './has-nfrs'
import { hasErrorHandling }             from './has-error-handling'
// New core rules
import { hasDataModelDefined }          from './core/has-data-model'
import { hasInputOutputContracts }      from './core/has-input-output-contracts'
import { hasEdgeCasesCovered }          from './core/has-edge-cases-covered'
import { hasPermissionsMatrix }         from './core/has-permissions-matrix'
import { hasExternalDependenciesDefined } from './core/has-external-dependencies'
// Domain packs
import { hasBillingDefined }            from './saas/has-billing-defined'
import { hasMultiTenancyAddressed }     from './saas/has-multi-tenancy-addressed'
import { hasAuthStrategyDefined }       from './saas/has-auth-strategy-defined'
import { hasComplianceRequirements }    from './fintech/has-compliance-requirements'
import { hasAuditTrailDefined }         from './fintech/has-audit-trail-defined'
import { hasReconciliationDefined }     from './fintech/has-reconciliation-defined'
import { hasRollbackDefined }           from './workflow/has-rollback-defined'
import { hasIdempotencyAddressed }      from './workflow/has-idempotency-addressed'
import { hasRetryStrategyDefined }      from './workflow/has-retry-strategy-defined'

export interface RuleCheck {
  id: string
  check: (items: ParsedItem[]) => boolean
  severity: 'critical' | 'major' | 'minor'
  category: 'missing'
  description: string
}

const CORE_RULES: RuleCheck[] = [
  { id: 'hasActorsDefined',             check: hasActorsDefined,             severity: 'critical', category: 'missing', description: 'No user roles or system actors are defined.' },
  { id: 'hasApprovalRole',              check: hasApprovalRole,              severity: 'critical', category: 'missing', description: 'No approval or sign-off role is defined.' },
  { id: 'hasWorkflowStates',            check: hasWorkflowStates,            severity: 'critical', category: 'missing', description: 'No system states or status transitions are defined.' },
  { id: 'hasNonFunctionalRequirements', check: hasNonFunctionalRequirements, severity: 'major',    category: 'missing', description: 'No non-functional requirements are specified.' },
  { id: 'hasErrorHandling',             check: hasErrorHandling,             severity: 'major',    category: 'missing', description: 'No error handling or failure scenarios are addressed.' },
  { id: 'hasDataModelDefined',          check: hasDataModelDefined,          severity: 'major',    category: 'missing', description: 'No data entities or data structures are defined.' },
  { id: 'hasInputOutputContracts',      check: hasInputOutputContracts,      severity: 'major',    category: 'missing', description: 'No inputs, outputs, or API contracts are defined.' },
  { id: 'hasEdgeCasesCovered',          check: hasEdgeCasesCovered,          severity: 'minor',    category: 'missing', description: 'No boundary or edge-case behaviour is addressed.' },
  { id: 'hasPermissionsMatrix',         check: hasPermissionsMatrix,         severity: 'major',    category: 'missing', description: 'No access control or permissions are defined.' },
  { id: 'hasExternalDependenciesDefined', check: hasExternalDependenciesDefined, severity: 'major', category: 'missing', description: 'External system mentioned without a defined contract.' },
]

const SAAS_RULES: RuleCheck[] = [
  { id: 'hasBillingDefined',        check: hasBillingDefined,        severity: 'critical', category: 'missing', description: 'No billing, pricing, or subscription items defined.' },
  { id: 'hasMultiTenancyAddressed', check: hasMultiTenancyAddressed, severity: 'major',    category: 'missing', description: 'Multi-tenancy or tenant isolation is not addressed.' },
  { id: 'hasAuthStrategyDefined',   check: hasAuthStrategyDefined,   severity: 'critical', category: 'missing', description: 'No authentication or session handling strategy defined.' },
]

const FINTECH_RULES: RuleCheck[] = [
  { id: 'hasComplianceRequirements', check: hasComplianceRequirements, severity: 'critical', category: 'missing', description: 'No regulatory or compliance requirements defined.' },
  { id: 'hasAuditTrailDefined',      check: hasAuditTrailDefined,      severity: 'critical', category: 'missing', description: 'No audit trail or transaction log defined.' },
  { id: 'hasReconciliationDefined',  check: hasReconciliationDefined,  severity: 'major',    category: 'missing', description: 'No reconciliation or balance check process defined.' },
]

const WORKFLOW_RULES: RuleCheck[] = [
  { id: 'hasRollbackDefined',       check: hasRollbackDefined,       severity: 'major', category: 'missing', description: 'No rollback or compensation defined for failed transitions.' },
  { id: 'hasIdempotencyAddressed',  check: hasIdempotencyAddressed,  severity: 'major', category: 'missing', description: 'No duplicate handling or idempotency strategy defined.' },
  { id: 'hasRetryStrategyDefined',  check: hasRetryStrategyDefined,  severity: 'major', category: 'missing', description: 'No retry behaviour defined for failures.' },
]

export function selectRulePack(domain: RequirementDomain | null): RuleCheck[] {
  switch (domain) {
    case 'saas':     return [...CORE_RULES, ...SAAS_RULES]
    case 'fintech':  return [...CORE_RULES, ...FINTECH_RULES]
    case 'workflow': return [...CORE_RULES, ...WORKFLOW_RULES]
    default:         return CORE_RULES
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/requirements/rules/rule-index.test.ts
```

Expected: PASS — all 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/requirements/rules/index.ts tests/lib/requirements/rules/rule-index.test.ts
git commit -m "feat: add rule index with selectRulePack — wires core + domain packs"
```

---

## Task 10: Gap Detector v2 — Domain Packs + Validation Defaults

The gap detector already exists. This task updates it to: (1) accept a `domain` parameter to select the right rule pack, (2) stamp `validated: true` on rule gaps and `validated: false` on AI gaps, (3) add `validated` to `DetectedGap`.

**Files:**
- Modify: `lib/requirements/gap-detector.ts`
- Modify: `tests/lib/requirements/gap-detector.test.ts`

- [ ] **Step 1: Read the current gap-detector tests**

```bash
cat tests/lib/requirements/gap-detector.test.ts
```

Note the test structure, then update tests to cover the new behaviour.

- [ ] **Step 2: Add new test cases covering domain packs and validated defaults**

In `tests/lib/requirements/gap-detector.test.ts`, add these test cases (keep all existing tests):

```typescript
import { selectRulePack } from '@/lib/requirements/rules/index'

// ...existing tests remain...

describe('detectGaps — domain packs', () => {
  it('fires hasBillingDefined for saas domain when no billing item present', async () => {
    const items: ParsedItem[] = [
      { type: 'functional', title: 'Login', description: 'User logs in with email.', priority: 'high', source_text: null, nfr_category: null },
    ]
    const mock = new MockAIProvider()
    mock.setDefaultResponse('{"gaps":[]}')
    const result = await detectGaps(items, 'saas', mock)
    expect(result.gaps.some(g => g.rule_id === 'hasBillingDefined')).toBe(true)
  })

  it('does NOT fire hasBillingDefined for general domain', async () => {
    const items: ParsedItem[] = [
      { type: 'functional', title: 'Login', description: 'User logs in.', priority: 'high', source_text: null, nfr_category: null },
    ]
    const mock = new MockAIProvider()
    mock.setDefaultResponse('{"gaps":[]}')
    const result = await detectGaps(items, 'general', mock)
    expect(result.gaps.some(g => g.rule_id === 'hasBillingDefined')).toBe(false)
  })
})

describe('detectGaps — validated defaults', () => {
  it('rule gaps have validated=true', async () => {
    const items: ParsedItem[] = [
      { type: 'functional', title: 'Process order', description: 'System processes orders.', priority: 'high', source_text: null, nfr_category: null },
    ]
    const mock = new MockAIProvider()
    mock.setDefaultResponse('{"gaps":[]}')
    const result = await detectGaps(items, null, mock)
    const ruleGaps = result.gaps.filter(g => g.source === 'rule')
    expect(ruleGaps.length).toBeGreaterThan(0)
    expect(ruleGaps.every(g => g.validated === true)).toBe(true)
  })

  it('AI gaps have validated=false', async () => {
    const items: ParsedItem[] = [
      { type: 'functional', title: 'Admin user', description: 'Admin approves orders, defines workflow states.', priority: 'high', source_text: null, nfr_category: null },
    ]
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ gaps: [{ severity: 'major', category: 'ambiguous', description: 'Role scope unclear.', confidence: 80 }] }))
    const result = await detectGaps(items, null, mock)
    const aiGaps = result.gaps.filter(g => g.source === 'ai')
    expect(aiGaps.length).toBeGreaterThan(0)
    expect(aiGaps.every(g => g.validated === false)).toBe(true)
  })
})
```

- [ ] **Step 3: Run tests to verify new tests fail**

```bash
npx vitest run tests/lib/requirements/gap-detector.test.ts
```

Expected: new tests FAIL — `detectGaps` doesn't accept `domain` yet; `validated` field missing.

- [ ] **Step 4: Update `lib/requirements/gap-detector.ts`**

Replace the entire file:

```typescript
// lib/requirements/gap-detector.ts
import type { AIProvider } from '@/lib/ai/provider'
import { buildDetectGapsPrompt, DETECT_GAPS_SCHEMA } from '@/lib/ai/prompts/detect-gaps'
import type { ParsedItem } from '@/lib/requirements/parser'
import { selectRulePack } from '@/lib/requirements/rules/index'
import type { GapCategory, GapSeverity, GapSource, RequirementDomain } from '@/lib/supabase/types'

export interface DetectedGap {
  item_id: string | null
  severity: GapSeverity
  category: GapCategory
  description: string
  source: GapSource
  rule_id: string | null
  priority_score: number
  confidence: number
  validated: boolean   // rule + relation = true; ai = false
  question_generated: boolean
}

export interface MergedPair {
  survivorIndex: number
  mergedIndex: number
}

export interface GapDetectionResult {
  gaps: DetectedGap[]
  mergedPairs: MergedPair[]
}

const IMPACT: Record<GapSeverity, number>      = { critical: 3, major: 2, minor: 1 }
const UNCERTAINTY: Record<GapCategory, number> = { missing: 3, ambiguous: 2, conflicting: 2, incomplete: 1 }

function priorityScore(severity: GapSeverity, category: GapCategory): number {
  return IMPACT[severity] * UNCERTAINTY[category]
}

function runRules(items: ParsedItem[], domain: RequirementDomain | null): DetectedGap[] {
  const pack = selectRulePack(domain)
  const gaps: DetectedGap[] = []
  for (const rule of pack) {
    if (!rule.check(items)) {
      gaps.push({
        item_id: null,
        severity: rule.severity,
        category: rule.category,
        description: rule.description,
        source: 'rule',
        rule_id: rule.id,
        priority_score: priorityScore(rule.severity, rule.category),
        confidence: 100,
        validated: true,   // deterministic check — auto-validated
        question_generated: false,
      })
    }
  }
  return gaps
}

function computeMerges(gaps: DetectedGap[]): MergedPair[] {
  const groups = new Map<string, number[]>()
  gaps.forEach((gap, idx) => {
    const key = `${gap.category}::${gap.item_id ?? 'null'}`
    const existing = groups.get(key) ?? []
    existing.push(idx)
    groups.set(key, existing)
  })

  const pairs: MergedPair[] = []
  for (const indices of groups.values()) {
    if (indices.length < 2) continue
    const sorted = [...indices].sort((a, b) => IMPACT[gaps[b].severity] - IMPACT[gaps[a].severity])
    const survivorIndex = sorted[0]
    for (let i = 1; i < sorted.length; i++) {
      pairs.push({ survivorIndex, mergedIndex: sorted[i] })
    }
  }
  return pairs
}

export async function detectGaps(
  items: ParsedItem[],
  domain: RequirementDomain | null,
  ai: AIProvider
): Promise<GapDetectionResult> {
  const ruleGaps = runRules(items, domain)

  const itemsJson = JSON.stringify(items.map((item, i) => ({ id: `item-${i}`, ...item })))
  const prompt = buildDetectGapsPrompt(itemsJson)
  const result = await ai.complete(prompt, { responseSchema: DETECT_GAPS_SCHEMA })
  const parsed = JSON.parse(result.content) as { gaps: Array<{
    item_id?: string | null
    severity: GapSeverity
    category: GapCategory
    description: string
    confidence: number
  }> }

  const aiGaps: DetectedGap[] = parsed.gaps.map(g => ({
    item_id: g.item_id ?? null,
    severity: g.severity,
    category: g.category,
    description: g.description,
    source: 'ai' as GapSource,
    rule_id: null,
    priority_score: priorityScore(g.severity, g.category),
    confidence: g.confidence,
    validated: false,   // AI suggestion — requires human validation
    question_generated: false,
  }))

  const allGaps = [...ruleGaps, ...aiGaps].sort((a, b) => b.priority_score - a.priority_score)
  const mergedPairs = computeMerges(allGaps)

  return { gaps: allGaps, mergedPairs }
}
```

- [ ] **Step 5: Update `lib/requirements/pipeline.ts` to pass `domain` to `detectGaps`**

In `pipeline.ts`, the call to `detectGaps(parsedItems, ai)` must become `detectGaps(parsedItems, domain, ai)` where `domain` comes from the parsed items result (the parser extracts domain — verify by reading `lib/requirements/parser.ts`). Also update the `gap.validated` field in the `.insert()` call:

```typescript
// In the gaps insert block, add validated:
await db.from('gaps').insert(
  allGaps.map(g => ({
    requirement_id: requirementId,
    item_id: g.item_id,
    severity: g.severity,
    category: g.category,
    description: g.description,
    source: g.source,
    rule_id: g.rule_id,
    priority_score: g.priority_score,
    confidence: g.confidence,
    validated: g.validated,   // new
    question_generated: false,
    merged_into: null,
  }))
)
```

Also update requirements after parse to store domain:

```typescript
// After parsedItems is populated, update the requirement with domain:
if (parsedDomain) {
  await db.from('requirements').update({ domain: parsedDomain }).eq('id', requirementId)
}
```

Read `lib/requirements/parser.ts` to confirm the parser returns domain in its result, then wire it through `pipeline.ts` accordingly.

- [ ] **Step 6: Run all tests**

```bash
npx vitest run
```

Expected: all tests pass. Fix any remaining TypeScript/runtime errors from the `domain` parameter being missing in test call sites — update them to pass `null` as the domain argument.

- [ ] **Step 7: Run TypeScript compiler check**

```bash
npx tsc --noEmit 2>&1 | head -40
```

Expected: zero errors.

- [ ] **Step 8: Commit**

```bash
git add lib/requirements/gap-detector.ts lib/requirements/pipeline.ts tests/lib/requirements/gap-detector.test.ts
git commit -m "feat: upgrade gap-detector to use domain rule packs and stamp validated defaults per source"
```

---

## Task 11: Pipeline — Log to `ai_usage_log`

This is a small, isolated addition to `pipeline.ts`: after each AI call in the pipeline, write the `CompletionResult` metadata to `ai_usage_log`.

**Files:**
- Modify: `lib/requirements/pipeline.ts`

- [ ] **Step 1: Add `writeAiUsage` helper and call it after each step**

In `lib/requirements/pipeline.ts`, add this helper near `writeAudit`:

```typescript
async function writeAiUsage(
  db: SupabaseClient,
  requirementId: string,
  step: string,
  result: import('@/lib/ai/provider').CompletionResult
) {
  try {
    await db.from('ai_usage_log').insert({
      requirement_id: requirementId,
      pipeline_step: step,
      provider: result.provider,
      model: result.model,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      latency_ms: result.latencyMs,
      retry_count: result.retryCount,
    })
  } catch {
    // usage logging must never abort the pipeline
  }
}
```

The `parseRequirements`, `detectGaps`, etc. functions currently don't surface the `CompletionResult` — they call `ai.complete()` internally. Rather than refactoring all modules to return token counts (that's Plan E scope), add a lightweight wrapper to the `ai` object passed to the pipeline that intercepts calls and logs them:

```typescript
function loggingProvider(
  ai: AIProvider,
  db: SupabaseClient,
  requirementId: string,
  step: string
): AIProvider {
  return {
    async complete(prompt, options) {
      const result = await ai.complete(prompt, options)
      await writeAiUsage(db, requirementId, step, result)
      return result
    },
  }
}
```

Then in each pipeline step, wrap the `ai` passed to the library function:

```typescript
// Step 1: Parse
parsedItems = await parseRequirements(rawInput, loggingProvider(ai, db, requirementId, 'parse'))

// Step 2: Detect gaps
const detection = await detectGaps(parsedItems, domain, loggingProvider(ai, db, requirementId, 'detect_gaps'))

// Step 3: Questions
const questions = await generateQuestions(allGaps, mergedIndices, parsedItems, loggingProvider(ai, db, requirementId, 'generate_questions'))
```

- [ ] **Step 2: Run the full test suite**

```bash
npx vitest run
```

Expected: PASS — logging is non-throwing, tests should be unaffected.

- [ ] **Step 3: Commit**

```bash
git add lib/requirements/pipeline.ts
git commit -m "feat: log AI usage (tokens, latency, retries) to ai_usage_log per pipeline step"
```

---

## Task 12: Final Verification

- [ ] **Step 1: Run the full test suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Verify test count has grown**

```bash
npx vitest run --reporter=verbose 2>&1 | tail -5
```

Expected: significantly more tests than before (new rule tests alone add ~30+).

- [ ] **Step 4: Final commit**

```bash
git add -A
git status  # verify only expected files
git commit -m "chore: plan-d complete — v2 infrastructure (DB, types, AI provider, rule packs, gap-detector)"
```

---

## Self-Review

**Spec coverage check:**

| v2 change | Covered in Plan D |
|---|---|
| pgvector + knowledge_cases table | ✅ Task 1 |
| requirement_relations table | ✅ Task 1 |
| risk_acceptances table | ✅ Task 1 |
| ai_usage_log table | ✅ Task 1 |
| completeness_scores v2 columns | ✅ Task 1 |
| `domain` field on requirements | ✅ Task 1 + Task 2 |
| `validated` / `validated_by` on gaps | ✅ Task 1 + Task 2 |
| Types overhaul | ✅ Task 2 |
| CompletionResult return type | ✅ Task 3 |
| AIProviderError | ✅ Task 3 |
| JSON repair (repair.ts) | ✅ Task 3 |
| Retry + timeout on Claude adapter | ✅ Task 5 |
| Retry + timeout on OpenAI adapter | ✅ Task 5 |
| ai_usage_log writes in pipeline | ✅ Task 11 |
| 5 new core rules | ✅ Task 7 |
| SaaS domain pack (3 rules) | ✅ Task 8 |
| Fintech domain pack (3 rules) | ✅ Task 8 |
| Workflow domain pack (3 rules) | ✅ Task 8 |
| selectRulePack() | ✅ Task 9 |
| Gap detector uses domain packs | ✅ Task 10 |
| validated=true for rule gaps | ✅ Task 10 |
| validated=false for AI gaps | ✅ Task 10 |

**Deferred to Plan E (as intended):**
- Relation detection + Layer C
- Gap validation API (PATCH /api/gaps/[id])
- Risk acceptance API
- Scoring v2 (blocking_count, coverage_pct, risk flags)
- Knowledge layer (case-store, retriever, feedback)
- Risk predictor
- Partial re-evaluation v2
- Summary API v2 + UI updates
- Gaps view v2 (validate/dismiss/accept-risk)
- Structured view v2 (relationship badges)

**fallbackProvider**: Defined in `CompletionOptions` types but implementation deferred — the spec lists it but the registry pattern makes it a Plan E concern when the pipeline integrates it. Adapters throw `AIProviderError`; the registry can wrap with fallback logic in Plan E.
