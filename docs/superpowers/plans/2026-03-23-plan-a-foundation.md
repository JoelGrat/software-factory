# Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the Next.js project, create all Supabase tables, implement the model-agnostic AI provider interface with Claude, OpenAI, and mock adapters, and set up basic Supabase auth.

**Architecture:** Next.js 14 App Router with TypeScript. Supabase handles Postgres, auth, and realtime. The AI provider interface (`lib/ai/provider.ts`) defines a single `complete()` contract — all pipeline code uses this interface and never calls a model SDK directly. The active provider is selected at startup via `AI_PROVIDER` env var.

**Tech Stack:** Next.js 14, TypeScript, Supabase (postgres + auth), Vitest, `@anthropic-ai/sdk`, `openai`

---

## File Map

**Created in this plan:**
- `package.json` — project deps
- `.env.local.example` — env var template
- `vitest.config.ts` — test config
- `supabase/migrations/001_initial_schema.sql` — all tables
- `lib/ai/provider.ts` — AIProvider interface + types
- `lib/ai/registry.ts` — provider registry (reads `AI_PROVIDER` env)
- `lib/ai/adapters/mock.ts` — deterministic mock (used in all tests)
- `lib/ai/adapters/claude.ts` — Anthropic Claude adapter
- `lib/ai/adapters/openai.ts` — OpenAI adapter
- `lib/supabase/client.ts` — browser Supabase client
- `lib/supabase/server.ts` — server Supabase client (for API routes)
- `lib/supabase/types.ts` — hand-written DB types (one type per table)
- `app/(auth)/login/page.tsx` — login page
- `app/(auth)/signup/page.tsx` — signup page
- `app/(auth)/layout.tsx` — auth layout
- `tests/setup.ts` — global Vitest setup
- `app/layout.tsx` — root layout
- `app/page.tsx` — root redirect
- `middleware.ts` — Supabase auth session refresh
- `tests/lib/ai/provider.test.ts` — provider interface contract tests
- `tests/lib/ai/adapters/mock.test.ts` — mock adapter tests

---

## Task 1: Initialize Next.js Project

**Files:** `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.local.example`

- [ ] **Step 1: Scaffold Next.js app**

```bash
cd /c/Users/joelg/softwareFactory_git
npx create-next-app@14 . --typescript --app --tailwind --eslint --src-dir=false --import-alias="@/*" --yes
```

Expected: Next.js project created with App Router, TypeScript, Tailwind.

- [ ] **Step 2: Install additional dependencies**

```bash
npm install @supabase/supabase-js @supabase/ssr @anthropic-ai/sdk openai
npm install -D vitest @vitejs/plugin-react jsdom @vitest/coverage-v8
```

- [ ] **Step 3: Configure Vitest**

Create `vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
```

Create `tests/setup.ts`:
```typescript
// global test setup — add shared mocks here later
```

- [ ] **Step 4: Add test script to package.json**

In `package.json`, add to `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

- [ ] **Step 5: Create env template**

Create `.env.local.example`:
```
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# AI Provider — one of: claude | openai | mock
AI_PROVIDER=claude

# Claude (if AI_PROVIDER=claude)
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI (if AI_PROVIDER=openai)
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
```

Copy to `.env.local` and fill in your Supabase credentials.

- [ ] **Step 6: Verify dev server starts**

```bash
npm run dev
```

Expected: Server starts on http://localhost:3000 with no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: scaffold Next.js 14 project with Vitest"
```

---

## Task 2: Supabase Database Migration

**Files:** `supabase/migrations/001_initial_schema.sql`

- [ ] **Step 1: Initialize Supabase CLI and create migration file**

```bash
npx supabase init
```

Expected: creates `supabase/config.toml`.

```bash
mkdir -p supabase/migrations
```

Create `supabase/migrations/001_initial_schema.sql`:

```sql
-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Projects
create table projects (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Requirements documents
create table requirements (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  raw_input text not null default '',
  status text not null default 'draft'
    check (status in ('draft','analyzing','incomplete','review_required','ready_for_dev','blocked')),
  blocked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Structured requirement items
create table requirement_items (
  id uuid primary key default uuid_generate_v4(),
  requirement_id uuid not null references requirements(id) on delete cascade,
  type text not null check (type in ('functional','non-functional','constraint','assumption')),
  title text not null,
  description text not null,
  priority text not null check (priority in ('high','medium','low')),
  source_text text,
  nfr_category text check (nfr_category in ('security','performance','auditability')),
  created_at timestamptz not null default now()
);

-- Detected gaps
create table gaps (
  id uuid primary key default uuid_generate_v4(),
  requirement_id uuid not null references requirements(id) on delete cascade,
  item_id uuid references requirement_items(id) on delete set null,
  severity text not null check (severity in ('critical','major','minor')),
  category text not null check (category in ('missing','ambiguous','conflicting','incomplete')),
  description text not null,
  source text not null check (source in ('rule','ai','pattern')),
  rule_id text,
  priority_score integer not null default 0,
  confidence integer not null default 100 check (confidence between 0 and 100),
  question_generated boolean not null default false,
  merged_into uuid references gaps(id) on delete set null,
  resolved_at timestamptz,
  resolution_source text check (resolution_source in ('question_answered','task_resolved','decision_recorded')),
  created_at timestamptz not null default now()
);

-- Clarifying questions
create table questions (
  id uuid primary key default uuid_generate_v4(),
  gap_id uuid not null references gaps(id) on delete cascade,
  requirement_id uuid not null references requirements(id) on delete cascade,
  question_text text not null,
  target_role text not null check (target_role in ('ba','architect','po','dev')),
  status text not null default 'open' check (status in ('open','answered','dismissed')),
  answer text,
  answered_at timestamptz,
  created_at timestamptz not null default now()
);

-- Investigation tasks
create table investigation_tasks (
  id uuid primary key default uuid_generate_v4(),
  requirement_id uuid not null references requirements(id) on delete cascade,
  linked_gap_id uuid references gaps(id) on delete set null,
  title text not null,
  description text not null,
  priority text not null check (priority in ('high','medium','low')),
  status text not null default 'open' check (status in ('open','in-progress','resolved','dismissed')),
  created_at timestamptz not null default now()
);

-- Audit log (append-only)
create table audit_log (
  id uuid primary key default uuid_generate_v4(),
  entity_type text not null,
  entity_id uuid not null,
  action text not null check (action in ('created','updated','deleted','analyzed','scored')),
  actor_id uuid references auth.users(id) on delete set null,
  diff jsonb,
  created_at timestamptz not null default now()
);

-- Decision log
create table decision_log (
  id uuid primary key default uuid_generate_v4(),
  requirement_id uuid not null references requirements(id) on delete cascade,
  related_gap_id uuid references gaps(id) on delete set null,
  related_question_id uuid references questions(id) on delete set null,
  decision text not null check (length(decision) > 0),
  rationale text not null check (length(rationale) > 0),
  decided_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

-- Completeness scores (versioned)
create table completeness_scores (
  id uuid primary key default uuid_generate_v4(),
  requirement_id uuid not null references requirements(id) on delete cascade,
  overall_score integer not null check (overall_score between 0 and 100),
  completeness integer not null check (completeness between 0 and 100),
  nfr_score integer not null check (nfr_score between 0 and 100),
  confidence integer not null check (confidence between 0 and 100),
  breakdown jsonb not null,
  scored_at timestamptz not null default now()
);

-- Knowledge: gap patterns
create table gap_patterns (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  category text not null check (category in ('missing','ambiguous','conflicting','incomplete')),
  severity text not null check (severity in ('critical','major','minor')),
  description_template text not null,
  occurrence_count integer not null default 1,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Knowledge: resolution patterns
create table resolution_patterns (
  id uuid primary key default uuid_generate_v4(),
  gap_pattern_id uuid not null references gap_patterns(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  resolution_summary text not null,
  source_decision_id uuid references decision_log(id) on delete set null,
  use_count integer not null default 0,
  created_at timestamptz not null default now()
);

-- Knowledge: domain templates
create table domain_templates (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  domain text not null,
  name text not null,
  requirement_areas jsonb not null,
  created_at timestamptz not null default now()
);

-- Indexes for common queries
create index on gaps(requirement_id);
create index on gaps(resolved_at) where resolved_at is null;
create index on questions(requirement_id);
create index on questions(gap_id);
create index on investigation_tasks(requirement_id);
create index on audit_log(entity_id);
create index on completeness_scores(requirement_id, scored_at desc);
create index on gap_patterns(project_id, category);

-- Row Level Security
alter table projects enable row level security;
alter table requirements enable row level security;
alter table requirement_items enable row level security;
alter table gaps enable row level security;
alter table questions enable row level security;
alter table investigation_tasks enable row level security;
alter table audit_log enable row level security;
alter table decision_log enable row level security;
alter table completeness_scores enable row level security;
alter table gap_patterns enable row level security;
alter table resolution_patterns enable row level security;
alter table domain_templates enable row level security;

-- RLS policies: project owner can do everything; team access is Phase 2
create policy "owner_all" on projects for all using (owner_id = auth.uid());
create policy "project_member_requirements" on requirements for all
  using (project_id in (select id from projects where owner_id = auth.uid()));
create policy "project_member_items" on requirement_items for all
  using (requirement_id in (
    select r.id from requirements r
    join projects p on p.id = r.project_id
    where p.owner_id = auth.uid()
  ));
-- (Same pattern for remaining tables — omitted for brevity, applied below)
create policy "via_requirement" on gaps for all
  using (requirement_id in (
    select r.id from requirements r join projects p on p.id = r.project_id where p.owner_id = auth.uid()
  ));
create policy "via_requirement" on questions for all
  using (requirement_id in (
    select r.id from requirements r join projects p on p.id = r.project_id where p.owner_id = auth.uid()
  ));
create policy "via_requirement" on investigation_tasks for all
  using (requirement_id in (
    select r.id from requirements r join projects p on p.id = r.project_id where p.owner_id = auth.uid()
  ));
-- audit_log: allow access when entity_id matches any owned project, requirement, gap, question, or task
create policy "via_project_ownership" on audit_log for all
  using (
    entity_id in (select id from projects where owner_id = auth.uid())
    or entity_id in (
      select r.id from requirements r join projects p on p.id = r.project_id where p.owner_id = auth.uid()
    )
    or entity_id in (
      select g.id from gaps g
      join requirements r on r.id = g.requirement_id
      join projects p on p.id = r.project_id
      where p.owner_id = auth.uid()
    )
    or entity_id in (
      select q.id from questions q
      join requirements r on r.id = q.requirement_id
      join projects p on p.id = r.project_id
      where p.owner_id = auth.uid()
    )
    or entity_id in (
      select t.id from investigation_tasks t
      join requirements r on r.id = t.requirement_id
      join projects p on p.id = r.project_id
      where p.owner_id = auth.uid()
    )
  );
create policy "via_requirement" on decision_log for all
  using (requirement_id in (
    select r.id from requirements r join projects p on p.id = r.project_id where p.owner_id = auth.uid()
  ));
create policy "via_requirement" on completeness_scores for all
  using (requirement_id in (
    select r.id from requirements r join projects p on p.id = r.project_id where p.owner_id = auth.uid()
  ));
create policy "project_scoped" on gap_patterns for all
  using (project_id is null or project_id in (select id from projects where owner_id = auth.uid()));
create policy "project_scoped" on resolution_patterns for all
  using (project_id is null or project_id in (select id from projects where owner_id = auth.uid()));
create policy "project_scoped" on domain_templates for all
  using (project_id is null or project_id in (select id from projects where owner_id = auth.uid()));
```

