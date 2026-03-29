# Change Intelligence System — Plan 1: Data Layer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old schema with the Change Intelligence data model and rewrite TypeScript types to match.

**Architecture:** One migration file (`006_change_intelligence_schema.sql`) drops all old tables (except `projects`), strips old columns from `projects`, adds new columns, then creates all 26 new tables with RLS. `lib/supabase/types.ts` is fully replaced — no old types survive.

**Tech Stack:** Supabase (PostgreSQL), TypeScript 5, Vitest

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `supabase/migrations/006_change_intelligence_schema.sql` | Full schema replacement |
| Modify | `lib/supabase/types.ts` | All TypeScript types for new schema |
| Create | `tests/lib/supabase/types.test.ts` | Type shape smoke tests |

---

### Task 1: Write migration — drop old tables and alter projects

**Files:**
- Create: `supabase/migrations/006_change_intelligence_schema.sql`

- [ ] **Step 1: Create the migration file with the drop block**

Create `supabase/migrations/006_change_intelligence_schema.sql` with this exact content:

```sql
-- 006_change_intelligence_schema.sql
-- Replaces all pipeline tables with Change Intelligence schema.
-- projects table is kept; all other old tables are dropped.

-- ── Drop old tables (reverse dependency order) ────────────────────────────────

drop table if exists job_logs             cascade;
drop table if exists agent_plans          cascade;
drop table if exists jobs                 cascade;

drop table if exists vision_logs          cascade;
drop table if exists project_visions      cascade;

drop table if exists case_feedback        cascade;
drop table if exists knowledge_cases      cascade;
drop table if exists resolution_patterns  cascade;
drop table if exists gap_patterns         cascade;
drop table if exists domain_templates     cascade;
drop table if exists completeness_scores  cascade;
drop table if exists ai_usage_log         cascade;
drop table if exists decision_log         cascade;
drop table if exists audit_log            cascade;
drop table if exists risk_acceptances     cascade;
drop table if exists investigation_tasks  cascade;
drop table if exists questions            cascade;
drop table if exists gaps                 cascade;
drop table if exists requirement_relations cascade;
drop table if exists requirement_items    cascade;
drop table if exists requirements         cascade;

-- ── Alter projects ────────────────────────────────────────────────────────────

alter table projects
  drop column if exists setup_mode,
  drop column if exists target_path,
  drop column if exists test_command;

alter table projects
  add column if not exists repo_url    text,
  add column if not exists repo_token  text,
  add column if not exists scan_status text not null default 'pending'
    check (scan_status in ('pending','scanning','ready','failed')),
  add column if not exists scan_error  text,
  add column if not exists lock_version int not null default 0;
```

- [ ] **Step 2: Commit the file so far (partial, will be appended)**

```bash
git add supabase/migrations/006_change_intelligence_schema.sql
git commit -m "feat: migration 006 - drop old schema, extend projects"
```

---

### Task 2: Migration — canonical files + system model tables

**Files:**
- Modify: `supabase/migrations/006_change_intelligence_schema.sql`

- [ ] **Step 1: Append canonical file registry and system model tables**

Append to `supabase/migrations/006_change_intelligence_schema.sql`:

```sql

-- ── Canonical file registry ───────────────────────────────────────────────────

create table files (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  path       text not null,
  hash       text,
  unique(project_id, path)
);

alter table files enable row level security;
create policy "project owner access" on files for all using (
  exists (select 1 from projects where projects.id = files.project_id and projects.owner_id = auth.uid())
);

create index files_project_path_idx on files(project_id, path);

-- ── System model ──────────────────────────────────────────────────────────────

create table system_components (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references projects(id) on delete cascade,
  name               text not null,
  type               text not null check (type in ('service','module','api','db','ui')),
  exposed_interfaces text[] not null default '{}',
  status             text not null default 'stable' check (status in ('stable','unstable')),
  is_anchored        boolean not null default false,
  scan_count         int not null default 0,
  last_updated       timestamptz not null default now(),
  deleted_at         timestamptz
);

alter table system_components enable row level security;
create policy "project owner access" on system_components for all using (
  exists (select 1 from projects where projects.id = system_components.project_id and projects.owner_id = auth.uid())
);

create index system_components_project_idx on system_components(project_id);

-- component_assignment replaces system_component_files
create table component_assignment (
  file_id              uuid not null references files(id) on delete cascade,
  component_id         uuid references system_components(id) on delete set null,
  confidence           int not null default 0 check (confidence between 0 and 100),
  is_primary           boolean not null default true,
  status               text not null default 'assigned' check (status in ('assigned','unassigned')),
  reassignment_count   int not null default 0,
  last_validated_at    timestamptz not null default now(),
  last_moved_at        timestamptz not null default now()
);

alter table component_assignment enable row level security;
create policy "project owner access" on component_assignment for all using (
  exists (
    select 1 from files
    join projects on projects.id = files.project_id
    where files.id = component_assignment.file_id and projects.owner_id = auth.uid()
  )
);

-- Only one primary owner per file
create unique index component_assignment_primary_idx
  on component_assignment(file_id) where is_primary = true;

create table component_dependencies (
  from_id    uuid not null references system_components(id) on delete cascade,
  to_id      uuid not null references system_components(id) on delete cascade,
  type       text not null check (type in ('sync','async','data','api')),
  deleted_at timestamptz,
  unique(from_id, to_id)
);

alter table component_dependencies enable row level security;
create policy "project owner access" on component_dependencies for all using (
  exists (
    select 1 from system_components sc
    join projects on projects.id = sc.project_id
    where sc.id = component_dependencies.from_id and projects.owner_id = auth.uid()
  )
);

create index component_dependencies_from_idx on component_dependencies(from_id);
create index component_dependencies_to_idx   on component_dependencies(to_id);

create table system_component_versions (
  id           uuid primary key default gen_random_uuid(),
  component_id uuid not null references system_components(id) on delete cascade,
  version      int not null,
  snapshot     jsonb not null,
  created_at   timestamptz not null default now()
);

alter table system_component_versions enable row level security;
create policy "project owner access" on system_component_versions for all using (
  exists (
    select 1 from system_components sc
    join projects on projects.id = sc.project_id
    where sc.id = system_component_versions.component_id and projects.owner_id = auth.uid()
  )
);

create table component_tests (
  id           uuid primary key default gen_random_uuid(),
  component_id uuid not null references system_components(id) on delete cascade,
  test_path    text not null,
  unique(component_id, test_path)
);

alter table component_tests enable row level security;
create policy "project owner access" on component_tests for all using (
  exists (
    select 1 from system_components sc
    join projects on projects.id = sc.project_id
    where sc.id = component_tests.component_id and projects.owner_id = auth.uid()
  )
);

create table test_coverage_map (
  test_path text not null,
  file_id   uuid not null references files(id) on delete cascade,
  unique(test_path, file_id)
);

alter table test_coverage_map enable row level security;
create policy "project owner access" on test_coverage_map for all using (
  exists (
    select 1 from files
    join projects on projects.id = files.project_id
    where files.id = test_coverage_map.file_id and projects.owner_id = auth.uid()
  )
);

create table component_graph_edges (
  from_file_id uuid not null references files(id) on delete cascade,
  to_file_id   uuid not null references files(id) on delete cascade,
  project_id   uuid not null references projects(id) on delete cascade,
  edge_type    text not null check (
    edge_type in ('static','re-export','dynamic-static-string','dynamic-template','dynamic-computed')
  ),
  unique(from_file_id, to_file_id)
);

alter table component_graph_edges enable row level security;
create policy "project owner access" on component_graph_edges for all using (
  exists (select 1 from projects where projects.id = component_graph_edges.project_id and projects.owner_id = auth.uid())
);

create index component_graph_edges_from_idx on component_graph_edges(from_file_id);
create index component_graph_edges_to_idx   on component_graph_edges(to_file_id);

create table component_evolution_signals (
  id                   uuid primary key default gen_random_uuid(),
  component_id         uuid not null references system_components(id) on delete cascade,
  type                 text not null check (type in ('split','merge')),
  target_component_id  uuid references system_components(id) on delete set null,
  confidence           int not null check (confidence between 0 and 100),
  created_at           timestamptz not null default now(),
  expires_at           timestamptz not null default (now() + interval '30 days'),
  unique(component_id, type, target_component_id)
);

alter table component_evolution_signals enable row level security;
create policy "project owner access" on component_evolution_signals for all using (
  exists (
    select 1 from system_components sc
    join projects on projects.id = sc.project_id
    where sc.id = component_evolution_signals.component_id and projects.owner_id = auth.uid()
  )
);
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/006_change_intelligence_schema.sql
git commit -m "feat: migration 006 - system model tables"
```

---

### Task 3: Migration — change layer tables

**Files:**
- Modify: `supabase/migrations/006_change_intelligence_schema.sql`

- [ ] **Step 1: Append change request and impact tables**

