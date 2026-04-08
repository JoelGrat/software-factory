# New File Creation in Execution Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the execution pipeline generate new files when a plan task requires creating a file that doesn't yet exist in the repo.

**Architecture:** Add a `new_file_path` column to `change_plan_tasks` to tag tasks that create new files. The plan generator populates this from the architecture phase's new-file list. The orchestrator branches on this column: instead of extracting and patching an existing symbol, it asks the AI for a complete new file and writes it to disk.

**Tech Stack:** TypeScript, Supabase (Postgres), ts-morph, Docker, Vitest.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `supabase/migrations/009_new_file_task.sql` | Create | Add `new_file_path` column to `change_plan_tasks` |
| `lib/planning/types.ts` | Modify | Add `newFilePath?` to `PlannerTask`, `newFilePaths` to `PlannerArchitecture` |
| `lib/planning/prompt-builders.ts` | Modify | Add `newFilePaths` field to architecture prompt JSON spec |
| `lib/planning/phases.ts` | Modify | Parse `newFilePaths` from architecture AI response |
| `lib/planning/plan-generator.ts` | Modify | Write `new_file_path` into task rows |
| `lib/execution/types.ts` | Modify | Add `NewFileCreation` interface |
| `lib/execution/prompt-builders.ts` | Modify | Add `buildNewFilePrompt()` |
| `lib/execution/executors/code-executor.ts` | Modify | Add `createFile()` to interface and mock |
| `lib/execution/executors/docker-executor.ts` | Modify | Implement `createFile()` |
| `lib/execution/execution-orchestrator.ts` | Modify | Handle new-file tasks in task loop; re-create on reset |
| `tests/lib/execution/prompt-builders.test.ts` | Modify | Tests for `buildNewFilePrompt` |
| `tests/lib/execution/execution-orchestrator.test.ts` | Modify | Tests for new-file task code path |

---

## Task 1: DB Migration

**Files:**
- Create: `supabase/migrations/009_new_file_task.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/009_new_file_task.sql
-- Add new_file_path to change_plan_tasks.
-- When non-null, this task creates a brand-new file rather than modifying an existing one.
alter table change_plan_tasks
  add column if not exists new_file_path text;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/009_new_file_task.sql
git commit -m "feat: add new_file_path column to change_plan_tasks"
```

---

## Task 2: Shared Types

**Files:**
- Modify: `lib/planning/types.ts`
- Modify: `lib/execution/types.ts`

- [ ] **Step 1: Add `newFilePath` to `PlannerTask` and `newFilePaths` to `PlannerArchitecture`**

In `lib/planning/types.ts`, replace the two interfaces:

```typescript
export interface PlannerArchitecture {
  approach: string
  branchName: string
  testApproach: string
  estimatedFiles: number
  componentApproaches: Record<string, string>  // componentName → approach
  newFilePaths: string[]  // new files the plan requires creating
}

export interface PlannerTask {
  description: string
  componentId: string
  componentName: string
  orderIndex: number
  newFilePath?: string  // set when task creates a new file rather than modifying an existing one
}
```

- [ ] **Step 2: Add `NewFileCreation` to execution types**

In `lib/execution/types.ts`, add after the `FilePatch` interface block (after line 46):

```typescript
// ── New file creation ─────────────────────────────────────────────────────────

export interface NewFileCreation {
  path: string
  content: string
}
```

- [ ] **Step 3: Run type check to make sure nothing broke**

```bash
npx tsc --noEmit
```

Expected: no errors (fields are optional/additive).

- [ ] **Step 4: Commit**

```bash
git add lib/planning/types.ts lib/execution/types.ts
git commit -m "feat: add newFilePath to PlannerTask and NewFileCreation type"
```

---

## Task 3: Prompt Builders

**Files:**
- Modify: `lib/planning/prompt-builders.ts`
- Modify: `lib/execution/prompt-builders.ts`
- Modify: `tests/lib/execution/prompt-builders.test.ts`

