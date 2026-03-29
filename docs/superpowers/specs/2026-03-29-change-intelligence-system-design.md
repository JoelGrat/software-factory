# Change Intelligence & Execution System — Design Spec

> Created: 2026-03-29
> Status: Approved for implementation

---

## The Shift

This system is no longer an "AI software factory."

It is a **Change Intelligence & Execution System.**

A user submits a change request — raw text describing a bug, feature, refactor, or hotfix — and the system maps it against a live model of the codebase, computes real impact, generates a scoped plan, executes it safely, and learns from the outcome.

---

## Migration Strategy

- **Keep:** `projects` table (top-level entity)
- **Drop:** all other existing tables (jobs, requirements, gaps, gap_patterns, resolution_patterns, knowledge_cases, audit_log, ai_usage_log, risk_acceptances, etc.)
- **Add:** all tables defined in this spec
- **Routes:** full replacement — existing Vision/Requirements/Planning/Execution/Review routes removed; new routes built from scratch

---

## Data Model

### Canonical File Registry

```sql
files
  id          uuid PK
  project_id  uuid FK projects
  path        text
  hash        text
  UNIQUE(project_id, path)
  INDEX(project_id, path)
```

### Project Layer

```sql
projects (existing + additions)
  + repo_url       text
  + repo_token     text  -- encrypted
  + scan_status    text  -- 'pending' | 'scanning' | 'ready' | 'failed'
  + scan_error     text  -- reason if failed
  + lock_version   int
```

### System Model Layer

```sql
system_components
  id                  uuid PK
  project_id          uuid FK
  name                text
  type                text  -- 'service' | 'module' | 'api' | 'db' | 'ui'
  exposed_interfaces  text[]
  status              text  -- 'stable' | 'unstable'
  is_anchored         boolean  -- API routes, DB layer, entrypoints never shift
  scan_count          int default 0  -- incremented each scan; used to derive scans_since_last_move
  last_updated        timestamp
  deleted_at          timestamp NULL
  INDEX(project_id)

component_assignment
  file_id              uuid FK files
  component_id         uuid FK system_components NULL  -- NULL = unassigned
  confidence           int   -- 0–100
  is_primary           boolean
  status               text  -- 'assigned' | 'unassigned'
  reassignment_count   int default 0  -- incremented each time canonical owner changes
  last_validated_at    timestamp
  last_moved_at        timestamp
  UNIQUE(file_id) WHERE is_primary = true
  -- secondary links (is_primary = false) allowed without uniqueness constraint
  -- scans_since_last_move = system_components.scan_count - scan_count_at_last_move
  -- (scan_count_at_last_move can be derived from last_moved_at vs scan history, or stored separately)

component_dependencies
  from_id     uuid FK system_components
  to_id       uuid FK system_components
  type        text  -- 'sync' | 'async' | 'data' | 'api'
  deleted_at  timestamp NULL
  UNIQUE(from_id, to_id)
  INDEX(from_id), INDEX(to_id)

system_component_versions
  id            uuid PK
  component_id  uuid FK
  version       int
  snapshot      jsonb
  created_at    timestamp

component_tests
  id            uuid PK
  component_id  uuid FK
  test_path     text
  UNIQUE(component_id, test_path)

test_coverage_map
  test_path  text
  file_id    uuid FK files
  UNIQUE(test_path, file_id)

component_graph_edges
  from_file_id  uuid FK files
  to_file_id    uuid FK files
  project_id    uuid FK
  edge_type     text  -- 'static' | 're-export' | 'dynamic-static-string' | 'dynamic-template' | 'dynamic-computed'
  UNIQUE(from_file_id, to_file_id)
  INDEX(from_file_id), INDEX(to_file_id)

component_evolution_signals
  id                   uuid PK
  component_id         uuid FK
  type                 text  -- 'split' | 'merge'
  target_component_id  uuid FK NULL  -- for merge signals
  confidence           int
  created_at           timestamp
  expires_at           timestamp
  UNIQUE(component_id, type, target_component_id)
```

### Change Layer