Append to `supabase/migrations/006_change_intelligence_schema.sql`:

```sql

-- ── Change layer ──────────────────────────────────────────────────────────────

create table change_requests (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references projects(id) on delete cascade,
  title                text not null,
  intent               text not null,
  type                 text not null check (type in ('bug','feature','refactor','hotfix')),
  priority             text not null default 'medium' check (priority in ('low','medium','high')),
  status               text not null default 'open' check (
    status in (
      'open','analyzing','analyzing_mapping','analyzing_propagation','analyzing_scoring',
      'analyzed','planned','executing','review','done','failed'
    )
  ),
  risk_level           text check (risk_level in ('low','medium','high')),
  confidence_score     int check (confidence_score between 0 and 100),
  confidence_breakdown jsonb,
  analysis_quality     text check (analysis_quality in ('high','medium','low')),
  lock_version         int not null default 0,
  execution_group      text,
  created_by           uuid references auth.users(id) on delete set null,
  triggered_by         text not null default 'user' check (triggered_by in ('user','system','production_event')),
  tags                 text[] not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table change_requests enable row level security;
create policy "project owner access" on change_requests for all using (
  exists (select 1 from projects where projects.id = change_requests.project_id and projects.owner_id = auth.uid())
);

create index change_requests_project_status_idx on change_requests(project_id, status);

create table change_request_components (
  change_id    uuid not null references change_requests(id) on delete cascade,
  component_id uuid not null references system_components(id) on delete cascade,
  unique(change_id, component_id)
);

alter table change_request_components enable row level security;
create policy "project owner access" on change_request_components for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = change_request_components.change_id and projects.owner_id = auth.uid()
  )
);

create index change_request_components_component_idx on change_request_components(component_id);

create table change_request_files (
  change_id uuid not null references change_requests(id) on delete cascade,
  file_id   uuid not null references files(id) on delete cascade,
  unique(change_id, file_id)
);

alter table change_request_files enable row level security;
create policy "project owner access" on change_request_files for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = change_request_files.change_id and projects.owner_id = auth.uid()
  )
);

create table change_risk_factors (
  id        uuid primary key default gen_random_uuid(),
  change_id uuid not null references change_requests(id) on delete cascade,
  factor    text not null,
  weight    int not null
);

alter table change_risk_factors enable row level security;
create policy "project owner access" on change_risk_factors for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = change_risk_factors.change_id and projects.owner_id = auth.uid()
  )
);

create table change_decisions (
  id              uuid primary key default gen_random_uuid(),
  change_id       uuid not null references change_requests(id) on delete cascade,
  stage           text not null check (stage in ('analysis','planning','execution')),
  decision_type   text not null,
  rationale       text,
  input_snapshot  jsonb,
  output_snapshot jsonb,
  created_at      timestamptz not null default now()
);

alter table change_decisions enable row level security;
create policy "project owner access" on change_decisions for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = change_decisions.change_id and projects.owner_id = auth.uid()
  )
);

create table change_system_snapshot_components (
  change_id            uuid not null references change_requests(id) on delete cascade,
  component_version_id uuid not null references system_component_versions(id) on delete cascade,
  unique(change_id, component_version_id)
);

alter table change_system_snapshot_components enable row level security;
create policy "project owner access" on change_system_snapshot_components for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = change_system_snapshot_components.change_id and projects.owner_id = auth.uid()
  )
);

create table change_impacts (
  id                   uuid primary key default gen_random_uuid(),
  change_id            uuid not null references change_requests(id) on delete cascade,
  risk_score           numeric not null default 0,
  blast_radius         numeric not null default 0,
  primary_risk_factor  text,
  analysis_quality     text not null default 'high' check (analysis_quality in ('high','medium','low')),
  requires_migration   boolean not null default false,
  requires_data_change boolean not null default false
);

alter table change_impacts enable row level security;
create policy "project owner access" on change_impacts for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = change_impacts.change_id and projects.owner_id = auth.uid()
  )
);

create table change_impact_components (
  impact_id     uuid not null references change_impacts(id) on delete cascade,
  component_id  uuid not null references system_components(id) on delete cascade,
  impact_weight numeric not null default 0,
  source        text not null check (source in ('directly_mapped','via_dependency','via_file')),
  source_detail text,
  unique(impact_id, component_id)
);

alter table change_impact_components enable row level security;
create policy "project owner access" on change_impact_components for all using (
  exists (
    select 1 from change_impacts ci
    join change_requests cr on cr.id = ci.change_id
    join projects on projects.id = cr.project_id
    where ci.id = change_impact_components.impact_id and projects.owner_id = auth.uid()
  )
);

create index change_impact_components_component_idx on change_impact_components(component_id);

create table change_impact_files (
  impact_id uuid not null references change_impacts(id) on delete cascade,
  file_id   uuid not null references files(id) on delete cascade,
  unique(impact_id, file_id)
);

alter table change_impact_files enable row level security;
create policy "project owner access" on change_impact_files for all using (
  exists (
    select 1 from change_impacts ci
    join change_requests cr on cr.id = ci.change_id
    join projects on projects.id = cr.project_id
    where ci.id = change_impact_files.impact_id and projects.owner_id = auth.uid()
  )
);

create table change_plans (
  id              uuid primary key default gen_random_uuid(),
  change_id       uuid not null references change_requests(id) on delete cascade,
  status          text not null default 'draft' check (status in ('draft','approved','rejected')),
  spec_markdown   text,
  estimated_tasks int,
  estimated_files int,
  created_at      timestamptz not null default now(),
  approved_at     timestamptz
);

alter table change_plans enable row level security;
create policy "project owner access" on change_plans for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = change_plans.change_id and projects.owner_id = auth.uid()
  )
);

create table change_plan_tasks (
  id           uuid primary key default gen_random_uuid(),
  plan_id      uuid not null references change_plans(id) on delete cascade,
  component_id uuid references system_components(id) on delete set null,
  description  text not null,
  order_index  int not null default 0,
  status       text not null default 'pending' check (status in ('pending','done'))
);

alter table change_plan_tasks enable row level security;
create policy "project owner access" on change_plan_tasks for all using (
  exists (
    select 1 from change_plans cp
    join change_requests cr on cr.id = cp.change_id
    join projects on projects.id = cr.project_id
    where cp.id = change_plan_tasks.plan_id and projects.owner_id = auth.uid()
  )
);
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/006_change_intelligence_schema.sql
git commit -m "feat: migration 006 - change layer tables"
```

