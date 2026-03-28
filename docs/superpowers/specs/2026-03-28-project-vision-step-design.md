# Project Vision Step — Design Spec
**Date:** 2026-03-28
**Scope:** Path B — "Create from scratch" flow with async Vision step before Requirements

---

## Overview

New projects created from scratch gain a Vision step (step 1) before the existing Requirements screen. The user describes what they are building — either as free-form text or via structured fields — and clicks "Generate Requirements". The AI generates structured requirement items asynchronously, with live progress visible on screen. When generation completes the user is automatically navigated to the pre-populated Requirements screen.

---

## User Flow

```
"New Project" modal
  → enter name → POST /api/projects → project created (setup_mode = 'scratch')
  → redirect to /projects/[id]/vision

Vision screen (step 1 of 5)
  → user fills in free-form OR structured fields
  → clicks "Generate Requirements"
  → POST /api/projects/[id]/vision/generate → 202, background job starts
  → screen transitions to generating state
      - phase label updates in real time
      - requirement items appear one by one as they are inserted
      - right sidebar shows live log feed
  → when status = 'done' → auto-navigate to /projects/[id]/requirements
  → if status = 'failed' → error card + retry button
```

---

## Routing

| Route | Description |
|---|---|
| `/projects/[id]/vision` | New Vision screen |
| `/api/projects/[id]/vision` | GET (fetch vision data), PATCH (save draft) |
| `/api/projects/[id]/vision/generate` | POST — triggers background generation |

`CreateProjectForm` redirects to `/vision` instead of `/requirements` for `setup_mode = 'scratch'` projects. The `POST /api/projects` handler also creates the initial `requirements` row at project creation time (currently this happens lazily on first visit to `/requirements`) so that the generation job has a `requirement_id` available to insert items into.

---

## Data Model

### Migration: `004_vision_schema.sql`

```sql
-- Track how the project was created
alter table projects
  add column if not exists setup_mode text not null default 'scratch'
    check (setup_mode in ('scratch', 'imported'));

-- Vision content and generation status (one per project)
create table if not exists project_visions (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  mode         text not null default 'free_form'
                 check (mode in ('free_form', 'structured')),
  -- free-form
  free_form_text text not null default '',
  -- structured fields
  goal         text not null default '',
  tech_stack   text not null default '',
  target_users text not null default '',
  key_features text not null default '',
  constraints  text not null default '',
  -- generation
  status       text not null default 'draft'
                 check (status in ('draft', 'generating', 'done', 'failed')),
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (project_id)
);

-- Append-only log feed, Realtime-enabled
create table if not exists vision_logs (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  phase      text not null check (phase in ('parsing', 'generating', 'system')),
  level      text not null check (level in ('info', 'warn', 'error', 'success')),
  message    text not null,
  created_at timestamptz not null default now()
);

create index on project_visions(project_id);
create index on vision_logs(project_id);
```

---

## Vision Screen UI (`/projects/[id]/vision`)

Uses `JobShell` with step 1 active. Requires the existing `StepIndicator` to be updated from 4 to 5 steps.

### Updated step sequence

| # | Label | Icon |
|---|---|---|
| 1 | Vision | `auto_awesome` |
| 2 | Requirement | `edit_note` |
| 3 | Plan | `architecture` |
| 4 | Execution | `terminal` |
| 5 | Review | `rate_review` |

All existing `current={N}` values on requirements/plan/execution/review screens increment by 1. `StepIndicator` accepts `skipVision?: boolean` for future imported projects (4-step flow).

### State 1 — Editing (draft)

Main content:
- Heading: "Describe Your Project" + subtitle
- Pill tab toggle: **Free-form** | **Structured**
- Free-form: large textarea, placeholder "Describe what you're building — goals, key features, tech stack, target users..."
- Structured: labelled fields for Goal, Tech Stack, Target Users, Key Features, Constraints
- Both modes save independently; switching does not clear the other mode's content
- "Generate Requirements →" button in content header row, right side; disabled until the active mode has content