- [ ] **Step 2: Run migration in Supabase**

Open your Supabase project → SQL Editor → paste the migration → Run.

Verify: All 13 tables appear in Table Editor.

- [ ] **Step 3: Commit**

```bash
git add supabase/
git commit -m "feat: add initial Supabase schema migration"
```

---

## Task 3: Supabase Client + Types

**Files:** `lib/supabase/client.ts`, `lib/supabase/server.ts`, `lib/supabase/types.ts`

- [ ] **Step 1: Write types**

Create `lib/supabase/types.ts`:
```typescript
export type RequirementStatus =
  | 'draft'
  | 'analyzing'
  | 'incomplete'
  | 'review_required'
  | 'ready_for_dev'
  | 'blocked'

export type GapSeverity = 'critical' | 'major' | 'minor'
export type GapCategory = 'missing' | 'ambiguous' | 'conflicting' | 'incomplete'
export type GapSource = 'rule' | 'ai' | 'pattern'
export type NfrCategory = 'security' | 'performance' | 'auditability'
export type TargetRole = 'ba' | 'architect' | 'po' | 'dev'
export type TaskStatus = 'open' | 'in-progress' | 'resolved' | 'dismissed'
export type QuestionStatus = 'open' | 'answered' | 'dismissed'
export type ItemType = 'functional' | 'non-functional' | 'constraint' | 'assumption'

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
  question_generated: boolean
  merged_into: string | null
  resolved_at: string | null
  resolution_source: 'question_answered' | 'task_resolved' | 'decision_recorded' | null
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
  action: 'created' | 'updated' | 'deleted' | 'analyzed' | 'scored'
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

export interface CompletenessScore {
  id: string
  requirement_id: string
  overall_score: number
  completeness: number
  nfr_score: number
  confidence: number
  breakdown: ScoreBreakdown
  scored_at: string
}

export interface ScoreBreakdown {
  completeness: number
  nfr_score: number
  overall: number
  confidence: number
  gap_counts: { critical: number; major: number; minor: number }
  nfr_coverage: { security: boolean; performance: boolean; auditability: boolean }
}

export interface GapPattern {
  id: string
  project_id: string | null
  category: GapCategory
  severity: GapSeverity
  description_template: string
  occurrence_count: number
  last_seen_at: string
  created_at: string
}

export interface ResolutionPattern {
  id: string
  gap_pattern_id: string
  project_id: string | null
  resolution_summary: string
  source_decision_id: string | null
  use_count: number
  created_at: string
}

export interface DomainTemplate {
  id: string
  project_id: string | null
  domain: string
  name: string
  requirement_areas: RequirementAreas
  created_at: string
}

export interface RequirementAreas {
  functional: string[]
  nfr: NfrCategory[]
}

export interface RequirementSummary {
  critical_count: number
  major_count: number
  minor_count: number
  completeness: number
  confidence: number
  overall_score: number
  status: RequirementStatus
  blocked_reason: string | null
}
```