---

### Task 4: Migration — execution, outcome, and production tables

**Files:**
- Modify: `supabase/migrations/006_change_intelligence_schema.sql`

- [ ] **Step 1: Append remaining tables**

Append to `supabase/migrations/006_change_intelligence_schema.sql`:

```sql

-- ── Execution layer ───────────────────────────────────────────────────────────

create table execution_snapshots (
  id                 uuid primary key default gen_random_uuid(),
  change_id          uuid not null references change_requests(id) on delete cascade,
  iteration          int not null default 1,
  files_modified     text[] not null default '{}',
  tests_run          text[] not null default '{}',
  tests_passed       int not null default 0,
  tests_failed       int not null default 0,
  error_summary      text,
  diff_summary       text,
  duration_ms        int,
  retry_count        int not null default 0,
  ai_cost            numeric,
  environment        text,
  termination_reason text check (termination_reason in ('passed','max_iterations','cancelled','error'))
);

alter table execution_snapshots enable row level security;
create policy "project owner access" on execution_snapshots for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = execution_snapshots.change_id and projects.owner_id = auth.uid()
  )
);

create table file_locks (
  file_id   uuid primary key references files(id) on delete cascade,
  change_id uuid not null references change_requests(id) on delete cascade,
  locked_at timestamptz not null default now()
);

alter table file_locks enable row level security;
create policy "project owner access" on file_locks for all using (
  exists (
    select 1 from files
    join projects on projects.id = files.project_id
    where files.id = file_locks.file_id and projects.owner_id = auth.uid()
  )
);

-- ── Outcome + deployment layer ────────────────────────────────────────────────

create table change_commits (
  id          uuid primary key default gen_random_uuid(),
  change_id   uuid not null references change_requests(id) on delete cascade,
  branch_name text not null,
  commit_hash text not null,
  created_at  timestamptz not null default now()
);

alter table change_commits enable row level security;
create policy "project owner access" on change_commits for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = change_commits.change_id and projects.owner_id = auth.uid()
  )
);

create table change_outcomes (
  change_id              uuid primary key references change_requests(id) on delete cascade,
  success                boolean not null,
  regressions_detected   boolean not null default false,
  rollback_triggered     boolean not null default false,
  user_feedback          text,
  created_at             timestamptz not null default now()
);

alter table change_outcomes enable row level security;
create policy "project owner access" on change_outcomes for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = change_outcomes.change_id and projects.owner_id = auth.uid()
  )
);

create table deployments (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  change_id   uuid not null references change_requests(id) on delete cascade,
  environment text not null check (environment in ('staging','prod')),
  status      text not null default 'pending' check (status in ('pending','deployed','failed')),
  commit_hash text,
  deployed_at timestamptz
);

alter table deployments enable row level security;
create policy "project owner access" on deployments for all using (
  exists (select 1 from projects where projects.id = deployments.project_id and projects.owner_id = auth.uid())
);

-- ── Production layer ──────────────────────────────────────────────────────────

create table production_events (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  type       text not null check (type in ('error','performance','usage')),
  source     text not null,
  severity   text not null check (severity in ('low','high','critical')),
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table production_events enable row level security;
create policy "project owner access" on production_events for all using (
  exists (select 1 from projects where projects.id = production_events.project_id and projects.owner_id = auth.uid())
);

create table production_event_components (
  event_id     uuid not null references production_events(id) on delete cascade,
  component_id uuid not null references system_components(id) on delete cascade,
  unique(event_id, component_id)
);

alter table production_event_components enable row level security;
create policy "project owner access" on production_event_components for all using (
  exists (
    select 1 from production_events pe
    join projects on projects.id = pe.project_id
    where pe.id = production_event_components.event_id and projects.owner_id = auth.uid()
  )
);

create index production_event_components_component_idx on production_event_components(component_id);

create table production_event_links (
  event_id      uuid not null references production_events(id) on delete cascade,
  change_id     uuid not null references change_requests(id) on delete cascade,
  relation_type text not null check (relation_type in ('caused_by','resolved_by')),
  unique(event_id, change_id, relation_type)
);

alter table production_event_links enable row level security;
create policy "project owner access" on production_event_links for all using (
  exists (
    select 1 from production_events pe
    join projects on projects.id = pe.project_id
    where pe.id = production_event_links.event_id and projects.owner_id = auth.uid()
  )
);

create index production_event_links_change_idx on production_event_links(change_id);
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/006_change_intelligence_schema.sql
git commit -m "feat: migration 006 - execution, outcome, production tables"
```

