# FactoryOS — User Guide

FactoryOS connects to your GitHub repository, learns its architecture, and lets you describe changes in plain English. The AI analyses the impact, writes the code in an isolated environment, runs your tests, and asks for your approval before anything is final.

---

## Prerequisites

- A GitHub repository (public or private)
- A GitHub **personal access token** with `repo` scope (read + write access)
- Docker Desktop running locally (required for code execution)

---

## Quick Start

1. Sign up and log in at `/`
2. Create a project and connect your GitHub repository
3. Wait for the repository scan to complete
4. Create a change request describing what you want
5. Review the impact analysis
6. Approve the generated implementation plan
7. Watch the AI execute and test the code
8. Review the result and approve

---

## Step-by-Step Walkthrough

### 1. Create a Project

Go to **Projects** and click **New Project**.

Fill in:
- **Name** — a label for this project
- **Repository URL** — the full GitHub URL, e.g. `https://github.com/org/repo`
- **Access token** — a GitHub PAT with `repo` scope (read + write). This is validated immediately for push access.

Click **Create Project**. The system immediately starts scanning the repository.

---

### 2. Wait for the Repository Scan

The scan appears as a progress strip on the project dashboard. It runs through several milestones:

- Fetching file tree
- Parsing TypeScript files (AST-level)
- Identifying system components
- Building dependency graph
- Storing file → component mappings

When complete, the dashboard shows **Model quality** (`HIGH` / `MEDIUM` / `LOW`) and a count of components, files, and dependencies.

You can explore the full system model at **System Model** in the left navigation. Components are colour-coded by type (`api`, `service`, `db`, `ui`, `module`) and you can expand each to see its files and dependencies.

> If the scan fails, check that the repository URL is correct and the access token has read access.

To re-scan after code changes, click **Rescan** on the dashboard.

---

### 3. Create a Change Request

From the project dashboard, click **New Change** (top right of the Changes section). A drawer opens with the intake form.

Fill in:
- **Title** — a short description, e.g. "Fix user session expiry bug"
- **Intent** — a detailed explanation of what needs to change and why. The more specific, the better. Click **Generate** to have the AI write this from your title, or **Improve** to refine what you've already written.
- **Type** — `bug` / `feature` / `refactor` / `hotfix`
- **Priority** — `low` / `medium` / `high`
- **Tags** — optional labels (press Enter to add)

Click **Submit Change**. You are taken to the change detail page.

---

### 4. Review the Impact Analysis

Impact analysis runs automatically after the change is created. The status strip on the change page shows live progress through the analysis phases.

When complete you see:

**Risk summary**
- Risk level: `low` / `medium` / `high`
- Risk score (0–100)
- Blast radius — number of downstream components affected
- Flags: migration required, data change required

**Affected components** — ranked by impact weight, showing which parts of the codebase will be touched and why (directly mapped, via dependency, or via file proximity).

**Risk factors** — specific reasons the risk was scored as it was (e.g. "touches auth layer", "high incoming dependency count").

---

### 5. Generate and Approve the Implementation Plan

Once analysis is complete, click **Generate Plan**.

The AI produces:
- A set of **tasks** — one or more per affected component, each with a concrete description
- **File mappings** — which existing files each task touches (visible in the Tasks tab and the Files tab)
- An estimate of how many new files will be created
- A **spec** — a full markdown description of the implementation approach

**Review the plan carefully:**

- Switch between the **Tasks**, **Files**, and **Spec** tabs
- The Tasks tab shows each task with its component name and the specific file(s) it will edit
- The Files tab shows a deduplicated list of all affected files, plus an estimate of new files

If the plan looks wrong, click **Regenerate** to produce a new one.

When satisfied, click **Approve Plan**. This is **Human Gate 1** — once approved, execution can begin.

---

### 6. Execute

Click **Execute** on the approved plan (or navigate to **Execution** in the breadcrumb).

The system:
1. Launches a Docker container (`node:20-slim`)
2. Installs git and dependencies inside the container
3. Clones your repository and creates a branch (`sf/<id>-<slug>`)
4. Runs `npm install`
5. Processes each task: reads the relevant file, calls the AI to generate a code patch, applies it via AST replacement
6. Runs `npx tsc --noEmit` (type check)
7. Runs `npx vitest run` (test suite)
8. If checks fail, records the error and retries (up to 10 iterations)
9. If all checks pass, commits and pushes to the branch

