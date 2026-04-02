# Change Intelligence System — Plan 6: Execution Loop

> Created: 2026-04-02
> Status: Pending review

---

## Goal

Take an approved `change_plan` and execute it: generate code changes iteratively, validate them at multiple levels, and produce a clean git branch ready for review. The system is intelligent (classifies failures, propagates changes preemptively, adapts context strategy), safe (hard resource limits, behavioral guardrails, multi-layer rollback), and debuggable (deterministic, replayable execution traces).

---

## Architecture Overview

```
ApprovedChangePlan
      │
      ▼
ExecutionOrchestrator
  ├─ DockerExecutor (CodeExecutor implementation)
  ├─ SymbolExtractor (ts-morph)
  ├─ PatchValidator (pre-apply AST + semantic + intent)
  ├─ TestSelector (test_coverage_map)
  ├─ FailureClassifier
  ├─ PropagationManager
  ├─ BehavioralGuardrail
  └─ ExecutionTracer
      │
      ▼
 change_commits + execution_snapshots + execution_trace
      │
      ▼
  status → 'review'
```

---

## CodeExecutor Interface

```typescript
interface CodeExecutor {
  prepareEnvironment(project: Project, branch: string): Promise<ExecutionEnvironment>
  applyPatch(env: ExecutionEnvironment, patch: FilePatch): Promise<PatchResult>
  runTypeCheck(env: ExecutionEnvironment): Promise<TypeCheckResult>
  runTests(env: ExecutionEnvironment, scope: TestScope): Promise<TestResult>
  runBehavioralChecks(env: ExecutionEnvironment, scope: BehavioralScope): Promise<BehavioralResult>
  getDiff(env: ExecutionEnvironment): Promise<DiffSummary>
  commitAndPush(env: ExecutionEnvironment, branch: string): Promise<CommitResult>
  resetIteration(env: ExecutionEnvironment, acceptedPatches: FilePatch[]): Promise<void>
  cleanup(env: ExecutionEnvironment): Promise<void>
}
```

First implementation: `DockerExecutor` — one isolated container per execution, reused across all iterations of that execution. `resetIteration` runs `git reset --hard` then re-applies only the accepted patches, ensuring deterministic per-iteration state with no pollution from prior attempts.

---

## Core Types

### NodeLocator

Single-ID schemes are unstable across iterations. Resolution uses a multi-strategy fallback chain:

```typescript
interface NodeLocator {
  primary: string             // hash(filePath + node.getKind() + startLine + getText().slice(0, 50))
  fallbacks: {
    symbolName?: string
    kind: SyntaxKind
    approximatePosition: { line: number; toleranceLines: number }
    structureSignature: string  // hash(paramCount + returnType + modifiers)
  }
}
```

Resolution rule: if primary matches → use it. Otherwise walk fallbacks in order. If zero matches OR multiple matches at any step → **abort the patch, do not guess**.

### FilePatch

```typescript
interface FilePatch {
  path: string
  locator: NodeLocator
  originalContent: string       // node.getText() at extraction time
  newContent: string
  confidence: number            // 0–100, AI-returned
  requiresPropagation: boolean  // true when signature changes
  allowedChanges: {
    symbols: string[]           // intent enforcement — what this patch is allowed to touch
    intent: string              // task description, passed to every AI call
  }
}
```

### SymbolContext

```typescript
interface SymbolContext {
  symbolName: string
  filePath: string
  code: string
  callers: string[]           // who calls this symbol (from component graph)
  callees: string[]           // what this symbol calls
  relatedTypes: string[]
  complexity: number          // drives ContextMode selection
}
```

### Context Modes

```typescript
type ContextMode = 'symbol' | 'multi-symbol' | 'file'
```

Selection rules:
- `complexity < limits.symbolComplexityLowThreshold` (default 30) AND no signature change → `'symbol'`
- Multiple related symbols in same task OR signature change → `'multi-symbol'`
- Repeated failures OR runtime errors OR `complexity > limits.symbolComplexityHighThreshold` (default 80) → `'file'`

### Failure Types (priority order — always resolve higher priority first)