---

### Task 5: Apply migration and verify

**Files:** none (validation only)

- [ ] **Step 1: Apply migration locally**

```bash
supabase db reset
```

Expected output: no errors, migration applies cleanly. If using remote Supabase only:

```bash
supabase db push
```

- [ ] **Step 2: Verify key tables exist**

```bash
supabase db diff --linked
```

Or open Supabase Studio → Table Editor and confirm these tables are present:
- `files`, `system_components`, `component_assignment`, `component_dependencies`
- `change_requests`, `change_impacts`, `change_impact_components`
- `change_plans`, `execution_snapshots`, `production_events`

And that `projects` has: `repo_url`, `repo_token`, `scan_status`, `scan_error`, `lock_version`.

And that `requirements`, `jobs`, `agent_plans` are gone.

---

### Task 6: Replace TypeScript types — enums and project/system model

**Files:**
- Modify: `lib/supabase/types.ts`

- [ ] **Step 1: Replace the entire file with new types (part 1 of 3)**

Replace the full content of `lib/supabase/types.ts` with:

```typescript
// lib/supabase/types.ts

// ── Shared enums ──────────────────────────────────────────────────────────────

export type ScanStatus         = 'pending' | 'scanning' | 'ready' | 'failed'
export type ComponentType      = 'service' | 'module' | 'api' | 'db' | 'ui'
export type ComponentStatus    = 'stable' | 'unstable'
export type AssignmentStatus   = 'assigned' | 'unassigned'
export type EdgeType           =
  | 'static' | 're-export'
  | 'dynamic-static-string' | 'dynamic-template' | 'dynamic-computed'
export type DependencyType     = 'sync' | 'async' | 'data' | 'api'
export type EvolutionSignalType = 'split' | 'merge'

export type ChangeType         = 'bug' | 'feature' | 'refactor' | 'hotfix'
export type ChangePriority     = 'low' | 'medium' | 'high'
export type ChangeStatus       =
  | 'open' | 'analyzing' | 'analyzing_mapping'
  | 'analyzing_propagation' | 'analyzing_scoring'
  | 'analyzed' | 'planned' | 'executing' | 'review' | 'done' | 'failed'
export type RiskLevel          = 'low' | 'medium' | 'high'
export type AnalysisQuality    = 'high' | 'medium' | 'low'
export type DecisionStage      = 'analysis' | 'planning' | 'execution'
export type PlanStatus         = 'draft' | 'approved' | 'rejected'
export type PlanTaskStatus     = 'pending' | 'done'
export type TerminationReason  = 'passed' | 'max_iterations' | 'cancelled' | 'error'
export type DeploymentEnv      = 'staging' | 'prod'
export type DeploymentStatus   = 'pending' | 'deployed' | 'failed'
export type ProductionEventType     = 'error' | 'performance' | 'usage'
export type ProductionEventSeverity = 'low' | 'high' | 'critical'
export type EventRelationType  = 'caused_by' | 'resolved_by'
export type ImpactSource       = 'directly_mapped' | 'via_dependency' | 'via_file'
export type TriggeredBy        = 'user' | 'system' | 'production_event'

// ── Project ───────────────────────────────────────────────────────────────────

export interface Project {
  id:           string
  name:         string
  owner_id:     string
  repo_url:     string | null
  repo_token:   string | null
  scan_status:  ScanStatus
  scan_error:   string | null
  lock_version: number
  created_at:   string
}

// ── System model ──────────────────────────────────────────────────────────────

export interface ProjectFile {
  id:         string
  project_id: string
  path:       string
  hash:       string | null
}

export interface SystemComponent {
  id:                 string
  project_id:         string
  name:               string
  type:               ComponentType
  exposed_interfaces: string[]
  status:             ComponentStatus
  is_anchored:        boolean
  scan_count:         number
  last_updated:       string
  deleted_at:         string | null
}

export interface ComponentAssignment {
  file_id:            string
  component_id:       string | null
  confidence:         number
  is_primary:         boolean
  status:             AssignmentStatus
  reassignment_count: number
  last_validated_at:  string
  last_moved_at:      string
}

export interface ComponentDependency {
  from_id:    string
  to_id:      string
  type:       DependencyType
  deleted_at: string | null
}

export interface SystemComponentVersion {
  id:           string
  component_id: string
  version:      number
  snapshot:     Record<string, unknown>
  created_at:   string
}

export interface ComponentTest {
  id:           string
  component_id: string
  test_path:    string
}

export interface TestCoverageMap {
  test_path: string
  file_id:   string
}

export interface ComponentGraphEdge {
  from_file_id: string
  to_file_id:   string
  project_id:   string
  edge_type:    EdgeType
}

export interface ComponentEvolutionSignal {
  id:                  string
  component_id:        string
  type:                EvolutionSignalType
  target_component_id: string | null
  confidence:          number
  created_at:          string
  expires_at:          string
}
```