Right sidebar: static tips panel ("Be specific about your tech stack", "Describe key user flows", "Mention constraints or non-goals").

### State 2 — Generating

Triggered when `POST /api/projects/[id]/vision/generate` returns 202. The form is replaced by a live list:

- Phase label at top with animated indicator: "Parsing your vision..." → "Generating requirements..." → "Finalising..."
- Requirement items appear one by one as they are inserted into `requirement_items`:
  - Completed items: check icon + type badge + title + description
  - Current item: pulsing spinner
- Right sidebar switches from tips to **live log feed** (same component as execution screen, fed by `vision_logs` Realtime subscription)

### State 3 — Failed

- Error card with message from `project_visions.error`
- "Retry" button re-POSTs to generate endpoint
- Log feed remains visible

---

## Generation API

### `POST /api/projects/[id]/vision/generate`

1. Auth check — user must own the project
2. Validate vision exists and active mode has content
3. Set `project_visions.status = 'generating'`
4. Return `202 Accepted` immediately
5. Background processing (via same mechanism as existing job runner):
   - Write `vision_logs` entry: `{ phase: 'system', level: 'info', message: 'Starting generation...' }`
   - Write `vision_logs` entry: `{ phase: 'parsing', level: 'info', message: 'Parsing vision...' }`
   - Call Claude (streaming) with vision content — see prompt below
   - Parse stream: as each complete requirement item arrives, immediately insert into `requirement_items`
   - Write `vision_logs` success entries as phases complete
   - Populate `requirements.raw_input` with a formatted summary of the vision
   - Set `project_visions.status = 'done'`
   - On any failure: set `status = 'failed'`, write error to `project_visions.error` and `vision_logs`

### Claude prompt strategy

System: instruct Claude to act as a requirements analyst. Generate a list of requirement items from the provided vision description. Each item: `type` (functional | non-functional | constraint | assumption), `title` (short, ≤ 10 words), `description` (1–2 sentences), `priority` (high | medium | low).

User message: the vision content (free-form text or a formatted rendering of the structured fields).

Output format: newline-delimited JSON objects (one per line) so the stream can be parsed item-by-item as it arrives — each complete line triggers an immediate DB insert and a Realtime event.

---

## Client-side Realtime Subscriptions (Vision screen)

| Table | Event | Action |
|---|---|---|
| `project_visions` | UPDATE where `project_id = id` | Watch `status` — navigate to `/requirements` on `'done'`, show error on `'failed'` |
| `vision_logs` | INSERT where `project_id = id` | Append to log feed in right sidebar |
| `requirement_items` | INSERT where `requirement_id = req.id` | Append item to live list in main content |

---

## Components

| Component | Location | Notes |
|---|---|---|
| `VisionScreen` | `components/agent/vision-screen.tsx` | Client component, handles all 3 states |
| `VisionForm` | inside `VisionScreen` | Free-form / structured toggle + fields |
| Updated `StepIndicator` | `components/agent/step-indicator.tsx` | 5 steps, `skipVision` prop |
| Vision page | `app/projects/[id]/vision/page.tsx` | Server component, fetches project + vision |

---

## Error Handling

- If vision has no content when generate is called: 400, button stays disabled client-side
- If Claude call fails: status → `'failed'`, error surfaced in UI with retry
- If user navigates away during generation: generation continues in background; returning to `/vision` shows current state via initial DB fetch + Realtime re-subscription
- Partial generation (some items inserted before failure): items remain; retry clears existing items and restarts

---

## Out of Scope (Path B)

- GitHub repo connection (Path A)
- Editing the vision after generation is complete
- Re-generating requirements after the vision step is done
- Vision for projects created before this feature (they skip Vision, `setup_mode` defaults to `'scratch'` but no vision row exists — requirements page checks for this and skips the Vision step)