**What you see on the execution screen:**

- **Tasks panel** (left) — each task turns green as it is processed, one by one
- **Iterations** — each completed iteration appears with pass/fail counts; a live "running" row shows the current iteration
- **Log sidebar** (right) — real-time log of every action: Docker commands (`$`), orchestrator steps (`›`), successes (`✓`), errors (`✗`)

You can leave the page and come back — execution runs in the background and the screen polls for updates every 2 seconds.

**If execution fails:**
- The last error snapshot is shown with a diagnosis (Docker not running, type errors, failing tests, etc.)
- Fix the underlying problem then click **Retry Execution**

---

### 7. Review and Approve

When execution succeeds, the status changes to **review** and you are prompted to go to the Review page.

The review page shows:
- **Stats** — tasks completed, tests passed, files modified, iterations taken
- **Commit** — branch name and commit hash, with links to view the commit and compare the diff on GitHub
- **Files modified** — every file changed by the execution
- **Tasks** — the full task list with done status

If everything looks correct, click **Approve**. The change moves to `done`. The branch remains open on GitHub for you to open a pull request manually.

If something is wrong, click **Re-run** to start another execution cycle from scratch.

---

## The Change Lifecycle

```
Created → Analyzing → Analyzed → [Generate Plan] → Planned
    → [Approve Plan] → Executing → Review → [Approve] → Done
                                → Failed  → [Re-run]  → Executing
```

Every state is visible on the change detail page with a step indicator at the top.

---

## Project Settings

Go to **Settings** in the left navigation (or the gear icon in the header).

**General** — edit project name and description.

**Repository** — update the GitHub URL and access token. When you save, the system validates that the token has push access to the repository. The token hint shows whether a token is already saved.

---

## The System Model

The system model browser (`/projects/[id]/system-model`) lets you explore your codebase:

- Search components by name
- Filter by type (`api`, `service`, `db`, `ui`, `module`)
- Expand a component to see its files and dependencies (what it depends on, what depends on it)
- See confidence scores and stability status

The model is used as the foundation for every impact analysis and plan. Re-scanning after significant refactors keeps it accurate.

---

## Dashboard Insights

The project dashboard shows:

- **Scan status and model quality** — confidence in the system model
- **System overview** — component count, file count, dependency edges, confidence distribution
- **Architecture breakdown** — how many components of each type
- **Tech stack** — detected technologies
- **Hotspots** — most highly connected components (high blast radius)
- **Suggested improvements** — AI-generated recommendations based on structural patterns (high coupling, oversized components, etc.), each with a one-click "Create Change" button pre-filling the title
- **Changes** — all change requests for this project with status badges

---

## Tips

- **Write a detailed intent.** The AI uses your intent to map the change to components. Vague intent → wrong components → wrong plan.
- **Use the Generate button** for intent if you are unsure how to phrase it — then edit what comes back.
- **Review the Files tab in the plan** before approving. If key files are missing, regenerate.
- **Keep Docker Desktop running** before clicking Execute. If Docker is not running, the execution will fail immediately with a clear error.
- **Check the log sidebar** during execution. It shows exactly what the AI is doing and surfaces errors immediately.
- **Re-scan after major refactors.** The system model only knows what it has scanned. Stale models lead to incorrect impact analysis.
- **The branch stays open after approval.** Open a pull request on GitHub manually when ready to merge.

---

## Common Errors

| Error | Cause | Fix |
|---|---|---|
| "Docker is not running" | Docker Desktop not started | Open Docker Desktop, wait for the engine to show Running |
| "No repository configured" | Missing repo URL in settings | Go to Settings → Repository |
| "No access token configured" | Missing GitHub token | Go to Settings → Repository, add a token with `repo` scope |
| "Repository access failed" | Wrong URL or token without push access | Check the URL and token in Settings → Repository |
| "Git installation failed" | Docker container can't reach the internet | Check Docker Desktop's network settings / proxy config |
| "Type check failed" | The repository already has TypeScript errors | Fix the pre-existing type errors in your codebase before re-running |
| "Tests failed" | Pre-existing test failures or AI introduced a regression | Review the error detail in the expanded iteration row |