```sql
change_requests
  id                    uuid PK
  project_id            uuid FK
  title                 text
  intent                text  -- raw user input
  type                  text  -- 'bug' | 'feature' | 'refactor' | 'hotfix'
  priority              text  -- 'low' | 'medium' | 'high'
  status                text  -- 'open' | 'analyzing' | 'analyzing_mapping' |
                              --  'analyzing_propagation' | 'analyzing_scoring' |
                              --  'analyzed' | 'planned' | 'executing' | 'review' | 'done' | 'failed'
  risk_level            text  -- 'low' | 'medium' | 'high'
  confidence_score      int
  confidence_breakdown  jsonb  -- { mapping_confidence, model_completeness, dependency_coverage }
  analysis_quality      text  -- 'high' | 'medium' | 'low'
  lock_version          int
  execution_group       text
  created_by            uuid  -- user id
  triggered_by          text  -- 'user' | 'system' | 'production_event'
  tags                  text[]
  created_at            timestamp
  updated_at            timestamp
  INDEX(project_id, status)

change_request_components
  change_id     uuid FK
  component_id  uuid FK
  UNIQUE(change_id, component_id)
  INDEX(component_id)

change_request_files
  change_id  uuid FK
  file_id    uuid FK
  UNIQUE(change_id, file_id)

change_risk_factors
  change_id  uuid FK
  factor     text  -- e.g. 'touches_auth', 'db_change', 'dynamic_import_runtime'
  weight     int

change_decisions
  id               uuid PK
  change_id        uuid FK
  stage            text  -- 'analysis' | 'planning' | 'execution'
  decision_type    text  -- e.g. 'component_mapping', 'scope_override', 'applied_pattern'
  rationale        text
  input_snapshot   jsonb
  output_snapshot  jsonb
  created_at       timestamp

change_system_snapshot_components
  change_id           uuid FK
  component_version_id uuid FK system_component_versions
  UNIQUE(change_id, component_version_id)

change_impacts
  id                    uuid PK
  change_id             uuid FK
  risk_score            numeric
  blast_radius          numeric  -- weighted sum, not component count
  primary_risk_factor   text
  analysis_quality      text  -- 'high' | 'medium' | 'low'
  requires_migration    boolean
  requires_data_change  boolean

change_impact_components
  impact_id     uuid FK
  component_id  uuid FK
  impact_weight numeric
  source        text  -- 'directly_mapped' | 'via_dependency' | 'via_file'
  source_detail text  -- component name or file path
  UNIQUE(impact_id, component_id)
  INDEX(component_id)

change_impact_files
  impact_id  uuid FK
  file_id    uuid FK
  UNIQUE(impact_id, file_id)

-- change_impact_dependencies removed: redundant with change_impact_components (source='via_dependency')

change_plans
  id               uuid PK
  change_id        uuid FK
  status           text  -- 'draft' | 'approved' | 'rejected'
  spec_markdown    text
  estimated_tasks  int
  estimated_files  int
  created_at       timestamp
  approved_at      timestamp NULL

change_plan_tasks
  id           uuid PK
  plan_id      uuid FK
  component_id uuid FK
  description  text
  order_index  int
  status       text  -- 'pending' | 'done'
```

### Execution Layer

```sql
execution_snapshots
  id                 uuid PK
  change_id          uuid FK
  iteration          int
  files_modified     text[]  -- log cache only
  tests_run          text[]  -- log cache only
  tests_passed       int
  tests_failed       int
  error_summary      text
  diff_summary       text
  duration_ms        int
  retry_count        int
  ai_cost            numeric
  environment        text
  termination_reason text  -- 'passed' | 'max_iterations' | 'cancelled' | 'error'

file_locks
  file_id    uuid FK files
  change_id  uuid FK
  locked_at  timestamp
  UNIQUE(file_id)
```

### Outcome & Deployment Layer

```sql
change_commits
  id           uuid PK
  change_id    uuid FK
  branch_name  text
  commit_hash  text
  created_at   timestamp

change_outcomes
  change_id              uuid FK PK
  success                boolean
  regressions_detected   boolean
  rollback_triggered     boolean
  user_feedback          text
  created_at             timestamp

deployments
  id           uuid PK
  project_id   uuid FK
  change_id    uuid FK
  environment  text  -- 'staging' | 'prod'
  status       text  -- 'pending' | 'deployed' | 'failed'
  commit_hash  text
  deployed_at  timestamp NULL
```

### Production Layer

```sql
production_events
  id          uuid PK
  project_id  uuid FK
  type        text  -- 'error' | 'performance' | 'usage'
  source      text
  severity    text  -- 'low' | 'high' | 'critical'
  payload     jsonb
  created_at  timestamp

production_event_components
  event_id      uuid FK
  component_id  uuid FK
  UNIQUE(event_id, component_id)
  INDEX(component_id)

production_event_links
  event_id       uuid FK
  change_id      uuid FK
  relation_type  text  -- 'caused_by' | 'resolved_by'
  INDEX(change_id)
```