- [ ] **Step 2: Create browser client**

Create `lib/supabase/client.ts`:
```typescript
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
```

- [ ] **Step 3: Create server client**

Create `lib/supabase/server.ts`:
```typescript
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export function createClient() {
  const cookieStore = cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )
}
```

- [ ] **Step 4: Add auth middleware**

Create `middleware.ts` at project root:
```typescript
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // Redirect unauthenticated users to login (except auth routes)
  if (!user && !request.nextUrl.pathname.startsWith('/login') && !request.nextUrl.pathname.startsWith('/signup')) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/.*).*)'],
}
```

- [ ] **Step 5: Commit**

```bash
git add lib/supabase/ middleware.ts
git commit -m "feat: add Supabase client, types, and auth middleware"
```

---

## Task 4: AI Provider Interface

**Files:** `lib/ai/provider.ts`, `lib/ai/registry.ts`

- [ ] **Step 1: Write failing test**

Create `tests/lib/ai/provider.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { getProvider } from '@/lib/ai/registry'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

describe('AI provider registry', () => {
  it('returns MockAIProvider when AI_PROVIDER=mock', () => {
    process.env.AI_PROVIDER = 'mock'
    const provider = getProvider()
    expect(provider).toBeInstanceOf(MockAIProvider)
  })

  it('throws when AI_PROVIDER is unrecognised', () => {
    process.env.AI_PROVIDER = 'unknown-provider'
    expect(() => getProvider()).toThrow('Unknown AI_PROVIDER: unknown-provider')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test tests/lib/ai/provider.test.ts
```

Expected: FAIL — `getProvider` not found.

- [ ] **Step 3: Write the provider interface**

Create `lib/ai/provider.ts`:
```typescript
export interface CompletionOptions {
  /** JSON Schema for structured output. When provided, adapter MUST return valid JSON string. */
  responseSchema?: Record<string, unknown>
  temperature?: number
  maxTokens?: number
}

export interface AIProvider {
  complete(prompt: string, options?: CompletionOptions): Promise<string>
}

/** Parse structured response. Throws if invalid JSON when schema was requested. */
export function parseStructuredResponse<T>(raw: string, schema?: Record<string, unknown>): T {
  if (!schema) return raw as unknown as T
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`AI provider returned invalid JSON. Raw response: ${raw.slice(0, 200)}`)
  }
}
```

- [ ] **Step 4: Write the mock adapter**