- [ ] **Step 1: Write the failing tests first**

Add to `tests/lib/execution/prompt-builders.test.ts` (import `buildNewFilePrompt` at the top):

```typescript
import {
  buildSymbolPatchPrompt,
  buildMultiSymbolPatchPrompt,
  buildFilePatchPrompt,
  buildNewFilePrompt,
} from '@/lib/execution/prompt-builders'
```

Then add at the bottom of the file:

```typescript
describe('buildNewFilePrompt', () => {
  it('includes the target file path', () => {
    const p = buildNewFilePrompt(
      { description: 'Create UserRepository class', intent: 'add user CRUD' },
      'lib/repositories/user-repository.ts'
    )
    expect(p).toContain('lib/repositories/user-repository.ts')
  })

  it('includes the task description and intent', () => {
    const p = buildNewFilePrompt(
      { description: 'Create UserRepository class', intent: 'add user CRUD' },
      'lib/repositories/user-repository.ts'
    )
    expect(p).toContain('Create UserRepository class')
    expect(p).toContain('add user CRUD')
  })

  it('asks for newFileContent and confidence in the output schema', () => {
    const p = buildNewFilePrompt(
      { description: 'Create UserRepository class', intent: 'add user CRUD' },
      'lib/repositories/user-repository.ts'
    )
    expect(p).toContain('newFileContent')
    expect(p).toContain('confidence')
  })

  it('includes previous error when provided', () => {
    const p = buildNewFilePrompt(
      { description: 'Create UserRepository class', intent: 'add user CRUD' },
      'lib/repositories/user-repository.ts',
      'syntax error: unexpected token on line 5'
    )
    expect(p).toContain('syntax error: unexpected token on line 5')
    expect(p).toContain('Previous Attempt Failed')
  })
})
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npx vitest run tests/lib/execution/prompt-builders.test.ts
```

Expected: 4 failures — `buildNewFilePrompt is not a function`.

- [ ] **Step 3: Add `buildNewFilePrompt` to `lib/execution/prompt-builders.ts`**

Add at the end of `lib/execution/prompt-builders.ts`:

```typescript
export function buildNewFilePrompt(
  task: PatchTask,
  filePath: string,
  previousError?: string
): string {
  return `You are a TypeScript code generation expert. Create a new file to implement the task below.

## Task
${task.description}

## Intent
${task.intent}

## New File Path
${filePath}
${previousError ? `\n## Previous Attempt Failed\n${previousError}\nDo NOT repeat the same approach.\n` : ''}
## Output
Return a JSON object:
{
  "newFileContent": "<complete, valid TypeScript file content>",
  "confidence": <0-100 integer — your confidence this is correct>,
  "reasoning": "<one sentence explanation>"
}`
}
```

- [ ] **Step 4: Add `newFilePaths` to the architecture prompt in `lib/planning/prompt-builders.ts`**

In `buildArchitecturePrompt`, replace the JSON response block (the last template literal block in the function) with:

```typescript
  return `You are planning the implementation of a software change.

Change: ${change.title}
Type: ${change.type}
Intent: ${change.intent}

Impacted components (from impact analysis):
${componentList}

Design the high-level approach for implementing this change.
For each component, describe what needs to change and how.
If this change requires creating brand-new files not yet in the codebase, list their paths.

Respond with JSON:
{
  "approach": "One paragraph describing the overall implementation approach",
  "branchName": "sf/xxxxxx-short-slug",
  "testApproach": "Brief testing strategy",
  "estimatedFiles": 5,
  "componentApproaches": {
    "ComponentName": "Approach for this component"
  },
  "newFilePaths": ["relative/path/to/new-file.ts"]
}`
```

- [ ] **Step 5: Run the tests — all should pass**

```bash
npx vitest run tests/lib/execution/prompt-builders.test.ts
```

Expected: all tests green.

- [ ] **Step 6: Commit**