### Change Type Enforcement (Application Logic)

| Type | Rule |
|---|---|
| `bug` | must link to a `production_event` |
| `hotfix` | bypasses plan approval gate; fast-tracked to execution |
| `refactor` | requires drift justification in `change_decisions` |
| `feature` | standard flow |

---

## System Model Scanner

### Parser Interface

```typescript
interface LanguageParser {
  canParse(files: string[]): boolean
  parse(files: string[], fetcher: FileFetcher, aliases: AliasMap): Promise<ParsedComponent[]>
}

interface ParsedComponent {
  name: string
  type: 'service' | 'module' | 'api' | 'db' | 'ui'
  files: string[]
  dependsOn: string[]           // resolved component names
  unknownDependencies: boolean  // true when parser cannot resolve
  exposedInterfaces: string[]
  confidence: number            // 0–100
}
```

### TypeScriptParser

**Activation:** file tree contains `next.config.*`, `tsconfig.json`, or `package.json` with React/Next deps.

**Alias resolution (runs first):**
- Parse `tsconfig.json` → `compilerOptions.paths`
- Parse `next.config.*` if present
- Build `AliasMap`: `@/lib/auth` → resolved file path

**AST parsing via `ts-morph`:**
- Extracts: static imports, named/default exports, re-exports, dynamic imports (best effort)
- Classifies dynamic imports by AST shape:
  - Literal string `import('./foo')` → `dynamic-static-string`
  - Template literal `import(\`./plugins/${name}\`)` → `dynamic-template`
  - Computed/runtime `import(getPath())` → `dynamic-computed`
- Writes raw edges to `component_graph_edges` with `edge_type`

**Component type scoring (replaces path-based rules):**
```
signals:
  has HTTP handlers (req/res params, route.ts pattern) → +api
  has JSX/TSX return                                   → +ui
  calls db client (prisma, supabase, pg)               → +db
  complex business logic, no UI/DB signals             → +service

type = highest score
confidence = margin between top two scores (wide margin = high confidence)
```

**Anchored components** — set `is_anchored = true` automatically for:
- All files under `app/api/` or `api/`
- Any component containing migration files or Prisma schema
- Any component containing the app entrypoint

**Prioritized parsing (no hard cap):**
1. Always parse: `api/`, `services/`, `lib/`, `app/api/`
2. Expand via dependency graph: any file imported by already-parsed files
3. Continue until import graph stabilizes or marginal new components < 5%
4. Never truncate — log total file count

### HeuristicParser (Fallback)

- Groups files by top-level directory → one component per directory
- Type inferred from directory name (`routes/` → `api`, `ui/` → `ui`, `db/` → `db`, else → `module`)
- Confidence: 20–40
- `unknownDependencies: true` on all components
- No content reading — file tree only

**Downstream effect:** any component with `unknownDependencies = true` causes impact analysis to widen blast radius and increase risk (see Impact Analysis).

### Scan Modes

**Full scan** (on project creation):
```
1. Fetch file tree from GitHub API (recursive tree, single request)
2. Resolve aliases from tsconfig/next.config
3. Pick parser (TypeScript first, Heuristic fallback)
4. Run full parse
5. Write: files, system_components, component_assignment, component_graph_edges, component_dependencies
6. Write system_component_versions snapshots
7. Set projects.scan_status = 'ready'
```

**Incremental scan** (after each execution):
```
1. Get changed files from git diff (via change_commits.commit_hash)
2. Bidirectional BFS from changed files, depth = max_depth (default 3, configurable)
   - Reverse edges: who imports this file
   - Forward edges: what this file imports
3. Re-parse only files in BFS zone
4. Update affected components + dependency edges
5. Bump component_version only for touched components
6. Write change_system_snapshot_components (change_id → version ids)
```

**Failure behavior:** `scan_status = 'failed'` + reason stored. System accepts ChangeRequests but impact analysis degrades to `analysis_quality = 'low'` and forces `risk_level = 'high'`.

### Component Stability

**File assignment — probabilistic, not fixed:**