- [ ] **Step 2: Append change layer types (still in the same file)**

Append to `lib/supabase/types.ts`:

```typescript

// ── Change layer ──────────────────────────────────────────────────────────────

export interface ConfidenceBreakdown {
  mapping_confidence:    number
  model_completeness:    number
  dependency_coverage:   number
}

export interface ChangeRequest {
  id:                   string
  project_id:           string
  title:                string
  intent:               string
  type:                 ChangeType
  priority:             ChangePriority
  status:               ChangeStatus
  risk_level:           RiskLevel | null
  confidence_score:     number | null
  confidence_breakdown: ConfidenceBreakdown | null
  analysis_quality:     AnalysisQuality | null
  lock_version:         number
  execution_group:      string | null
  created_by:           string | null
  triggered_by:         TriggeredBy
  tags:                 string[]
  created_at:           string
  updated_at:           string
}

export interface ChangeRequestComponent {
  change_id:    string
  component_id: string
}

export interface ChangeRequestFile {
  change_id: string
  file_id:   string
}

export interface ChangeRiskFactor {
  id:        string
  change_id: string
  factor:    string
  weight:    number
}

export interface ChangeDecision {
  id:              string
  change_id:       string
  stage:           DecisionStage
  decision_type:   string
  rationale:       string | null
  input_snapshot:  Record<string, unknown> | null
  output_snapshot: Record<string, unknown> | null
  created_at:      string
}

export interface ChangeSystemSnapshotComponent {
  change_id:            string
  component_version_id: string
}

export interface ChangeImpact {
  id:                   string
  change_id:            string
  risk_score:           number
  blast_radius:         number
  primary_risk_factor:  string | null
  analysis_quality:     AnalysisQuality
  requires_migration:   boolean
  requires_data_change: boolean
}

export interface ChangeImpactComponent {
  impact_id:     string
  component_id:  string
  impact_weight: number
  source:        ImpactSource
  source_detail: string | null
}

export interface ChangeImpactFile {
  impact_id: string
  file_id:   string
}

export interface ChangePlan {
  id:              string
  change_id:       string
  status:          PlanStatus
  spec_markdown:   string | null
  estimated_tasks: number | null
  estimated_files: number | null
  created_at:      string
  approved_at:     string | null
}

export interface ChangePlanTask {
  id:          string
  plan_id:     string
  component_id: string | null
  description: string
  order_index: number
  status:      PlanTaskStatus
}
```