Create `lib/ai/adapters/mock.ts`:
```typescript
import type { AIProvider, CompletionOptions } from '@/lib/ai/provider'

export class MockAIProvider implements AIProvider {
  private responses: Map<string, string> = new Map()
  private defaultResponse = '{}'

  /** Pre-program a response for a prompt containing the given substring. */
  setResponse(promptContains: string, response: string) {
    this.responses.set(promptContains, response)
  }

  setDefaultResponse(response: string) {
    this.defaultResponse = response
  }

  async complete(prompt: string, _options?: CompletionOptions): Promise<string> {
    for (const [key, response] of this.responses) {
      if (prompt.includes(key)) return response
    }
    return this.defaultResponse
  }
}
```

- [ ] **Step 5: Write the registry**

Create `lib/ai/registry.ts`:
```typescript
import type { AIProvider } from './provider'
import { MockAIProvider } from './adapters/mock'
import { ClaudeAIProvider } from './adapters/claude'
import { OpenAIProvider } from './adapters/openai'

export function getProvider(): AIProvider {
  const providerName = process.env.AI_PROVIDER ?? 'mock'

  switch (providerName) {
    case 'mock':
      return new MockAIProvider()
    case 'claude':
      return new ClaudeAIProvider()
    case 'openai':
      return new OpenAIProvider()
    default:
      throw new Error(`Unknown AI_PROVIDER: ${providerName}`)
  }
}
```

Note: Static imports are used instead of dynamic `require()` to avoid ESLint `no-case-declarations` violations. This means the Claude and OpenAI SDK packages are always imported — but since they are only instantiated when selected, there is no runtime cost.

- [ ] **Step 6: Add mock adapter tests**

Create `tests/lib/ai/adapters/mock.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

describe('MockAIProvider', () => {
  it('returns default response when no match', async () => {
    const provider = new MockAIProvider()
    provider.setDefaultResponse('hello')
    const result = await provider.complete('any prompt')
    expect(result).toBe('hello')
  })

  it('returns matched response when prompt contains key', async () => {
    const provider = new MockAIProvider()
    provider.setResponse('parse requirements', '{"items":[]}')
    const result = await provider.complete('please parse requirements from this text')
    expect(result).toBe('{"items":[]}')
  })

  it('returns first match when multiple keys match', async () => {
    const provider = new MockAIProvider()
    provider.setResponse('foo', 'response-foo')
    provider.setResponse('bar', 'response-bar')
    const result = await provider.complete('foo bar baz')
    expect(result).toBe('response-foo')
  })
})
```

- [ ] **Step 7: Run all AI tests to verify they pass**

```bash
npm test tests/lib/ai/
```

Expected: PASS (5 tests — 2 registry + 3 mock).

- [ ] **Step 8: Commit**

```bash
git add lib/ai/provider.ts lib/ai/registry.ts lib/ai/adapters/mock.ts tests/lib/ai/
git commit -m "feat: add AI provider interface, registry, and mock adapter"
```

---

## Task 5: Claude and OpenAI Adapters

**Files:** `lib/ai/adapters/claude.ts`, `lib/ai/adapters/openai.ts`

Note: Claude and OpenAI adapters require live API keys for real calls — unit tests use the mock. Instead, write a contract test that verifies the adapter class shape (implements the interface) without making network calls.

- [ ] **Step 1: Write failing adapter contract test**

Create `tests/lib/ai/adapters/adapters.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { ClaudeAIProvider } from '@/lib/ai/adapters/claude'
import { OpenAIProvider } from '@/lib/ai/adapters/openai'
import type { AIProvider } from '@/lib/ai/provider'

describe('Adapter contracts', () => {
  it('ClaudeAIProvider implements AIProvider interface', () => {
    const provider: AIProvider = new ClaudeAIProvider()
    expect(typeof provider.complete).toBe('function')
  })

  it('OpenAIProvider implements AIProvider interface', () => {
    const provider: AIProvider = new OpenAIProvider()
    expect(typeof provider.complete).toBe('function')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test tests/lib/ai/adapters/adapters.test.ts
```

Expected: FAIL — `ClaudeAIProvider` not found.

- [ ] **Step 3: Write Claude adapter**