- Each file has one canonical owner (`is_primary = true`) and optional secondary associations (`is_primary = false`)
- Reassignment (changing canonical owner) requires: `new_confidence > current_confidence + 25`
- Cooldown: `scans_since_last_move >= 3` required before reassignment (derived from `last_moved_at`)
- Cooldown override: bypass when `new_confidence > current_confidence + 50` (obviously wrong case)
- Orphan files: `component_id = NULL`, `status = 'unassigned'`

**Instability detection:**
- Component with >3 reassignments OR average confidence <40 → `status = 'unstable'`
- Unstable components: impact analysis widens blast radius and increases risk

**Anchored components:** `is_anchored = true` blocks all reassignment and suppresses evolution signals.

**Split/merge detection (signal-only, no auto-action):**

Split signal:
```
component_size_ratio > 0.25   (component_files / total_project_files)
AND cohesion < 0.6            (internal_edges / total_edges)
AND NOT is_anchored
```

Merge signal:
```
shared_dependency_ratio > 0.40
AND co_change_rate > 0.60
AND NOT (both components are anchored)
AND avg_confidence > 60 for both
```

Both feed into auto-generated `refactor` ChangeRequests (`triggered_by = 'system'`).

Signal deduplication: `UNIQUE(component_id, type, target_component_id)`. On repeat: update confidence + reset `expires_at` (30 days TTL).

---

## Impact Analysis

Triggered when ChangeRequest moves `open → analyzing`. Runs async. Produces `change_impacts` and updates the ChangeRequest.

### Phase 1 — Hybrid Component Mapping

**Step 1a — Deterministic pre-seeding:**
```
seed_files = []

if change_request_files present:
  seed_files += those files

if type == 'bug' AND production_event linked:
  seed_files += files from production_event_components

keyword extraction from intent:
  grep repo file paths for significant nouns/identifiers
  seed_files += matches (confidence = 0.7 each)
```

**Step 1b — AI augmentation:**
Send to Claude: intent, change type, system model summary (component names + types + top 5 files each), already-seeded files. AI adds components/files not caught by deterministic pass. Only include AI-returned components with confidence ≥ 40.

```
final_components = deterministic_components ∪ ai_components
```

Write `change_decisions` row:
```
stage: 'analysis'
decision_type: 'component_mapping'
rationale: AI explanation
input_snapshot:  { intent, seed_files, system_model_summary }
output_snapshot: { deterministic_hits, ai_additions, top_components (top 5 by impact) }
```

Update `change_requests.status = 'analyzing_propagation'`.

### Phase 2a — File-Level BFS

```
Start: seed files (weight = 1.0)
BFS depth 3 (configurable), bidirectional:
  forward edges:  what this file imports
  reverse edges:  who imports this file

Edge-aware decay:
  static import        → decay 0.7
  re-export            → decay 0.8  (stronger coupling)
  component dependency → decay 0.6
  dynamic import       → no traversal; apply risk weight at source instead

Weight weighting:
  file_weight *= assignment_confidence / 100

BFS early termination: stop branch when weight < 0.1

Deduplication: visited[file_id] = max(weight_seen)
```

Dynamic import risk (aggregated, max 3 rows per change in `change_risk_factors`):
```
factor='dynamic_import_static'    weight = count_static * 1
factor='dynamic_import_template'  weight = count_template * 2
factor='dynamic_import_runtime'   weight = count_runtime * 4
```

Writes raw file impact weights. Writes `component_graph_edges` for any new edges discovered.

Update `change_requests.status = 'analyzing_scoring'`.

### Phase 2b — Component Aggregation + Propagation

```
Map files → components via component_assignment (primary):
  component_impact = Σ(file_weight * assignment_confidence / 100)
    for all files assigned to that component

BFS on component graph (depth 3, bidirectional, same decay rules):
  component_weight *= component_confidence / 100
  deduplication: visited[component_id] = max(weight_from_all_paths)

source tracking per component:
  'directly_mapped'  — was in initial seed
  'via_dependency'   — reached via component dependency edge
  'via_file'         — reached via file graph propagation
```

### Phase 3 — Risk Scoring