```typescript
type FailureType = 'syntax' | 'type' | 'runtime' | 'test' | 'timeout'
```

Fix `syntax` before `type`, `type` before `runtime`, `runtime` before `test`. Never attempt logic fixes while structure is broken.

Strategy per type:
- `syntax` → regenerate same symbol (same context, error fed back)
- `type` → trigger preemptive propagation to callers
- `runtime` → escalate `ContextMode`
- `test` → retry with `{ lastError, lastFailedPatch, diffSummary }` in context
- `timeout` → abort execution

### Execution Scope

```typescript
interface ExecutionScope {
  plannedFiles: string[]          // from change_plan at approval time
  addedViaPropagation: string[]   // accumulated during execution
}
```

If `addedViaPropagation.length > plannedFiles.length * limits.propagationFactor` (default 1.5) → flag divergence, require human approval before continuing.

---

## Resource Limits

Hard limits enforced at loop entry — abort if any exceeded:

```typescript
interface ExecutionLimits {
  maxIterations: number             // default: 10
  maxAiCalls: number                // default: 50
  maxDurationMs: number             // default: 600_000 (10 min)
  maxCost: number                   // default: configurable per project
  maxAffectedFiles: number          // default: 20 — require approval if exceeded
  maxPropagationQueueSize: number   // default: 15 — require approval if exceeded
  confidenceThreshold: number       // default: 60 — below this, retry before applying
  symbolComplexityLowThreshold: number   // default: 30 — use symbol mode below
  symbolComplexityHighThreshold: number  // default: 80 — use file mode above
  propagationFactor: number         // default: 1.5 — flag divergence when propagated > planned * 1.5
  stagnationWindow: number          // default: 3 — same errorSignature N times → switch strategy
}
```

---

## Execution Loop

### Setup (once per execution)

1. Set `change_requests.status = 'executing'`
2. Record `execution_scope.plannedFiles` from approved plan
3. `executor.prepareEnvironment(project, branch)` — spins up Docker container, clones repo, installs deps, creates branch

### Per-Iteration

**Before the iteration begins:**

1. `executor.resetIteration(env, acceptedPatches)` — `git reset --hard` + re-apply accepted patches
2. Enforce resource limits — abort if exceeded

**Task ordering:**

Sort tasks by component graph depth: leaf nodes first, core modules last. Prevents cascading breakage during iteration.

**For each task:**

#### 1. Scope expansion (preemptive propagation)

Before generating any patch:
- Extract proposed SymbolContext
- Detect if task involves a signature change (parameter add/remove/type change, return type change)
- If signature change → immediately add all direct callers to current iteration's task queue
- Mark `ExecutionScope.addedViaPropagation`
- Check propagation cap — if exceeded, require approval

#### 2. Context extraction

Select `ContextMode` for this task. Extract `SymbolContext` including callers, callees, and related types. Pass `allowedChanges: { symbols, intent }` to all AI calls.

#### 3. AI patch generation

Call AI with: task description, `SymbolContext`, `allowedChanges`, and (on retry) `{ lastError, lastFailedPatch, diffSummary }`.

AI must return `FilePatch` including `confidence` (0–100) and `requiresPropagation`.

If `confidence < limits.confidenceThreshold` (default 60) → retry before proceeding.

#### 4. Pre-apply validation pipeline

Run in order — reject at first failure:

**a. Intent enforcement**
- Parse returned patch's touched symbols
- If any symbol outside `allowedChanges.symbols` → reject, regenerate

**b. Semantic scope check**
- If `changed_symbols > expected_scope` → reject
- If `imports_added > threshold` OR unexpected import removal → flag as risky, require confidence ≥ 80

**c. AST syntax validation**
```typescript
ts.createSourceFile('temp.ts', patch.newContent, ScriptTarget.Latest)
// if parse errors → reject immediately, do NOT apply
```

**d. Stale node check**
- Resolve node via `NodeLocator`
- If `node.getText() !== patch.originalContent` → patch is stale — re-fetch symbol, regenerate

#### 5. Apply patch

```typescript
node.replaceWithText(patch.newContent)  // ts-morph, never line-based
```