- [ ] **Step 3: Append execution, outcome, and production types**

Append to `lib/supabase/types.ts`:

```typescript

// ── Execution layer ───────────────────────────────────────────────────────────

export interface ExecutionSnapshot {
  id:                 string
  change_id:          string
  iteration:          number
  files_modified:     string[]
  tests_run:          string[]
  tests_passed:       number
  tests_failed:       number
  error_summary:      string | null
  diff_summary:       string | null
  duration_ms:        number | null
  retry_count:        number
  ai_cost:            number | null
  environment:        string | null
  termination_reason: TerminationReason | null
}

export interface FileLock {
  file_id:   string
  change_id: string
  locked_at: string
}

// ── Outcome + deployment ──────────────────────────────────────────────────────

export interface ChangeCommit {
  id:          string
  change_id:   string
  branch_name: string
  commit_hash: string
  created_at:  string
}

export interface ChangeOutcome {
  change_id:            string
  success:              boolean
  regressions_detected: boolean
  rollback_triggered:   boolean
  user_feedback:        string | null
  created_at:           string
}

export interface Deployment {
  id:          string
  project_id:  string
  change_id:   string
  environment: DeploymentEnv
  status:      DeploymentStatus
  commit_hash: string | null
  deployed_at: string | null
}

// ── Production layer ──────────────────────────────────────────────────────────

export interface ProductionEvent {
  id:         string
  project_id: string
  type:       ProductionEventType
  source:     string
  severity:   ProductionEventSeverity
  payload:    Record<string, unknown>
  created_at: string
}

export interface ProductionEventComponent {
  event_id:     string
  component_id: string
}

export interface ProductionEventLink {
  event_id:      string
  change_id:     string
  relation_type: EventRelationType
}
```

- [ ] **Step 4: Commit the types file**

```bash
git add lib/supabase/types.ts
git commit -m "feat: replace supabase types with Change Intelligence schema types"
```

---

### Task 7: Type smoke tests

**Files:**
- Create: `tests/lib/supabase/types.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/supabase/types.test.ts`:

```typescript
import { describe, it, expect, expectTypeOf } from 'vitest'
import type {
  Project, ProjectFile, SystemComponent, ComponentAssignment,
  ChangeRequest, ChangeImpact, ChangeImpactComponent,
  ChangePlan, ExecutionSnapshot, ProductionEvent,
  ChangeType, ChangeStatus, RiskLevel, AnalysisQuality,
} from '@/lib/supabase/types'

describe('Project type', () => {
  it('has required fields', () => {
    const p: Project = {
      id: 'uuid', name: 'test', owner_id: 'uuid',
      repo_url: null, repo_token: null,
      scan_status: 'pending', scan_error: null,
      lock_version: 0, created_at: '',
    }
    expectTypeOf(p.scan_status).toMatchTypeOf<'pending' | 'scanning' | 'ready' | 'failed'>()
  })
})

describe('SystemComponent type', () => {
  it('has required fields including scan_count and is_anchored', () => {
    const sc: SystemComponent = {
      id: 'uuid', project_id: 'uuid', name: 'auth',
      type: 'service', exposed_interfaces: [],
      status: 'stable', is_anchored: false,
      scan_count: 0, last_updated: '', deleted_at: null,
    }
    expectTypeOf(sc.type).toMatchTypeOf<'service' | 'module' | 'api' | 'db' | 'ui'>()
    expectTypeOf(sc.status).toMatchTypeOf<'stable' | 'unstable'>()
  })
})

describe('ComponentAssignment type', () => {
  it('allows null component_id for unassigned files', () => {
    const a: ComponentAssignment = {
      file_id: 'uuid', component_id: null,
      confidence: 0, is_primary: true,
      status: 'unassigned', reassignment_count: 0,
      last_validated_at: '', last_moved_at: '',
    }
    expectTypeOf(a.component_id).toMatchTypeOf<string | null>()
  })
})

describe('ChangeRequest type', () => {
  it('covers all status values', () => {
    const statuses: ChangeStatus[] = [
      'open','analyzing','analyzing_mapping','analyzing_propagation',
      'analyzing_scoring','analyzed','planned','executing','review','done','failed',
    ]
    expect(statuses).toHaveLength(11)
  })

  it('covers all change types', () => {
    const types: ChangeType[] = ['bug','feature','refactor','hotfix']
    expect(types).toHaveLength(4)
  })
})

describe('ChangeImpact type', () => {
  it('has blast_radius and risk_score as numbers', () => {
    const ci: ChangeImpact = {
      id: 'uuid', change_id: 'uuid',
      risk_score: 12.5, blast_radius: 4.2,
      primary_risk_factor: 'touches_auth',
      analysis_quality: 'high',
      requires_migration: false, requires_data_change: false,
    }
    expectTypeOf(ci.analysis_quality).toMatchTypeOf<AnalysisQuality>()
    expectTypeOf(ci.risk_score).toBeNumber()
  })
})

describe('ChangeImpactComponent type', () => {
  it('has source field with correct values', () => {
    const c: ChangeImpactComponent = {
      impact_id: 'uuid', component_id: 'uuid',
      impact_weight: 0.7,
      source: 'via_dependency',
      source_detail: 'auth-service',
    }
    expectTypeOf(c.source).toMatchTypeOf<'directly_mapped' | 'via_dependency' | 'via_file'>()
  })
})

describe('ExecutionSnapshot type', () => {
  it('has termination_reason', () => {
    const s: ExecutionSnapshot = {
      id: 'uuid', change_id: 'uuid', iteration: 1,
      files_modified: [], tests_run: [],
      tests_passed: 3, tests_failed: 0,
      error_summary: null, diff_summary: null,
      duration_ms: 4200, retry_count: 0,
      ai_cost: 0.012, environment: 'local',
      termination_reason: 'passed',
    }
    expectTypeOf(s.termination_reason).toMatchTypeOf<
      'passed' | 'max_iterations' | 'cancelled' | 'error' | null
    >()
  })
})

describe('ProductionEvent type', () => {
  it('has severity field', () => {
    const e: ProductionEvent = {
      id: 'uuid', project_id: 'uuid',
      type: 'error', source: 'sentry',
      severity: 'critical', payload: {},
      created_at: '',
    }
    expectTypeOf(e.severity).toMatchTypeOf<'low' | 'high' | 'critical'>()
  })
})
```

- [ ] **Step 2: Run tests to verify they pass (TypeScript types compile)**

```bash
npm test tests/lib/supabase/types.test.ts
```

Expected: all tests PASS (type tests are compile-time; runtime assertions verify enum coverage)

- [ ] **Step 3: Run TypeScript compiler check**

```bash
npx tsc --noEmit
```

Expected: no errors. If errors appear they will be in files that import the old types (e.g. `lib/requirements/`, `lib/agent/`) — these are expected and will be cleaned up in later plans when those modules are replaced.

- [ ] **Step 4: Commit**

```bash
git add tests/lib/supabase/types.test.ts
git commit -m "test: type smoke tests for Change Intelligence schema"
```

---

### Task 8: Clean up stale imports that block compilation

**Files:**
- Any file importing old types that causes `tsc --noEmit` to error on changed type shapes

- [ ] **Step 1: Identify which files fail**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | head -30
```

- [ ] **Step 2: For each failing file, comment out or stub the broken import**

The goal is NOT to fix those files (they will be replaced in Plans 2–4). The goal is to keep the project buildable.

For any file under `lib/requirements/`, `lib/agent/`, `components/agent/`, or `app/api/` that imports old types (e.g. `Job`, `AgentPlan`, `Requirement`):

Add at the top of the failing file:

```typescript
// TODO: replaced in Plan 2/3/4 — old types removed in migration 006
/* eslint-disable @typescript-eslint/no-explicit-any */
```

And cast any broken references to `any` temporarily:

```typescript
// Before (broken):
const job: Job = ...
// After (temporary stub):
const job: any = ...
```

Only do this for files that are being replaced in subsequent plans. Do NOT modify `lib/supabase/types.ts` or `tests/` files.

- [ ] **Step 3: Verify compilation passes**

```bash
npx tsc --noEmit
```

Expected: 0 errors (or only errors in test files for the old test suite, which is acceptable).

- [ ] **Step 4: Run the full test suite**

```bash
npm test
```

Expected: existing tests may fail (they test old logic). That is acceptable — they will be replaced. The new type tests in `tests/lib/supabase/types.test.ts` should all PASS.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "chore: stub broken imports from old schema — to be replaced in Plans 2-4"
```
