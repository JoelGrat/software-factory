# Software Factory — User Guide

Software Factory is an AI-powered platform that transforms raw product requirements into working code. You paste in requirements, the AI structures and validates them, then an agent writes and tests the code — with you reviewing at every key step.

---

## Quick Start

1. Sign up and log in
2. Create a project and set its target path (the local directory where code will be written)
3. Paste your requirements and click **Analyze**
4. Resolve any gaps the AI identifies
5. Mark requirements as **Ready for Development**
6. Run the agent, approve the plan, watch it code
7. Review the generated code and accept the changes

---

## Step-by-Step Walkthrough

### 1. Creating a Project

Go to **Projects** (`/projects`) and click **New Project**.

Fill in:
- **Name** — a descriptive project name
- **Target path** — the absolute path to the local codebase the agent will write into (e.g. `/home/user/my-app`)
- **Test command** (optional) — the command the agent runs to verify its work (e.g. `npm test`)

Your project appears in the project list. Click it to open the requirements workspace.

---

### 2. Analyzing Requirements

Open your project and go to the **Requirements** tab.

Paste your requirements into the **Input** tab — any format works: bullet points, plain prose, user stories, meeting notes, or a mix.

Click **Analyze**. The pipeline runs in four stages, with live progress:

| Stage | What happens |
|---|---|
| **Parse** | Extracts structured items: functional requirements, non-functional requirements, constraints, and assumptions |
| **Detect Gaps** | Finds missing, ambiguous, conflicting, or incomplete requirements |
| **Generate Questions** | Creates clarifying questions for each gap |
| **Create Tasks** | Generates investigation tasks to resolve ambiguities |

---

### 3. Reviewing Structured Items

Switch to the **Structured** tab to see your requirements organized by type:

- **Functional** — what the system must do
- **Non-functional** — performance, security, auditability
- **Constraints** — hard limits and boundaries
- **Assumptions** — things being taken as given

Each item shows its priority (high / medium / low) and any linked gaps. A counter at the top tells you how many items are blocking development.

---

### 4. Resolving Gaps

Switch to the **Gaps** tab to see what the AI flagged.

Each gap shows:
- **Severity**: critical, major, or minor
- **Category**: missing, ambiguous, conflicting, or incomplete
- **Confidence score**: how certain the AI is this is a real problem

For each gap you can:

| Action | When to use |
|---|---|
| **Answer a question** | The AI generated a clarifying question — type your answer |
| **Record a decision** | Document a design decision and your rationale |
| **Generate questions** | Ask the AI to create questions for gaps it didn't auto-generate for |
| **Dismiss** | Mark a gap as not relevant |

The sidebar shows overall coverage %, how many critical gaps remain blocking, and current status.

Critical gaps must be resolved before you can proceed.

---

### 5. Marking Ready for Development

Once all critical gaps are resolved, click **Mark Ready for Development**.

This locks the requirements and enables the **Run Agent** button.

---

### 6. Running the Planning Agent

Click **Run Agent**. The planner agent reads your requirements and the actual project files at the target path, then generates an implementation plan.

You are taken to the **Plan Review** page, which shows:
- Files to **create** (green)
- Files to **modify** (orange)
- **Test approach** — how the agent will verify its work
- **Implementation tasks** — numbered steps with descriptions and affected files

Review the plan carefully. When satisfied, click **Approve Plan → Start Coding**. To abort, click **Cancel**.

---

### 7. Watching the Coding Agent

After approval you are taken to the **Execution** page. The agent works through the plan in a test-driven loop:

1. Generates code changes and applies them to your target path
2. Runs the test command
3. If tests fail, feeds the errors back and retries (up to 10 iterations)
4. If tests pass, creates a git branch and moves to review

The live log shows:
- Current iteration number
- Number of files changed
- Test pass/fail counts
- Any errors (highlighted in red)

Logs auto-scroll. You can watch the full process or leave and come back.

---

### 8. Reviewing Generated Code

When the agent finishes you land on the **Review** page, which shows:
- A git diff of every change made
- Test result summary

If the changes look good, accept them. The branch is committed to your local repository.

If something is wrong, you can cancel and restart from the requirements step with updated input.

---

## Key Concepts

**Gap** — an issue in your requirements that could cause problems during implementation. Resolving gaps before coding prevents the agent from making wrong assumptions.

**Job** — one run of the agent against a set of requirements. Each job has a plan, an execution log, and a review step.

**Target path** — the local directory the agent reads from and writes to. Make sure it is a git repository with a clean working tree before running the agent.

**Iteration** — one pass of the coding loop (write → test → evaluate). The agent retries automatically until tests pass or the iteration limit is reached.

---

## Tips

- The more specific your requirements, the fewer gaps will be detected and the better the generated code.
- Answer AI questions with as much context as you have — those answers go directly into the agent's prompt.
- Set a real test command in your project settings. Without it the agent cannot verify its own work.
- Review the plan before approving. Cancelling after coding has started is possible but wastes a run.
- The agent writes to your actual filesystem. Commit or stash any in-progress work before running a job.