Post-apply:
- Run prettier on modified file
- Recompute imports: remove unused, add missing (via AST analysis)
- Add to `acceptedPatches` for this iteration

#### 6. Propagation queue

If `patch.requiresPropagation` AND callers not already in `visited_symbols`:
- Enqueue caller symbols for this iteration
- Check propagation cap before enqueue
- Add to `ExecutionScope.addedViaPropagation`

`visited_symbols` set prevents re-processing the same symbol within an iteration.

### Validation sequence (after all tasks in iteration)

Run in priority order — stop at first failure and classify:

1. **`tsc --noEmit`** — type-check before tests. Faster than tests, isolates structural issues cleanly.
2. **Scoped test run** — `TestScope` derived from `test_coverage_map`: direct tests for changed files + dependent component tests. If `risk_level == 'high'` → widen scope.
3. **Behavioral guardrails** (if `critical_component_touched`):
   - Heuristic sanity checks: detect removed conditionals, early returns, exception swallowing
   - Contract assertions: if API/function signature touched → validate response shape unchanged
   - Flag behavioral anomalies — do not auto-pass

### Failure handling

**Failure classification** (priority: syntax > type > runtime > test):

```typescript
function classifyFailure(result: TypeCheckResult | TestResult): FailureType {
  if (hasSyntaxErrors(result)) return 'syntax'
  if (hasTypeErrors(result)) return 'type'
  if (hasRuntimeErrors(result)) return 'runtime'
  if (hasTestFailures(result)) return 'test'
  return 'timeout'
}
```

Always fix highest-priority failure first. Do not attempt test logic fixes while type errors remain.

**Stagnation detection:**
```typescript
errorSignature = hash(errorMessage + stackTrace)
```
- Same `errorSignature` `limits.stagnationWindow` (default 3) consecutive times → switch strategy (escalate `ContextMode`)
- Still failing after `maxIterations` → abort execution

**Rollback layers:**
- **L1 (symbol):** `node.replaceWithText(patch.originalContent)` — targeted revert
- **L2 (file):** Restore full file from pre-iteration snapshot
- **L3 (container):** `executor.resetIteration()` — `git reset --hard`, full clean state

Use L1 first. If L1 insufficient (multi-symbol dependencies shifted), use L2. L3 is always applied at iteration boundary regardless.

### Partial success mode

If iteration loop exhausts `maxIterations` with partial task completion:

```
partial_success_mode:
  commit tasks with status 'done'
  mark failed tasks with status 'failed' + failure_type + last_error
  surface to review screen for manual resolution
  do NOT abort all-or-nothing
```

---

## Completion

When all tasks pass full validation sequence:

1. Run full test suite (not just scoped)
2. `executor.getDiff()` → write `DiffSummary`
3. `executor.commitAndPush(env, branch)` → write `change_commits` row
4. Set `change_requests.status = 'review'`
5. Trigger CI as final validation (not a gate — CI runs async, result surfaced in review)
6. `executor.cleanup(env)` — destroy container

---

## Observability: Execution Trace

Persisted per-task, per-iteration. Enables deterministic replay and post-mortem debugging.

```typescript
interface ExecutionTrace {
  changeId: string
  iteration: number
  taskId: string
  contextMode: ContextMode
  inputHash: string          // hash(symbolContext + task description)
  outputHash: string         // hash(patch.newContent)
  strategyUsed: string       // 'initial' | 'escalated' | 'propagation'
  failureType: FailureType | null
  confidence: number
  createdAt: Date
}
```

Guarantee: `same inputHash + same strategyUsed → same outputHash`. No randomness in strategy selection. Strategy decisions are persisted — replaying an execution uses the recorded strategy, not re-derived logic.

---

## Database Additions (Migration)