```bash
git add lib/execution/prompt-builders.ts lib/planning/prompt-builders.ts tests/lib/execution/prompt-builders.test.ts
git commit -m "feat: add buildNewFilePrompt and newFilePaths in architecture prompt"
```

---

## Task 4: Plan Generator Emits New File Tasks

**Files:**
- Modify: `lib/planning/phases.ts`
- Modify: `lib/planning/plan-generator.ts`

- [ ] **Step 1: Parse `newFilePaths` in `runArchitecturePhase`**

In `lib/planning/phases.ts`, update `runArchitecturePhase`:

1. Add `newFilePaths` to the `responseSchema` properties block:

```typescript
  const result = await ai.complete(prompt, {
    responseSchema: {
      type: 'object',
      properties: {
        approach: { type: 'string' },
        branchName: { type: 'string' },
        testApproach: { type: 'string' },
        estimatedFiles: { type: 'number' },
        componentApproaches: { type: 'object' },
        newFilePaths: { type: 'array', items: { type: 'string' } },
      },
      required: ['approach', 'branchName', 'testApproach', 'estimatedFiles', 'componentApproaches'],
    },
    maxTokens: 2048,
  })
```

2. Update the return statement to include `newFilePaths`:

```typescript
  return {
    approach: parsed.approach,
    branchName: parsed.branchName,
    testApproach: parsed.testApproach,
    estimatedFiles: parsed.estimatedFiles ?? 0,
    componentApproaches: parsed.componentApproaches ?? {},
    newFilePaths: parsed.newFilePaths ?? [],
  }
```

- [ ] **Step 2: Create new-file tasks in `plan-generator.ts`**

In `lib/planning/plan-generator.ts`, after the existing task collection loop (after the `} else {` fallback block closes, before `// Phase 3: Deterministic ordering`), add:

```typescript
    // New-file tasks: one task per file the architecture flagged as needing creation
    for (const filePath of architecture.newFilePaths) {
      allTasks.push({
        description: `Create new file: ${filePath}`,
        componentId: null as any,
        componentName: 'New File',
        orderIndex: allTasks.length,
        newFilePath: filePath,
      })
    }
```

- [ ] **Step 3: Write `new_file_path` into the task rows**

In the same file, update the `taskRows` mapping to include `new_file_path`:

```typescript
      const taskRows = orderedTasks.map(t => ({
        plan_id: plan.id,
        component_id: t.componentId ?? null,
        description: t.description,
        order_index: t.orderIndex,
        status: 'pending',
        new_file_path: t.newFilePath ?? null,
      }))
```

- [ ] **Step 4: Run type check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/planning/phases.ts lib/planning/plan-generator.ts
git commit -m "feat: emit new-file tasks from plan generator"
```

---

## Task 5: `createFile` on CodeExecutor

**Files:**
- Modify: `lib/execution/executors/code-executor.ts`
- Modify: `lib/execution/executors/docker-executor.ts`

- [ ] **Step 1: Add `createFile` to the `CodeExecutor` interface**

In `lib/execution/executors/code-executor.ts`, add to the `CodeExecutor` interface after `applyPatch`:

```typescript
  /** Write a brand-new file to the environment (localWorkDir + container) */
  createFile(env: ExecutionEnvironment, path: string, content: string): Promise<PatchResult>
```

- [ ] **Step 2: Add `createFile` to `MockCodeExecutor`**

In the same file, add after the `applyPatch` method in `MockCodeExecutor`:

```typescript
  async createFile(_env: ExecutionEnvironment, _path: string, _content: string): Promise<PatchResult> {
    this.calls.push('createFile')
    return this.patchResult
  }