```
score = 0
score += affected_components.length * 2
score += max_depth_reached * 2
score += max_component_impact * 3        -- hotspot detection
score += avg_component_impact * 1        -- overall spread
score += requires_db_change ? 5 : 0      -- any component type='db' affected
score += touches_auth ? 5 : 0            -- auth signal detection (see below)
score += touches_anchored_component ? 5 : 0
score += has_unassigned_files ?
           min(3, total_components * 0.3) : 0
score += any_unstable_component ? 3 : 0
score += any_unknown_dependencies ? 4 : 0
score += dynamic_import_weights

-- Confidence penalty (applied after base score)
if confidence_score < 60:
  blast_radius *= 1.2
  score += 2

-- Unknown dependency penalty
if any_unknown_dependencies:
  blast_radius *= 1.2    -- stacks with confidence penalty

blast_radius = Σ(visited component weights)   -- weighted, not count

risk_level:
  score < 10  → 'low'
  10–25       → 'medium'
  > 25        → 'high'

primary_risk_factor = change_risk_factors row with max(weight)

top_components = sort affected_components by component_impact desc, take 5

propagation_summary = { max_depth_reached, nodes_visited }
```

**Auth detection signals** (not string matching):
```
touches_auth = any affected file:
  imports from: next-auth, @auth, jose, jsonwebtoken, passport, bcrypt
  OR is middleware.ts at root or app/
  OR exports route protection wrapper patterns
```

### Phase 4 — Migration Detection

**Deterministic first:**
```
requires_migration = any affected file matches:
  **/migrations/**
  **/schema.prisma
  **/*.sql
  **/models.py
  any ORM model file pattern

requires_data_change = any component of type='db' in visited
                       OR (deterministic migration signal triggered)
```

**AI fallback** (only when deterministic check is inconclusive):
Send intent + affected files. AI answers: does this change data shape?

### Output Written

```
change_impacts (risk_score, blast_radius, primary_risk_factor, analysis_quality,
                requires_migration, requires_data_change)
change_impact_components (with impact_weight, source, source_detail)
change_impact_files
change_risk_factors (one row per contributing factor)
change_decisions (analysis stage, with top_components + propagation_summary in output_snapshot)
change_system_snapshot_components (current component versions at time of analysis)
change_requests.status → 'analyzed'
change_requests.risk_level, confidence_score, confidence_breakdown, analysis_quality updated
```

### Failure Behavior — Degrade, Don't Fail

```
If AI call fails OR system model incomplete:
  change_requests.status = 'analyzed'
  change_impacts.analysis_quality = 'low'
  change_requests.risk_level = 'high'   -- forced conservative
  Requires manual scope review before plan generation is enabled
```

---

## Routes & UI

### Route Structure

```
/projects/new
/projects/[id]
/projects/[id]/system-model
/projects/[id]/changes/new
/projects/[id]/changes/[changeId]
/projects/[id]/changes/[changeId]/plan
/projects/[id]/changes/[changeId]/execution
/projects/[id]/changes/[changeId]/review
```

### Screen 1 — Project Creation (`/projects/new`)

Form: project name, repo URL, GitHub token. On submit:
- Creates `projects` row, sets `scan_status = 'scanning'`
- Triggers repo scan (background)
- Redirects to `/projects/[id]` with scan progress indicator

### Screen 2 — Project Dashboard (`/projects/[id]`)

Two panels:
- **System model strip:** `scan_status` badge, component count, last scanned time, link to `/system-model`
  - If `scan_status = 'failed'`: full-width error banner with reason + "Retry Scan" button
- **Change list:** filterable by status, type, risk_level. Default sort: `updated_at DESC`. Quick filter chips: "High risk" | "Needs review" | "Failed". Each row: title, type badge, risk badge, status badge.

Polling: every 3s while `scan_status = 'scanning'`.

### Screen 3 — System Model Browser (`/[id]/system-model`)

Component list grouped by type. Each component: name, type, file count, confidence, `unstable` badge if applicable.

Controls:
- Search bar (filter by file path or component name)
- Filter chips: "Unstable only" | "Low confidence only"

Clicking a component: shows files, dependencies, any open `component_evolution_signals`.

### Screen 4 — Change Intake (`/[id]/changes/new`)

Fields:
```
title      text input
intent     textarea
type       select: bug | feature | refactor | hotfix
priority   select: low | medium | high
tags       optional multi-input
```

`bug` type: additional field "Link production event" (optional search).

On submit: `POST /api/change-requests` → creates record, triggers analysis, redirects to change detail at `status = 'analyzing'`.

### Screen 5 — Change Detail + Impact (`/[id]/changes/[changeId]`)

