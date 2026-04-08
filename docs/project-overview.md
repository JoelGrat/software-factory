# FactoryOS — Project Overview

> Last updated: 2026-04-08

---

## What It Is

FactoryOS is an AI-powered change delivery platform for software teams. You connect a GitHub repository, the system builds a deep model of your codebase, and then you describe changes in plain English. The AI analyses the impact, generates a task plan, writes the code inside an isolated Docker container, runs your test suite, and presents the result for review — all with a human approval gate before any code lands.

It is not a code assistant or a copilot. It is a **change pipeline** — structured, observable, and repeatable — that gets smarter about your codebase over time.

**Tech stack:** Next.js 15 (App Router), Supabase (PostgreSQL + Auth), Claude (Anthropic), Docker (`node:20-slim`), ts-morph, Vitest, TypeScript, Tailwind CSS.

---

## Architecture Overview

```
GitHub repo
    │
    ▼
Repository Scanner ──► System Model (components, files, dependencies)
                                │
                                ▼
              Change Request ──► Impact Analysis
                                │
                                ▼
                           Plan Generation ──► Human Approval Gate
                                │
                                ▼
                    Docker Execution Loop ──► Real test suite
                                │
                                ▼
                          Review & Approve ──► Done
```

---

## The Five-Stage Pipeline

### Stage 1 — Repository Scan

When a project is created with a GitHub URL and access token, FactoryOS scans the entire repository:

- Fetches the file tree and file contents via the GitHub API
- Parses TypeScript/JavaScript using ts-morph (AST-level) with a fallback heuristic parser
- Extracts **system components** — logical units of the codebase (services, modules, APIs, UI, database layers)
- Maps each file to its primary component
- Builds a **dependency graph** between components (sync/async/data/API edges)
- Stores the full model: files, components, edges, confidence scores

The result is a queryable **system model** visible at `/projects/[id]/system-model`. Scan status progresses through `pending → scanning → ready` (or `failed`).

Components are typed as: `service`, `module`, `api`, `db`, `ui`.
Scan can be retriggered at any time from the project dashboard.

---

### Stage 2 — Change Request Creation

A change request describes a desired modification to the codebase in plain English. Fields:

| Field | Values |
|---|---|
| **Title** | Short description of the change |
| **Intent** | Detailed explanation of what needs to change and why |
| **Type** | `bug` / `feature` / `refactor` / `hotfix` |
| **Priority** | `low` / `medium` / `high` |
| **Tags** | Optional free-form labels |

The AI can auto-generate or improve the intent from the title. Changes are created from the project dashboard (inline drawer) or at `/projects/[id]/changes/new`.

On creation, impact analysis is triggered automatically.

---

### Stage 3 — Impact Analysis

The system analyses the change against the system model to understand scope and risk. This runs automatically and progresses through sub-statuses:

```
analyzing → analyzing_mapping → analyzing_propagation → analyzing_scoring → analyzed
```

**What it computes:**

- **Affected components** — which system components will be touched (directly mapped, via dependency, via file proximity), ranked by impact weight
- **Risk level** — `low` / `medium` / `high`
- **Risk score** — 0–100 numeric score
- **Blast radius** — how many components are downstream
- **Risk factors** — specific reasons the risk was scored as it was
- **Flags** — `requires_migration`, `requires_data_change`

The analysis uses a multi-phase approach:
1. Map change intent to components using keyword matching + AI
2. Propagate impact through the dependency graph (BFS with edge-type decay)
3. Aggregate component-level scores
4. Score overall risk

---

### Stage 4 — Plan Generation

Once analysis is complete, the user triggers plan generation. A multi-phase AI pipeline produces:

1. **Task generation** — one focused AI call per affected component, producing concrete implementation tasks
2. **Dependency ordering** — tasks sorted leaf-first (db → repository → service → api → ui) so lower-level changes happen first
3. **Spec generation** — a full markdown implementation spec summarising the approach

The plan shows:
- A list of tasks, each linked to a component and its files
- The files that will be affected (from `component_assignment`)
- How many new files are estimated
- A rendered markdown spec

Plan status: `draft` → user reviews → `approved` (or `rejected` → regenerate).

**Human Gate 1** — the plan must be explicitly approved before execution begins.

---

### Stage 5 — Execution

After plan approval, execution runs in a Docker container (`node:20-slim`) isolated from the host:

1. **Environment setup** — container launched, git + ca-certificates installed, repo cloned with OAuth token, branch created (`sf/<change-id-prefix>-<slug>`), `npm install` run
2. **Iteration loop** — up to 10 iterations:
   - Each task is processed: file read, AI generates code patch, patch applied via ts-morph AST replacement
   - Each task is marked **done** immediately after processing (live UI feedback)
   - Type check runs (`npx tsc --noEmit`)
   - Full test suite runs (`npx vitest run`)
   - If type check or tests fail: snapshot recorded as `error`, loop continues
   - If all pass: snapshot recorded as `passed`
3. **Commit** — `git add -A && git commit && git push origin <branch>`
4. **Cleanup** — container stopped, temp dir removed

**Live log sidebar** — every key step (docker commands, task start/done, type check, tests, commit) is streamed to the execution screen in real time, polling every 2 seconds.

**Change status during execution:** `planned → executing → review` (success) or `failed`.

Execution can be re-run after completion or failure, which resets all snapshots, traces, and task statuses.

---

### Stage 6 — Review

The review page shows everything produced by the execution:

- **Stats** — tasks completed, tests passed, files changed, iteration count
- **Commit card** — branch name, commit hash, links to GitHub ("View commit", "Compare diff")
- **Files modified** — deduplicated list of all files changed across iterations
- **Task list** — each task with done/pending status

**Human Gate 2** — user clicks **Approve** to mark the change `done`, or **Re-run** to start another execution cycle.

---

## Change Status Machine

```
open
  └─► analyzing / analyzing_mapping / analyzing_propagation / analyzing_scoring
        └─► analyzed
              └─► planned  ◄─────────────────────────────────┐
                    └─► executing                             │
                          ├─► review ──► [approve] ──► done  │
                          └─► failed ──────────────── [re-run]┘
```

---

## System Model

The system model is a queryable graph of the repository's architecture:

**System Components** — named units with:
- Type: `service` / `module` / `api` / `db` / `ui`
- Status: `stable` / `unstable`
- Confidence score (0–100) — how certain the parser is about this component
- Is-anchored flag — true for entry points (routes, endpoints)
- File count

**Component Assignment** — maps files to their primary component (one primary owner per file).

**Component Graph Edges** — directed dependency edges typed as `import` / `call` / `data` / `api`.

**Component Dependencies** — higher-level dependency records between components.

The system model browser at `/projects/[id]/system-model` lets users explore, search, and filter components, view their files, and expand dependency trees.

---

## Project Settings

Configured at `/projects/[id]/settings` with two sections:

**General** — project name, description, preferred language

**Repository** — GitHub URL + access token (validated against `permissions.push` via GitHub API before save). Token is required for scanning and execution.

---

## Execution Quality Signals

Each execution iteration is recorded as a **snapshot** with:
- Files modified
- Tests passed / failed
- Termination reason: `passed` / `error` / `max_iterations` / `cancelled`
- Error summary (type check output or formatted test failures)

Each AI code-generation call is recorded as an **execution trace** with:
- Context mode used: `symbol` / `multi-symbol` / `file`
- Input/output hashes for reproducibility
- Confidence score returned by AI
- Failure type if applicable: `syntax` / `type` / `runtime` / `test` / `timeout`

---

## Tech Stack Details

| Layer | Technology |
|---|---|
| Frontend | Next.js 15 App Router, React, Tailwind CSS |
| Backend | Next.js API routes (server-side) |
| Database | Supabase (PostgreSQL) |
| Auth | Supabase Auth |
| AI | Anthropic Claude (claude-sonnet-4-6) |
| Code parsing | ts-morph (TypeScript AST) |
| Execution sandbox | Docker (`node:20-slim`) |
| Test runner | Vitest |
| Language | TypeScript throughout |

---

## Current State (2026-04-08)

| Feature | Status |
|---|---|
| Repository scanner (ts-morph + heuristic) | Shipped |
| System model browser | Shipped |
| Change request CRUD + impact analysis | Shipped |
| Multi-phase plan generation | Shipped |
| Docker execution loop (10 iterations) | Shipped |
| Live execution log sidebar | Shipped |
| Per-task real-time progress | Shipped |
| Review page + approve workflow | Shipped |
| Project settings (repo + token validation) | Shipped |
| New change drawer on dashboard | Shipped |
| Re-run after completion/failure | Shipped |
| PR auto-creation | Not started |
| E2B sandbox alternative | Not started |
| Execution_logs migration (013) | Needs `supabase db push` |