Create `lib/ai/adapters/claude.ts`:
```typescript
import Anthropic from '@anthropic-ai/sdk'
import type { AIProvider, CompletionOptions } from '@/lib/ai/provider'

export class ClaudeAIProvider implements AIProvider {
  private client: Anthropic

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    })
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const systemPrompt = options?.responseSchema
      ? `You must respond with valid JSON only. No prose, no markdown. JSON Schema: ${JSON.stringify(options.responseSchema)}`
      : 'You are a helpful requirements engineering assistant.'

    const message = await this.client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    })

    const block = message.content[0]
    if (block.type !== 'text') throw new Error('Unexpected Claude response type')
    return block.text
  }
}
```

- [ ] **Step 4: Write OpenAI adapter**

Create `lib/ai/adapters/openai.ts`:
```typescript
import OpenAI from 'openai'
import type { AIProvider, CompletionOptions } from '@/lib/ai/provider'

export class OpenAIProvider implements AIProvider {
  private client: OpenAI

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const systemPrompt = options?.responseSchema
      ? `You must respond with valid JSON only. No prose, no markdown. JSON Schema: ${JSON.stringify(options.responseSchema)}`
      : 'You are a helpful requirements engineering assistant.'

    const response = await this.client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
      temperature: options?.temperature ?? 0,
      max_tokens: options?.maxTokens ?? 4096,
      response_format: options?.responseSchema ? { type: 'json_object' } : { type: 'text' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    })

    return response.choices[0].message.content ?? ''
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test tests/lib/ai/adapters/adapters.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/ai/adapters/claude.ts lib/ai/adapters/openai.ts tests/lib/ai/adapters/
git commit -m "feat: add Claude and OpenAI provider adapters"
```

---

## Task 6: Auth Pages

**Files:** `app/(auth)/layout.tsx`, `app/(auth)/login/page.tsx`, `app/(auth)/signup/page.tsx`, `app/layout.tsx`, `app/page.tsx`

- [ ] **Step 1: Create root layout**

Replace `app/layout.tsx`:
```tsx
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Software Factory',
  description: 'AI-powered requirements intelligence',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  )
}
```

- [ ] **Step 2: Create root redirect**

Replace `app/page.tsx`:
```tsx
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export default async function RootPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) redirect('/projects')
  redirect('/login')
}
```

- [ ] **Step 3: Create auth layout**

Create `app/(auth)/layout.tsx`:
```tsx
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md">{children}</div>
    </div>
  )
}
```

- [ ] **Step 4: Create login page**

Create `app/(auth)/login/page.tsx`:
```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/projects')
    }
  }

  return (
    <div className="bg-white p-8 rounded-lg shadow">
      <h1 className="text-2xl font-bold mb-6">Sign in</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Email</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="w-full border rounded px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            className="w-full border rounded px-3 py-2"
          />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="mt-4 text-sm text-center">
        No account? <Link href="/signup" className="text-blue-600 hover:underline">Sign up</Link>
      </p>
    </div>
  )
}
```

- [ ] **Step 5: Create signup page**

Create `app/(auth)/signup/page.tsx`:
```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

export default function SignupPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signUp({ email, password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/projects')
    }
  }

  return (
    <div className="bg-white p-8 rounded-lg shadow">
      <h1 className="text-2xl font-bold mb-6">Create account</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Email</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="w-full border rounded px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={6}
            className="w-full border rounded px-3 py-2"
          />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p className="mt-4 text-sm text-center">
        Already have an account? <Link href="/login" className="text-blue-600 hover:underline">Sign in</Link>
      </p>
    </div>
  )
}
```

- [ ] **Step 6: Verify build passes**

```bash
npm run build
```

Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add app/ middleware.ts
git commit -m "feat: add auth pages (login, signup) and root redirect"
```

---

## Task 7: Verify Full Test Suite

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected: All tests pass. Current count: 7 tests across 3 files (`provider.test.ts` × 2, `mock.test.ts` × 3, `adapters.test.ts` × 2).

- [ ] **Step 2: Verify no TypeScript errors**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Push to GitHub**

```bash
git push origin main
```

---

## Foundation Complete

After this plan, the project has:
- ✅ Next.js 14 project with TypeScript, Tailwind, Vitest
- ✅ All 13 Supabase tables with RLS policies
- ✅ Model-agnostic AI provider interface
- ✅ Mock, Claude, and OpenAI adapters
- ✅ Supabase auth (login/signup)

**Next plan:** `2026-03-23-plan-b-core-pipeline.md` — implements the full analysis pipeline (parse → detect → prioritize → questions → tasks → score).