**Loading state** (while `status` is any `analyzing_*` value):
```
Spinner + 3-step indicator:
  [1] Mapping intent → components   (active during 'analyzing' | 'analyzing_mapping')
  [2] Propagating dependency graph  (active during 'analyzing_propagation')
  [3] Computing risk score          (active during 'analyzing_scoring')
```
Polling every 2s.

**Analysis quality banner** (prominent, not a badge):
```
if analysis_quality == 'low':
  full-width amber banner:
  "Analysis quality is low — system model may be incomplete.
   Manual scope review required before generating a plan."
  Plan generation disabled until user explicitly confirms scope.
```

**Layout (two columns once analyzed):**

Left — Change info: title, intent, type, priority, status badge, risk badge.

Right — Impact panel:
```
Risk level badge + primary_risk_factor text
Blast radius (weighted number)
Confidence score + breakdown
Top 5 affected components:
  each row: name | type | impact weight | source
    source: "Directly mapped" | "Via dependency from [X]" | "Via file [path]"
Risk factors list (sorted by weight desc)
Propagation summary (max depth reached, nodes visited)
Flags: requires_migration, requires_data_change
```

**"Adjust Scope" section:**
```
Editable list of affected components with "Remove" button per row
"Add component" search input (searches system_components by name)

On any change:
  re-run Phase 2–3 only (skip AI mapping)
  write change_decisions row: decision_type='scope_override', triggered_by='user'
  update change_impacts + risk score in place
```

**"Analysis Details" collapsible section:**
```
Shows change_decisions rows for this change:
  AI rationale text
  Mapping decisions (deterministic vs AI hits)
  Risk factors with weights
  Propagation summary
```

**Plan generation gate:**
```
"Generate Plan" button visible when status = 'analyzed'

if risk_level == 'high' OR analysis_quality == 'low':
  clicking shows confirmation modal:
  "This change carries [high risk / low analysis confidence]. Continue?"
  Require explicit confirm before triggering plan generation.
```

### Screen 6–8 — Plan / Execution / Review

Adapted from existing `PlanScreen`, execution screen, and review screen. Data shape scoped to `change_id` instead of `job_id`. Full rework is phase 2 work.

### API Endpoints

```
POST   /api/projects                            create project
GET    /api/projects/[id]                       project + scan status
POST   /api/projects/[id]/scan                  trigger/retry scan
GET    /api/projects/[id]/system-model          components + assignments

POST   /api/change-requests                     create + trigger analysis
GET    /api/change-requests/[id]                full change + impact
PATCH  /api/change-requests/[id]                update status/fields
POST   /api/change-requests/[id]/adjust-scope   re-run Phase 2–3 with manual component list
POST   /api/change-requests/[id]/plan           trigger plan generation
```

Async operations (scan, impact analysis) write directly to DB. Client polls. No Realtime subscriptions in Phase 1.

---

## The New Pipeline (9 Steps)

| Step | Name | Key output |
|---|---|---|
| 1 | Change Intake | `ChangeRequest` created |
| 2 | Context Enrichment | Components mapped, files pulled, similar past cases retrieved |
| 3 | Impact Analysis | `ChangeImpact`: blast radius, risk level, affected components |
| 4 | Scoped Requirements | Lightweight gap check on affected scope only; max 1 iteration; critical gaps only |
| 5 | Targeted Planning | `ChangePlan`: tasks scoped to affected components only |
| 6 | Execution Loop | Iterative coding; scoped test runs; dependency-aware retries |
| 7 | Risk-Based Review | `low` → auto-approve; `medium` → light review; `high` → strict gate |
| 8 | Deploy + Observe | Merge to branch; monitor production; collect `ProductionEvent`s |
| 9 | Feedback Loop | Error → new ChangeRequest; pattern stored; weights updated |

---

## Safety Mechanisms

- **Full rollback:** every change is on an isolated branch (`sf/<id>-<slug>`); main never touched directly
- **File locks:** `file_locks` table prevents overlapping changes on same files; explicit override required
- **Diff explainability:** `change_decisions` records why every component was selected and every risk factor applied
- **Deterministic runs:** same input + same system model → same impact (AI only augments, deterministic pass always runs first)
- **Optimistic locking:** `lock_version` on `change_requests` prevents concurrent state mutations

---

## What Was Removed

- Heavy upfront requirements loops (3-iteration AI self-critique)
- Global planning for all requirements
- Full re-analysis of entire project on each change
- Unnecessary gates between minor steps