```

- [ ] **Step 3: Add `mkdir` to the imports in `docker-executor.ts`**

In `lib/execution/executors/docker-executor.ts`, update the `node:fs/promises` import:

```typescript
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
```

- [ ] **Step 4: Implement `createFile` in `DockerExecutor`**

Add after the `applyPatch` method in `DockerExecutor`:

```typescript
  async createFile(env: ExecutionEnvironment, path: string, content: string): Promise<PatchResult> {
    const localPath = join(env.localWorkDir, path)
    const localDir = localPath.substring(0, localPath.lastIndexOf('/'))
    try {
      await mkdir(localDir, { recursive: true })
      await writeFile(localPath, content, 'utf8')
      const containerPath = `${env.containerWorkDir}/${path}`
      const containerDir = containerPath.substring(0, containerPath.lastIndexOf('/'))
      await dockerExec(env.containerId, `mkdir -p ${containerDir}`)
      await exec(`docker cp ${localPath} ${env.containerId}:${containerPath}`)
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }
```

- [ ] **Step 5: Run type check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/execution/executors/code-executor.ts lib/execution/executors/docker-executor.ts
git commit -m "feat: add createFile to CodeExecutor interface and DockerExecutor"
```

---

## Task 6: Orchestrator Handles New File Tasks

**Files:**
- Modify: `lib/execution/execution-orchestrator.ts`
- Modify: `tests/lib/execution/execution-orchestrator.test.ts`

- [ ] **Step 1: Write a failing test for the new-file task path**

Add to `tests/lib/execution/execution-orchestrator.test.ts`, inside the `describe('runExecution', ...)` block:

```typescript
  it('calls createFile when task has new_file_path', async () => {
    const newFileTasks = [
      { id: 't2', plan_id: 'plan-1', component_id: null, description: 'Create new file: lib/foo.ts', order_index: 0, status: 'pending', new_file_path: 'lib/foo.ts' },
    ]
    const { db } = makeMockDb()
    // Override change_plan_tasks to return a new-file task
    const dbWithNewFile = {
      ...db,
      from: (table: string) => {
        if (table === 'change_plan_tasks') {
          return {
            select: () => ({
              eq: () => ({
                order: () => Promise.resolve({ data: newFileTasks }),
              }),
            }),
            update: (data: Record<string, unknown>) => ({
              eq: () => ({
                eq: () => Promise.resolve({ error: null }),
              }),
            }),
          }
        }
        return (db as any).from(table)
      },
    } as unknown as SupabaseClient

    const executor = new MockCodeExecutor()
    const ai = new MockAIProvider()
    // AI returns a full file content for new-file tasks
    ai.nextResponse = JSON.stringify({ newFileContent: 'export const foo = 1', confidence: 90, reasoning: 'simple' })

    await runExecution('cr1', dbWithNewFile, ai, executor)

    expect(executor.calls).toContain('createFile')
  })

  it('snapshot files_modified includes new file when createFile succeeds', async () => {
    const newFileTasks = [
      { id: 't3', plan_id: 'plan-1', component_id: null, description: 'Create new file: lib/bar.ts', order_index: 0, status: 'pending', new_file_path: 'lib/bar.ts' },
    ]
    const snapshotInserts: any[] = []
    const { db } = makeMockDb()

    const dbCapture = {
      ...db,
      from: (table: string) => {
        if (table === 'change_plan_tasks') {
          return {
            select: () => ({
              eq: () => ({
                order: () => Promise.resolve({ data: newFileTasks }),
              }),
            }),
            update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
          }
        }
        if (table === 'execution_snapshots') {
          return {
            insert: (data: any) => {
              snapshotInserts.push(data)
              return Promise.resolve({ data: [{ id: 'snap-1' }], error: null })
            },
          }
        }
        return (db as any).from(table)
      },
    } as unknown as SupabaseClient

    const executor = new MockCodeExecutor()
    const ai = new MockAIProvider()
    ai.nextResponse = JSON.stringify({ newFileContent: 'export const bar = 2', confidence: 90, reasoning: 'simple' })

    await runExecution('cr1', dbCapture, ai, executor)

    const successSnapshot = snapshotInserts.find(s => s.termination_reason === 'passed')
    expect(successSnapshot?.files_modified).toContain('lib/bar.ts')
  })
```

Also check what `MockAIProvider` looks like — you'll need to add `nextResponse` support if it doesn't exist:

```bash
grep -n "nextResponse\|MockAIProvider" lib/ai/adapters/mock.ts
```

If `MockAIProvider` doesn't have `nextResponse`, update the test to use whatever pattern it supports (e.g., setting `mockResponse` directly).

- [ ] **Step 2: Run the failing tests**

```bash
npx vitest run tests/lib/execution/execution-orchestrator.test.ts
```

Expected: the two new tests fail (no `createFile` call, snapshot doesn't include new file path).

- [ ] **Step 3: Update `ExecutionState` in the orchestrator to track accepted new files**

In `lib/execution/execution-orchestrator.ts`, update the `ExecutionState` interface:

```typescript
interface ExecutionState {
  iteration: number
  aiCallCount: number
  startedAt: number
  acceptedPatches: FilePatch[]
  acceptedNewFiles: NewFileCreation[]   // ← add this line
  executionScope: ExecutionScope
  errorHistory: Map<string, number>
  limits: ExecutionLimits
}
```

Add `NewFileCreation` to the imports from `./types`:

```typescript
import type {
  FilePatch, SymbolContext, ExecutionScope, ExecutionLimits,
  ContextMode, TestScope, BehavioralScope, ExecutionEnvironment,
  NewFileCreation,
} from './types'
```

Also add `buildNewFilePrompt` to the import from `./prompt-builders`:

```typescript
import { buildSymbolPatchPrompt, buildFilePatchPrompt, buildNewFilePrompt } from './prompt-builders'
```

- [ ] **Step 4: Initialize `acceptedNewFiles` in the state**

In `runExecution`, update the `state` initializer:

```typescript
    const state: ExecutionState = {
      iteration: 0,
      aiCallCount: 0,
      startedAt: Date.now(),
      acceptedPatches: [],
      acceptedNewFiles: [],
      executionScope: { plannedFiles, addedViaPropagation: [] },
      errorHistory: new Map(),
      limits,
    }
```

- [ ] **Step 5: Update the task query to include `new_file_path`**

In `runExecution`, update the tasks `select` call:

```typescript
    const { data: rawTasks } = await db
      .from('change_plan_tasks')
      .select('id, component_id, description, order_index, status, new_file_path')
      .eq('plan_id', plan.id)
      .order('order_index', { ascending: true })
```

Update the `PlanTask` interface at the top of the file:

```typescript
interface PlanTask {
  id: string
  component_id: string | null
  description: string
  order_index: number
  status: string
  new_file_path: string | null
}
```

- [ ] **Step 6: Add the new-file task branch in the task loop**

In the `for (const task of pendingTasks)` loop, replace the "No files to modify — mark done immediately" block:

```typescript
        // No files to modify — check if this is a new-file creation task
        if (filePaths.length === 0) {
          if (task.new_file_path) {
            // New file creation task
            if (state.aiCallCount < limits.maxAiCalls) {
              const prompt = buildNewFilePrompt(
                { description: task.description, intent: (change as { intent: string }).intent },
                task.new_file_path
              )
              state.aiCallCount++
              const aiResult = await ai.complete(prompt, { maxTokens: 4096 })
              let parsed: { newFileContent?: string; confidence?: number } = {}
              try { parsed = JSON.parse(aiResult.content) } catch { /* skip */ }
              const newContent = parsed.newFileContent ?? ''
              const confidence = parsed.confidence ?? 0
              if (newContent && confidence >= limits.confidenceThreshold) {
                const result = await executor.createFile(env, task.new_file_path, newContent)
                if (result.success) {
                  iterationNewFiles.push({ path: task.new_file_path, content: newContent })
                  await log('success', `Created ${task.new_file_path}`)
                } else {
                  await log('error', `Failed to create ${task.new_file_path}: ${result.error}`)
                }
              }
            }
          }
          processedTaskIds.push(task.id)
          await db.from('change_plan_tasks').update({ status: 'done' }).eq('id', task.id).eq('plan_id', plan.id)
          await log('success', `Done (no files to modify)`)
          continue
        }
```

Also declare `iterationNewFiles` alongside `iterationPatches` at the top of the while loop body:

```typescript
      const iterationPatches: FilePatch[] = []
      const iterationNewFiles: NewFileCreation[] = []
```

- [ ] **Step 7: Re-create accepted new files after `resetIteration`**

In the `while` loop, after `await executor.resetIteration(env, state.acceptedPatches)`, add:

```typescript
      for (const nf of state.acceptedNewFiles) {
        await executor.createFile(env, nf.path, nf.content)
      }
```

- [ ] **Step 8: Accept new files after a passing iteration**

After the line `state.acceptedPatches.push(...iterationPatches)`, add:

```typescript
      state.acceptedNewFiles.push(...iterationNewFiles)
```

Also update the `writeSnapshot` call on success to include new files in `files_modified`:

```typescript
      await writeSnapshot(
        db, changeId, state, 'passed', false,
        testResult.testsPassed, testResult.testsFailed, null,
        [...new Set([
          ...iterationPatches.map(p => p.path),
          ...iterationNewFiles.map(f => f.path),
        ])]
      )
```

- [ ] **Step 9: Run the tests — all should pass**

```bash
npx vitest run tests/lib/execution/execution-orchestrator.test.ts
```

Expected: all tests green, including the two new ones.

- [ ] **Step 10: Run full test suite**

```bash
npx vitest run
```

Expected: all tests pass. Fix any type errors from the updated `PlanTask` interface.

- [ ] **Step 11: Commit**

```bash
git add lib/execution/execution-orchestrator.ts tests/lib/execution/execution-orchestrator.test.ts
git commit -m "feat: orchestrator handles new-file creation tasks"
```

---

## Task 7: Check MockAIProvider supports per-call response override

**Files:**
- Check/Modify: `lib/ai/adapters/mock.ts`

The orchestrator tests in Task 6 require the mock AI to return different content for new-file prompts vs. patch prompts.

- [ ] **Step 1: Inspect the mock**

```bash
cat lib/ai/adapters/mock.ts
```

- [ ] **Step 2: If `MockAIProvider` only returns a fixed response, add a `nextResponse` queue**

If the mock looks like:
```typescript
export class MockAIProvider implements AIProvider {
  response = '{"newContent":"fixed","confidence":90}'
  async complete(_prompt: string, _opts?: unknown) {
    return { content: this.response }
  }
}
```

Add a response queue:
```typescript
export class MockAIProvider implements AIProvider {
  response = '{"newContent":"fixed","confidence":90}'
  private _queue: string[] = []
  set nextResponse(v: string) { this._queue.push(v) }
  async complete(_prompt: string, _opts?: unknown) {
    const content = this._queue.length > 0 ? this._queue.shift()! : this.response
    return { content }
  }
}
```

If the mock already supports this pattern, no change needed.

- [ ] **Step 3: Re-run orchestrator tests**

```bash
npx vitest run tests/lib/execution/execution-orchestrator.test.ts
```

Expected: all pass.

- [ ] **Step 4: Commit if changed**

```bash
git add lib/ai/adapters/mock.ts
git commit -m "feat: add nextResponse queue to MockAIProvider"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** Root cause = tasks with `new_file_path` had no execution path. Plan covers: DB column, plan generator populates it, orchestrator acts on it, executor writes it, snapshot counts it.
- [x] **No placeholders:** All code shown in full, no "TBD" or "add appropriate handling."
- [x] **Type consistency:** `NewFileCreation` defined in Task 2 is used identically in Tasks 5 and 6. `new_file_path` column added in Task 1 is read in Task 6's orchestrator select.
- [x] **resetIteration gap covered:** Task 6 Step 7 re-creates accepted new files after each reset.
- [x] **MockAIProvider**: Task 7 explicitly checks and patches if needed.