```sql
-- execution_trace table (new)
create table execution_trace (
  id             uuid primary key default gen_random_uuid(),
  change_id      uuid references change_requests(id),
  iteration      int,
  task_id        uuid references change_plan_tasks(id),
  context_mode   text check (context_mode in ('symbol', 'multi-symbol', 'file')),
  input_hash     text,
  output_hash    text,
  strategy_used  text,
  failure_type   text,
  confidence     int,
  created_at     timestamptz default now()
);

-- execution_snapshots additions
alter table execution_snapshots
  add column if not exists planned_files     text[],
  add column if not exists propagated_files  text[],
  add column if not exists plan_divergence   boolean default false,
  add column if not exists partial_success   boolean default false;

-- change_plan_tasks status extension
alter table change_plan_tasks drop constraint if exists change_plan_tasks_status_check;
alter table change_plan_tasks add constraint change_plan_tasks_status_check
  check (status in ('pending', 'done', 'failed'));

alter table change_plan_tasks
  add column if not exists failure_type  text,
  add column if not exists last_error    text;
```

---

## API Endpoint

```
POST /api/change-requests/[id]/execute
```

- Auth: user must own the change request
- Validates: `change_plans.status = 'approved'`
- Sets `change_requests.status = 'executing'`
- Fires `runExecution(changeId)` as background async (fire-and-forget from request)
- Returns `{ changeId, status: 'executing' }`

```
GET /api/change-requests/[id]/execute
```

- Returns current `execution_snapshots` (all iterations) + `execution_trace` rows + `ExecutionScope`
- Used by UI polling

---

## UI: Execution Screen

Route: `/projects/[id]/changes/[changeId]/execution`

**Live view (polling every 2s while `status = 'executing'`):**
- Per-iteration accordion: iteration number, tasks attempted, pass/fail, failure type if any
- Current task: name, component, `ContextMode` badge, confidence score
- Propagation indicator: if `addedViaPropagation.length > 0` → "Scope expanded: +N files via propagation"
- Plan divergence banner: if flagged → "Execution diverging from plan — human approval required"
- Resource usage: iterations used / max, AI calls used / max, cost so far

**Partial success state:**
- Failed tasks shown with failure type + last error
- "Continue to Review" button still available — review screen shows which tasks succeeded and which need manual fix

**Behavioral guardrail flags:**
- If anomalies detected → amber banner listing the heuristic triggers
- User can acknowledge and continue or abort

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `lib/execution/types.ts` | Create | All types: FilePatch, NodeLocator, SymbolContext, ExecutionTrace, etc. |
| `lib/execution/node-locator.ts` | Create | Multi-strategy AST node resolution |
| `lib/execution/symbol-extractor.ts` | Create | Extract SymbolContext via ts-morph |
| `lib/execution/patch-validator.ts` | Create | Pre-apply validation pipeline (intent, semantic, AST, stale) |
| `lib/execution/propagation-manager.ts` | Create | Propagation queue, cap enforcement, visited set |
| `lib/execution/failure-classifier.ts` | Create | Classify tsc/test/runtime results into FailureType |
| `lib/execution/behavioral-guardrail.ts` | Create | Heuristic sanity checks + contract assertions |
| `lib/execution/test-selector.ts` | Create | TestScope derivation from test_coverage_map |
| `lib/execution/execution-tracer.ts` | Create | Write execution_trace rows, hash inputs/outputs |
| `lib/execution/execution-orchestrator.ts` | Create | Main loop: iteration lifecycle, task ordering, resource limits |
| `lib/execution/executors/code-executor.ts` | Create | CodeExecutor interface |
| `lib/execution/executors/docker-executor.ts` | Create | DockerExecutor implementation |
| `lib/execution/prompt-builders.ts` | Create | AI prompts for patch generation per ContextMode |
| `tests/lib/execution/node-locator.test.ts` | Create | Unit tests: resolution strategies, abort-on-ambiguity |
| `tests/lib/execution/patch-validator.test.ts` | Create | Unit tests: each validation step independently |
| `tests/lib/execution/failure-classifier.test.ts` | Create | Unit tests: priority ordering, all failure types |
| `tests/lib/execution/execution-orchestrator.test.ts` | Create | Integration tests with MockCodeExecutor + MockAIProvider |
| `app/api/change-requests/[id]/execute/route.ts` | Create | POST (trigger), GET (status + snapshots) |
| `app/projects/[id]/changes/[changeId]/execution/page.tsx` | Create | Execution screen |
| `supabase/migrations/008_execution.sql` | Create | execution_trace table + execution_snapshots additions |
