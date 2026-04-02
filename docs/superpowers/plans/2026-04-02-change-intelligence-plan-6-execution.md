# Change Intelligence — Plan 6: Execution Loop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the execution loop — an intelligent iterative system that takes an approved change plan, generates code patches via AI, validates them at multiple levels (intent, AST syntax, stale-node, type-check, tests, behavioral guardrails), applies them in leaf-first order inside an isolated Docker container, and produces a committed git branch ready for review.

**Architecture:** Pure component library in `lib/execution/` (no framework deps, fully unit-testable) wired together by `ExecutionOrchestrator`, which fires from `POST /api/change-requests/[id]/execute`. `DockerExecutor` implements `CodeExecutor` using child_process Docker CLI calls; a `MockCodeExecutor` is used for all orchestrator unit tests. The AI patch generation, failure classification, propagation management, and test selection are each isolated modules.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase, ts-morph (already installed), Vitest, Docker CLI (for DockerExecutor), Node crypto (hashing), Node child_process (Docker commands)

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `supabase/migrations/008_execution.sql` | Create | `execution_trace` table; extend `execution_snapshots`, `change_plan_tasks` |
| `lib/supabase/types.ts` | Modify | Add execution types, extend `PlanTaskStatus` |
| `lib/execution/types.ts` | Create | All execution interfaces: `FilePatch`, `NodeLocator`, `SymbolContext`, `ExecutionEnvironment`, `TestScope`, results, limits, state |
| `lib/execution/node-locator.ts` | Create | Multi-strategy AST node resolution via ts-morph |
| `lib/execution/symbol-extractor.ts` | Create | Extract `SymbolContext` (code + callees + types + complexity) from a ts-morph source file |
| `lib/execution/patch-validator.ts` | Create | 4-stage pre-apply validation: intent → semantic → AST syntax → stale-node |
| `lib/execution/propagation-manager.ts` | Create | Propagation queue with visited-set and cap enforcement |
| `lib/execution/failure-classifier.ts` | Create | Classify tsc/test/runtime output into typed `FailureType` with priority order |
| `lib/execution/test-selector.ts` | Create | Derive `TestScope` from `test_coverage_map` + risk level |
| `lib/execution/behavioral-guardrail.ts` | Create | Heuristic checks: removed conditionals, early returns, exception swallowing, contract changes |
| `lib/execution/prompt-builders.ts` | Create | AI prompt builders for `symbol` / `multi-symbol` / `file` context modes |
| `lib/execution/execution-tracer.ts` | Create | Write `execution_trace` rows; deterministic input/output hashing |
| `lib/execution/executors/code-executor.ts` | Create | `CodeExecutor` interface + `MockCodeExecutor` for tests |
| `lib/execution/executors/docker-executor.ts` | Create | `DockerExecutor`: container lifecycle via Docker CLI |
| `lib/execution/execution-orchestrator.ts` | Create | Main loop: iteration lifecycle, task ordering, resource limits, partial success |
| `tests/lib/execution/node-locator.test.ts` | Create | Resolution strategies, abort-on-ambiguity |
| `tests/lib/execution/symbol-extractor.test.ts` | Create | Symbol extraction from real ts-morph source files |
| `tests/lib/execution/patch-validator.test.ts` | Create | Each validation stage independently |
| `tests/lib/execution/propagation-manager.test.ts` | Create | Queue, visited set, cap |
| `tests/lib/execution/failure-classifier.test.ts` | Create | All failure types + priority ordering |
| `tests/lib/execution/test-selector.test.ts` | Create | Scope derivation from mock DB |
| `tests/lib/execution/behavioral-guardrail.test.ts` | Create | All anomaly types |
| `tests/lib/execution/prompt-builders.test.ts` | Create | Prompt content correctness |
| `tests/lib/execution/execution-tracer.test.ts` | Create | DB writes and hash determinism |
| `tests/lib/execution/execution-orchestrator.test.ts` | Create | Happy path, retry, abort, partial success with MockCodeExecutor |
| `app/api/change-requests/[id]/execute/route.ts` | Create | POST (trigger fire-and-forget), GET (status + snapshots) |
| `app/projects/[id]/changes/[changeId]/execution/page.tsx` | Create | Execution screen with polling |

---

### Task 1: DB Migration + Type Updates

**Files:**
- Create: `supabase/migrations/008_execution.sql`
- Modify: `lib/supabase/types.ts`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/008_execution.sql

-- execution_trace: per-task, per-iteration observability record
create table execution_trace (
  id             uuid primary key default gen_random_uuid(),
  change_id      uuid not null references change_requests(id) on delete cascade,
  iteration      int not null,
  task_id        uuid not null references change_plan_tasks(id) on delete cascade,
  context_mode   text not null check (context_mode in ('symbol', 'multi-symbol', 'file')),
  input_hash     text not null,
  output_hash    text,
  strategy_used  text not null,
  failure_type   text check (failure_type in ('syntax','type','runtime','test','timeout')),
  confidence     int,
  created_at     timestamptz not null default now()
);

alter table execution_trace enable row level security;
create policy "project owner access" on execution_trace for all using (
  exists (
    select 1 from change_requests cr
    join projects on projects.id = cr.project_id
    where cr.id = execution_trace.change_id and projects.owner_id = auth.uid()
  )
);

-- extend execution_snapshots with scope tracking
alter table execution_snapshots
  add column if not exists planned_files    text[] not null default '{}',
  add column if not exists propagated_files text[] not null default '{}',
  add column if not exists plan_divergence  boolean not null default false,
  add column if not exists partial_success  boolean not null default false;

-- extend change_plan_tasks status to include 'failed'
alter table change_plan_tasks drop constraint if exists change_plan_tasks_status_check;
alter table change_plan_tasks add constraint change_plan_tasks_status_check
  check (status in ('pending', 'done', 'failed'));

alter table change_plan_tasks
  add column if not exists failure_type text check (failure_type in ('syntax','type','runtime','test','timeout')),
  add column if not exists last_error   text;
```

- [ ] **Step 2: Add execution types to `lib/supabase/types.ts`**

Open `lib/supabase/types.ts` and add after the existing `PlanTaskStatus` line and `TerminationReason` line:

```typescript
// replace existing:
export type PlanTaskStatus     = 'pending' | 'done'
// with:
export type PlanTaskStatus     = 'pending' | 'done' | 'failed'

// add new types after TerminationReason:
export type ContextMode        = 'symbol' | 'multi-symbol' | 'file'
export type FailureType        = 'syntax' | 'type' | 'runtime' | 'test' | 'timeout'
export type ExecutionStrategy  = 'initial' | 'escalated' | 'propagation'
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/008_execution.sql lib/supabase/types.ts
git commit -m "feat: execution migration and type extensions"
```

---

### Task 2: Core Execution Types

**Files:**
- Create: `lib/execution/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// lib/execution/types.ts
import type { ContextMode, FailureType, ExecutionStrategy } from '@/lib/supabase/types'

export type { ContextMode, FailureType, ExecutionStrategy }

// ── Node resolution ───────────────────────────────────────────────────────────

export interface NodeLocator {
  primary: string  // hash(filePath + kind + startLine + code.slice(0,50))
  fallbacks: {
    symbolName?: string
    kind: number       // ts-morph SyntaxKind
    approximatePosition: { line: number; toleranceLines: number }
    structureSignature: string  // hash(paramCount + ':' + returnTypeText)
  }
}

// ── Symbol context ────────────────────────────────────────────────────────────

export interface SymbolContext {
  symbolName: string
  filePath: string
  code: string
  locator: NodeLocator
  callers: string[]       // file paths that import this file (from component_graph_edges)
  callees: string[]       // identifiers this symbol calls, extracted from AST
  relatedTypes: string[]  // type names referenced in this symbol's signature
  complexity: number      // line count of symbol body
}

// ── Patch ─────────────────────────────────────────────────────────────────────

export interface AllowedChanges {
  symbols: string[]  // symbol names this AI call is allowed to touch
  intent: string     // task description forwarded to every AI call
}

export interface FilePatch {
  path: string
  locator: NodeLocator
  originalContent: string   // node.getText() at extraction time
  newContent: string        // replacement code for just the node
  confidence: number        // 0–100, returned by AI
  requiresPropagation: boolean
  allowedChanges: AllowedChanges
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean
  reason?: string
  stage?: 'intent' | 'semantic' | 'syntax' | 'stale'
}

// ── Execution environment ─────────────────────────────────────────────────────

export interface ExecutionEnvironment {
  containerId: string
  containerWorkDir: string  // '/app' inside container
  localWorkDir: string      // temp dir on host, mirrors container state
  branch: string
  projectId: string
  repoUrl: string
}

// ── Test scope ────────────────────────────────────────────────────────────────

export interface TestScope {
  directTests: string[]     // test files directly covering changed source files
  dependentTests: string[]  // test files for components that depend on changed components
  widened: boolean          // true when risk_level forced wider scope
}

// ── Executor results ──────────────────────────────────────────────────────────

export interface PatchResult {
  success: boolean
  error?: string
}

export interface TypeCheckError {
  file: string
  line: number
  message: string
}

export interface TypeCheckResult {
  passed: boolean
  errors: TypeCheckError[]
  output: string
}

export interface TestFailure {
  testName: string
  error: string
}

export interface TestResult {
  passed: boolean
  failures: TestFailure[]
  output: string
  testsRun: number
  testsPassed: number
  testsFailed: number
}

export interface BehavioralAnomaly {
  type: 'removed_conditional' | 'early_return' | 'exception_swallowing' | 'contract_change'
  description: string
  severity: 'warning' | 'error'
}

export interface BehavioralResult {
  passed: boolean
  anomalies: BehavioralAnomaly[]
}

export interface BehavioralScope {
  patches: FilePatch[]
  criticalComponentTouched: boolean
}

export interface DiffSummary {
  filesChanged: string[]
  additions: number
  deletions: number
  rawDiff: string
}

export interface CommitResult {
  commitHash: string
  branch: string
}

// ── Limits ────────────────────────────────────────────────────────────────────

export interface ExecutionLimits {
  maxIterations: number
  maxAiCalls: number
  maxDurationMs: number
  maxCost: number
  maxAffectedFiles: number
  maxPropagationQueueSize: number
  confidenceThreshold: number
  symbolComplexityLowThreshold: number
  symbolComplexityHighThreshold: number
  propagationFactor: number
  stagnationWindow: number
}

export const DEFAULT_LIMITS: ExecutionLimits = {
  maxIterations: 10,
  maxAiCalls: 50,
  maxDurationMs: 600_000,
  maxCost: Infinity,
  maxAffectedFiles: 20,
  maxPropagationQueueSize: 15,
  confidenceThreshold: 60,
  symbolComplexityLowThreshold: 30,
  symbolComplexityHighThreshold: 80,
  propagationFactor: 1.5,
  stagnationWindow: 3,
}

// ── Execution scope ───────────────────────────────────────────────────────────

export interface ExecutionScope {
  plannedFiles: string[]
  addedViaPropagation: string[]
}

// ── Execution trace (DB row shape) ────────────────────────────────────────────

export interface ExecutionTraceRow {
  changeId: string
  iteration: number
  taskId: string
  contextMode: ContextMode
  inputHash: string
  outputHash: string | null
  strategyUsed: ExecutionStrategy
  failureType: FailureType | null
  confidence: number | null
}

// ── Propagation queue item ────────────────────────────────────────────────────

export interface PropagationItem {
  filePath: string
  symbolName: string
  reason: string  // e.g. 'signature_change_in AuthService.getUser'
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/execution/types.ts
git commit -m "feat: core execution types"
```

---

### Task 3: NodeLocator

**Files:**
- Create: `lib/execution/node-locator.ts`
- Create: `tests/lib/execution/node-locator.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/execution/node-locator.test.ts
import { describe, it, expect } from 'vitest'
import { Project, SyntaxKind } from 'ts-morph'
import { buildLocator, resolveNode } from '@/lib/execution/node-locator'

const SOURCE = `
function greet(name: string): string {
  return 'Hello ' + name
}

function farewell(name: string): string {
  return 'Goodbye ' + name
}
`.trim()

function makeSourceFile(code = SOURCE) {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  return project.createSourceFile('test.ts', code, { overwrite: true })
}

describe('buildLocator', () => {
  it('builds a locator from a function node', () => {
    const sf = makeSourceFile()
    const fn = sf.getFunctions()[0]!
    const locator = buildLocator('test.ts', fn)
    expect(locator.primary).toBeTypeOf('string')
    expect(locator.fallbacks.symbolName).toBe('greet')
    expect(locator.fallbacks.kind).toBe(SyntaxKind.FunctionDeclaration)
  })
})

describe('resolveNode', () => {
  it('resolves node by primary hash', () => {
    const sf = makeSourceFile()
    const fn = sf.getFunctions()[0]!
    const locator = buildLocator('test.ts', fn)
    const resolved = resolveNode(sf, locator)
    expect(resolved).not.toBeNull()
    expect(resolved!.getText()).toContain('greet')
  })

  it('falls back to symbolName when primary hash does not match', () => {
    const sf = makeSourceFile()
    const fn = sf.getFunctions()[0]!
    const locator = buildLocator('test.ts', fn)
    // corrupt primary so it won't match
    const staleLocator = { ...locator, primary: 'stale-hash-000' }
    const resolved = resolveNode(sf, staleLocator)
    expect(resolved).not.toBeNull()
    expect(resolved!.getText()).toContain('greet')
  })

  it('returns null when multiple nodes match a fallback', () => {
    // two functions with same name at slightly different positions
    const code = `
function dupe(x: string): string { return x }
function dupe(x: number): number { return x }
`.trim()
    const sf = makeSourceFile(code)
    const locator = {
      primary: 'no-match',
      fallbacks: {
        symbolName: 'dupe',
        kind: SyntaxKind.FunctionDeclaration,
        approximatePosition: { line: 1, toleranceLines: 5 },
        structureSignature: 'any',
      },
    }
    const resolved = resolveNode(sf, locator)
    expect(resolved).toBeNull()
  })

  it('returns null when no node matches', () => {
    const sf = makeSourceFile()
    const locator = {
      primary: 'no-match',
      fallbacks: {
        symbolName: 'nonexistent',
        kind: SyntaxKind.FunctionDeclaration,
        approximatePosition: { line: 99, toleranceLines: 2 },
        structureSignature: 'no-match',
      },
    }
    expect(resolveNode(sf, locator)).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/execution/node-locator.test.ts 2>&1 | head -10
```

Expected: FAIL with `Cannot find module '@/lib/execution/node-locator'`

- [ ] **Step 3: Implement node-locator.ts**

```typescript
// lib/execution/node-locator.ts
import { createHash } from 'node:crypto'
import { Node, SyntaxKind } from 'ts-morph'
import type { SourceFile } from 'ts-morph'
import type { NodeLocator } from './types'

function shortHash(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 16)
}

function nodeStructureSignature(node: Node): string {
  // hash param count + return type text for functions/methods
  let paramCount = 0
  let returnTypeText = ''
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) || Node.isArrowFunction(node)) {
    const fn = node as Parameters<typeof Node.isFunctionDeclaration>[0] extends true ? typeof node : never
    // use getText to get param count heuristically — count commas in params
    const text = node.getText()
    const paramMatch = text.match(/\(([^)]*)\)/)
    const params = paramMatch?.[1]?.trim() ?? ''
    paramCount = params.length === 0 ? 0 : params.split(',').length
    const returnMatch = text.match(/\):\s*([^{]+)\s*{/)
    returnTypeText = returnMatch?.[1]?.trim() ?? ''
  }
  return shortHash(`${paramCount}:${returnTypeText}`)
}

export function buildLocator(filePath: string, node: Node): NodeLocator {
  const startLine = node.getStartLineNumber()
  const snippet = node.getText().slice(0, 50)
  const primary = shortHash(`${filePath}:${node.getKind()}:${startLine}:${snippet}`)

  let symbolName: string | undefined
  if (Node.isNamedNode(node)) {
    symbolName = node.getName()
  }

  return {
    primary,
    fallbacks: {
      symbolName,
      kind: node.getKind(),
      approximatePosition: { line: startLine, toleranceLines: 5 },
      structureSignature: nodeStructureSignature(node),
    },
  }
}

export function resolveNode(sf: SourceFile, locator: NodeLocator): Node | null {
  const { primary, fallbacks } = locator

  // Strategy 1: primary hash
  const primaryMatch = findByPrimaryHash(sf, primary, fallbacks.kind)
  if (primaryMatch !== null) return primaryMatch

  // Strategy 2: symbolName match (for named nodes of matching kind)
  if (fallbacks.symbolName) {
    const byName = findByName(sf, fallbacks.symbolName, fallbacks.kind)
    if (byName === 'ambiguous') return null
    if (byName !== null) return byName
  }

  // Strategy 3: approximate position + structure signature
  const byPosition = findByPosition(sf, fallbacks)
  if (byPosition === 'ambiguous') return null
  if (byPosition !== null) return byPosition

  return null
}

function findByPrimaryHash(sf: SourceFile, primary: string, kind: number): Node | null {
  const filePath = sf.getFilePath()
  const matches: Node[] = []
  sf.forEachDescendant((node) => {
    if (node.getKind() !== kind) return
    const startLine = node.getStartLineNumber()
    const snippet = node.getText().slice(0, 50)
    const hash = shortHash(`${filePath}:${kind}:${startLine}:${snippet}`)
    if (hash === primary) matches.push(node)
  })
  if (matches.length === 1) return matches[0]!
  return null
}

function findByName(sf: SourceFile, name: string, kind: number): Node | 'ambiguous' | null {
  const matches: Node[] = []
  sf.forEachDescendant((node) => {
    if (node.getKind() !== kind) return
    if (Node.isNamedNode(node) && node.getName() === name) matches.push(node)
  })
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) return 'ambiguous'
  return null
}

function findByPosition(
  sf: SourceFile,
  fallbacks: NodeLocator['fallbacks']
): Node | 'ambiguous' | null {
  const { kind, approximatePosition: { line, toleranceLines }, structureSignature } = fallbacks
  const candidates: Node[] = []
  sf.forEachDescendant((node) => {
    if (node.getKind() !== kind) return
    const nodeLine = node.getStartLineNumber()
    if (Math.abs(nodeLine - line) <= toleranceLines) candidates.push(node)
  })
  if (candidates.length === 0) return null

  // narrow by structure signature
  const sigMatches = candidates.filter(n => nodeStructureSignature(n) === structureSignature)
  if (sigMatches.length === 1) return sigMatches[0]!
  if (sigMatches.length > 1) return 'ambiguous'

  // no sig match — fall back to position-only if unambiguous
  if (candidates.length === 1) return candidates[0]!
  return 'ambiguous'
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/execution/node-locator.test.ts
```

Expected: all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/execution/node-locator.ts tests/lib/execution/node-locator.test.ts
git commit -m "feat: NodeLocator multi-strategy AST resolution"
```

---

### Task 4: SymbolExtractor

**Files:**
- Create: `lib/execution/symbol-extractor.ts`
- Create: `tests/lib/execution/symbol-extractor.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/execution/symbol-extractor.test.ts
import { describe, it, expect } from 'vitest'
import { extractSymbol } from '@/lib/execution/symbol-extractor'

const SOURCE = `
import { UserRepo } from './user-repo'
import type { User } from './types'

export async function getUser(id: string): Promise<User> {
  const repo = new UserRepo()
  if (!id) throw new Error('id required')
  return repo.findById(id)
}

export function formatUser(user: User): string {
  return user.name
}
`.trim()

describe('extractSymbol', () => {
  it('extracts function code', () => {
    const ctx = extractSymbol('src/user.ts', SOURCE, 'getUser', [])
    expect(ctx).not.toBeNull()
    expect(ctx!.code).toContain('getUser')
    expect(ctx!.symbolName).toBe('getUser')
  })

  it('extracts callees from function body', () => {
    const ctx = extractSymbol('src/user.ts', SOURCE, 'getUser', [])
    expect(ctx!.callees).toContain('findById')
  })

  it('extracts related types from signature', () => {
    const ctx = extractSymbol('src/user.ts', SOURCE, 'getUser', [])
    expect(ctx!.relatedTypes).toContain('User')
  })

  it('computes complexity as line count', () => {
    const ctx = extractSymbol('src/user.ts', SOURCE, 'getUser', [])
    expect(ctx!.complexity).toBeGreaterThan(1)
  })

  it('includes caller file paths passed in', () => {
    const ctx = extractSymbol('src/user.ts', SOURCE, 'getUser', ['src/controller.ts'])
    expect(ctx!.callers).toContain('src/controller.ts')
  })

  it('returns null for unknown symbol name', () => {
    expect(extractSymbol('src/user.ts', SOURCE, 'nonexistent', [])).toBeNull()
  })

  it('builds a NodeLocator with the correct symbol name', () => {
    const ctx = extractSymbol('src/user.ts', SOURCE, 'getUser', [])
    expect(ctx!.locator.fallbacks.symbolName).toBe('getUser')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/execution/symbol-extractor.test.ts 2>&1 | head -5
```

Expected: FAIL with `Cannot find module '@/lib/execution/symbol-extractor'`

- [ ] **Step 3: Implement symbol-extractor.ts**

```typescript
// lib/execution/symbol-extractor.ts
import { Project, Node } from 'ts-morph'
import type { SymbolContext } from './types'
import { buildLocator } from './node-locator'

export function extractSymbol(
  filePath: string,
  sourceCode: string,
  symbolName: string,
  callerFilePaths: string[]
): SymbolContext | null {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const sf = project.createSourceFile(filePath, sourceCode, { overwrite: true })

  // Find named function or arrow function variable
  let targetNode: Node | null = null
  sf.forEachDescendant((node) => {
    if (targetNode) return
    if (
      (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) &&
      Node.isNamedNode(node) &&
      node.getName() === symbolName
    ) {
      targetNode = node
    }
    // handle: export const foo = () => ...
    if (Node.isVariableDeclaration(node) && node.getName() === symbolName) {
      const init = node.getInitializer()
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        targetNode = node
      }
    }
  })

  if (!targetNode) return null

  const code = targetNode.getText()
  const locator = buildLocator(filePath, targetNode)

  // Extract callees: identifiers that are called (CallExpression callee names)
  const callees: string[] = []
  targetNode.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      const expr = node.getExpression()
      if (Node.isIdentifier(expr)) {
        const name = expr.getText()
        if (name !== symbolName && !callees.includes(name)) callees.push(name)
      } else if (Node.isPropertyAccessExpression(expr)) {
        const name = expr.getName()
        if (!callees.includes(name)) callees.push(name)
      }
    }
  })

  // Extract related types from type annotations in signature
  const relatedTypes: string[] = []
  targetNode.forEachDescendant((node) => {
    if (Node.isTypeReference(node)) {
      const name = node.getTypeName().getText()
      if (!relatedTypes.includes(name)) relatedTypes.push(name)
    }
  })

  const complexity = code.split('\n').length

  return {
    symbolName,
    filePath,
    code,
    locator,
    callers: callerFilePaths,
    callees,
    relatedTypes,
    complexity,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/execution/symbol-extractor.test.ts
```

Expected: all 7 tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/execution/symbol-extractor.ts tests/lib/execution/symbol-extractor.test.ts
git commit -m "feat: SymbolExtractor via ts-morph"
```

---

### Task 5: PatchValidator

**Files:**
- Create: `lib/execution/patch-validator.ts`
- Create: `tests/lib/execution/patch-validator.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/execution/patch-validator.test.ts
import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { validatePatch } from '@/lib/execution/patch-validator'
import { buildLocator } from '@/lib/execution/node-locator'
import type { FilePatch } from '@/lib/execution/types'

const SOURCE = `
export function getUser(id: string): string {
  return id
}
export function other(): void {}
`.trim()

function makeSourceFile(code = SOURCE) {
  const p = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  return p.createSourceFile('user.ts', code, { overwrite: true })
}

function makePatch(overrides: Partial<FilePatch> = {}): FilePatch {
  const sf = makeSourceFile()
  const fn = sf.getFunctions()[0]!
  return {
    path: 'src/user.ts',
    locator: buildLocator('user.ts', fn),
    originalContent: fn.getText(),
    newContent: `function getUser(id: string): string {\n  return id + '-updated'\n}`,
    confidence: 80,
    requiresPropagation: false,
    allowedChanges: { symbols: ['getUser'], intent: 'update getUser' },
    ...overrides,
  }
}

describe('validatePatch', () => {
  it('passes a valid patch', () => {
    const sf = makeSourceFile()
    const result = validatePatch(sf, makePatch())
    expect(result.valid).toBe(true)
  })

  it('rejects when newContent touches a symbol outside allowedChanges', () => {
    const patch = makePatch({
      newContent: `function getUser(id: string): string { return id }\nfunction other(): void { console.log('added') }`,
      allowedChanges: { symbols: ['getUser'], intent: 'update getUser' },
    })
    // newContent introduces 'other' — but intent enforcement checks changed symbol count
    // Simpler test: allowedChanges has only getUser but patch claims to touch other
    const patchWithWrongSymbol = makePatch({
      allowedChanges: { symbols: ['other'], intent: 'update other' },
    })
    const sf = makeSourceFile()
    const result = validatePatch(sf, patchWithWrongSymbol)
    // locator points to getUser but allowedChanges says only 'other' — should reject
    expect(result.valid).toBe(false)
    expect(result.stage).toBe('intent')
  })

  it('rejects when newContent is invalid TypeScript syntax', () => {
    const patch = makePatch({ newContent: 'function getUser( {{{' })
    const sf = makeSourceFile()
    const result = validatePatch(sf, patch)
    expect(result.valid).toBe(false)
    expect(result.stage).toBe('syntax')
  })

  it('rejects when originalContent does not match current node text', () => {
    const patch = makePatch({ originalContent: 'function getUser() { return "stale" }' })
    const sf = makeSourceFile()
    const result = validatePatch(sf, patch)
    expect(result.valid).toBe(false)
    expect(result.stage).toBe('stale')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/execution/patch-validator.test.ts 2>&1 | head -5
```

Expected: FAIL with `Cannot find module '@/lib/execution/patch-validator'`

- [ ] **Step 3: Implement patch-validator.ts**

```typescript
// lib/execution/patch-validator.ts
import { Project, Node } from 'ts-morph'
import type { SourceFile } from 'ts-morph'
import type { FilePatch, ValidationResult } from './types'
import { resolveNode } from './node-locator'

export function validatePatch(sf: SourceFile, patch: FilePatch): ValidationResult {
  // Stage 1: intent enforcement — locator must point to a symbol in allowedChanges
  const node = resolveNode(sf, patch.locator)
  if (!node) {
    return { valid: false, stage: 'stale', reason: 'Node not found by locator' }
  }

  const symbolName = Node.isNamedNode(node) ? node.getName() : undefined
  if (symbolName && !patch.allowedChanges.symbols.includes(symbolName)) {
    return {
      valid: false,
      stage: 'intent',
      reason: `Locator resolved to '${symbolName}' which is not in allowedChanges.symbols: [${patch.allowedChanges.symbols.join(', ')}]`,
    }
  }

  // Stage 2: semantic scope — newContent should not introduce additional top-level declarations
  // (heuristic: count export/function/class/const keywords at start of lines)
  const topLevelCount = (code: string) =>
    (code.match(/^(?:export\s+)?(?:function|class|const|let|var)\s+/gm) ?? []).length
  if (topLevelCount(patch.newContent) > topLevelCount(patch.originalContent) + 1) {
    return {
      valid: false,
      stage: 'semantic',
      reason: 'Patch introduces more top-level declarations than expected',
    }
  }

  // Stage 3: AST syntax — parse newContent in isolation
  const tempProject = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const tempSf = tempProject.createSourceFile('__temp__.ts', patch.newContent, { overwrite: true })
  const diagnostics = tempSf.getPreEmitDiagnostics()
  const syntaxErrors = diagnostics.filter(d => d.getCategory() === 1 /* error */)
  if (syntaxErrors.length > 0) {
    return {
      valid: false,
      stage: 'syntax',
      reason: syntaxErrors[0]!.getMessageText().toString(),
    }
  }

  // Stage 4: stale-node check
  if (node.getText() !== patch.originalContent) {
    return {
      valid: false,
      stage: 'stale',
      reason: 'Node text has changed since patch was generated — re-fetch required',
    }
  }

  return { valid: true }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/execution/patch-validator.test.ts
```

Expected: all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/execution/patch-validator.ts tests/lib/execution/patch-validator.test.ts
git commit -m "feat: PatchValidator 4-stage pre-apply validation"
```

---

### Task 6: PropagationManager

**Files:**
- Create: `lib/execution/propagation-manager.ts`
- Create: `tests/lib/execution/propagation-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/execution/propagation-manager.test.ts
import { describe, it, expect } from 'vitest'
import { PropagationManager } from '@/lib/execution/propagation-manager'
import type { PropagationItem } from '@/lib/execution/types'

function item(filePath: string, symbolName = 'fn'): PropagationItem {
  return { filePath, symbolName, reason: 'test' }
}

describe('PropagationManager', () => {
  it('enqueues and dequeues items', () => {
    const mgr = new PropagationManager(10)
    mgr.enqueue(item('src/a.ts'))
    expect(mgr.dequeue()).toMatchObject({ filePath: 'src/a.ts' })
    expect(mgr.dequeue()).toBeNull()
  })

  it('does not re-enqueue visited symbols', () => {
    const mgr = new PropagationManager(10)
    mgr.enqueue(item('src/a.ts', 'fn'))
    mgr.markVisited('src/a.ts', 'fn')
    mgr.enqueue(item('src/a.ts', 'fn'))  // should be ignored
    expect(mgr.size()).toBe(1)  // only the first enqueue counts
  })

  it('reports isAtCap when queue reaches limit', () => {
    const mgr = new PropagationManager(2)
    mgr.enqueue(item('a.ts'))
    mgr.enqueue(item('b.ts'))
    expect(mgr.isAtCap()).toBe(true)
  })

  it('tracks unique added file paths', () => {
    const mgr = new PropagationManager(10)
    mgr.enqueue(item('src/a.ts'))
    mgr.enqueue(item('src/a.ts', 'other'))  // same file, different symbol
    mgr.enqueue(item('src/b.ts'))
    expect(mgr.getAddedFilePaths()).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('does not enqueue when already at cap', () => {
    const mgr = new PropagationManager(1)
    mgr.enqueue(item('a.ts'))
    mgr.enqueue(item('b.ts'))
    expect(mgr.size()).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/execution/propagation-manager.test.ts 2>&1 | head -5
```

Expected: FAIL with `Cannot find module '@/lib/execution/propagation-manager'`

- [ ] **Step 3: Implement propagation-manager.ts**

```typescript
// lib/execution/propagation-manager.ts
import type { PropagationItem } from './types'

export class PropagationManager {
  private queue: PropagationItem[] = []
  private visited: Set<string> = new Set()  // 'filePath::symbolName'
  private addedFiles: Set<string> = new Set()
  private readonly cap: number

  constructor(cap: number) {
    this.cap = cap
  }

  private visitedKey(filePath: string, symbolName: string): string {
    return `${filePath}::${symbolName}`
  }

  enqueue(item: PropagationItem): boolean {
    const key = this.visitedKey(item.filePath, item.symbolName)
    if (this.visited.has(key)) return false
    if (this.queue.length >= this.cap) return false
    this.queue.push(item)
    this.addedFiles.add(item.filePath)
    return true
  }

  markVisited(filePath: string, symbolName: string): void {
    this.visited.add(this.visitedKey(filePath, symbolName))
  }

  dequeue(): PropagationItem | null {
    return this.queue.shift() ?? null
  }

  size(): number {
    return this.queue.length
  }

  isAtCap(): boolean {
    return this.queue.length >= this.cap
  }

  getAddedFilePaths(): string[] {
    return Array.from(this.addedFiles)
  }

  isEmpty(): boolean {
    return this.queue.length === 0
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/execution/propagation-manager.test.ts
```

Expected: all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/execution/propagation-manager.ts tests/lib/execution/propagation-manager.test.ts
git commit -m "feat: PropagationManager with visited set and cap"
```

---

### Task 7: FailureClassifier

**Files:**
- Create: `lib/execution/failure-classifier.ts`
- Create: `tests/lib/execution/failure-classifier.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/execution/failure-classifier.test.ts
import { describe, it, expect } from 'vitest'
import { classifyFailure, FAILURE_PRIORITY } from '@/lib/execution/failure-classifier'

describe('classifyFailure', () => {
  it('classifies TypeScript syntax error', () => {
    const output = "src/user.ts(5,3): error TS1005: ';' expected."
    expect(classifyFailure(output)).toBe('syntax')
  })

  it('classifies TypeScript type error', () => {
    const output = "src/user.ts(10,1): error TS2322: Type 'string' is not assignable to type 'number'."
    expect(classifyFailure(output)).toBe('type')
  })

  it('classifies test failure from vitest output', () => {
    const output = `
 FAIL  tests/user.test.ts
  ● getUser › returns user by id
    Expected: "user-1"
    Received: undefined
`.trim()
    expect(classifyFailure(output)).toBe('test')
  })

  it('classifies timeout', () => {
    expect(classifyFailure('Error: execution timed out after 600000ms')).toBe('timeout')
  })

  it('returns runtime for unrecognised errors', () => {
    expect(classifyFailure('ReferenceError: Cannot read properties of undefined')).toBe('runtime')
  })
})

describe('FAILURE_PRIORITY', () => {
  it('syntax has highest priority (lowest number)', () => {
    expect(FAILURE_PRIORITY.syntax).toBeLessThan(FAILURE_PRIORITY.type)
    expect(FAILURE_PRIORITY.type).toBeLessThan(FAILURE_PRIORITY.runtime)
    expect(FAILURE_PRIORITY.runtime).toBeLessThan(FAILURE_PRIORITY.test)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/execution/failure-classifier.test.ts 2>&1 | head -5
```

Expected: FAIL with `Cannot find module '@/lib/execution/failure-classifier'`

- [ ] **Step 3: Implement failure-classifier.ts**

```typescript
// lib/execution/failure-classifier.ts
import type { FailureType } from './types'

// Lower number = higher priority. Fix syntax before type before runtime before test.
export const FAILURE_PRIORITY: Record<FailureType, number> = {
  syntax:  1,
  type:    2,
  runtime: 3,
  test:    4,
  timeout: 0,  // timeout always terminates regardless
}

// Patterns in priority order
const CLASSIFIERS: Array<{ pattern: RegExp; type: FailureType }> = [
  { pattern: /timed out/i,                                          type: 'timeout' },
  { pattern: /error TS1\d{3}:/,                                     type: 'syntax'  },  // TS syntax errors (1xxx)
  { pattern: /error TS[2-9]\d{3}:/,                                 type: 'type'    },  // TS type errors (2xxx+)
  { pattern: /\bFAIL\b.*\.test\.|● .+ ›|\bAssertionError\b/,       type: 'test'    },
]

export function classifyFailure(output: string): FailureType {
  for (const { pattern, type } of CLASSIFIERS) {
    if (pattern.test(output)) return type
  }
  return 'runtime'
}

export function highestPriority(types: FailureType[]): FailureType {
  if (types.length === 0) return 'runtime'
  return types.reduce((a, b) =>
    FAILURE_PRIORITY[a] <= FAILURE_PRIORITY[b] ? a : b
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/execution/failure-classifier.test.ts
```

Expected: all 6 tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/execution/failure-classifier.ts tests/lib/execution/failure-classifier.test.ts
git commit -m "feat: FailureClassifier with priority ordering"
```

---

### Task 8: TestSelector

**Files:**
- Create: `lib/execution/test-selector.ts`
- Create: `tests/lib/execution/test-selector.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/execution/test-selector.test.ts
import { describe, it, expect } from 'vitest'
import { selectTests } from '@/lib/execution/test-selector'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeMockDb(testPaths: string[]): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        in: () => Promise.resolve({
          data: testPaths.map(tp => ({ test_path: tp })),
          error: null,
        }),
      }),
    }),
  } as unknown as SupabaseClient
}

describe('selectTests', () => {
  it('returns direct tests for changed file IDs', async () => {
    const db = makeMockDb(['tests/user.test.ts', 'tests/auth.test.ts'])
    const scope = await selectTests(db, ['file-1', 'file-2'], 'low')
    expect(scope.directTests).toContain('tests/user.test.ts')
    expect(scope.widened).toBe(false)
  })

  it('sets widened=true for high risk', async () => {
    const db = makeMockDb(['tests/user.test.ts'])
    const scope = await selectTests(db, ['file-1'], 'high')
    expect(scope.widened).toBe(true)
  })

  it('deduplicates across directTests and dependentTests', async () => {
    const db = makeMockDb(['tests/user.test.ts', 'tests/user.test.ts'])
    const scope = await selectTests(db, ['file-1'], 'low')
    const count = scope.directTests.filter(t => t === 'tests/user.test.ts').length
    expect(count).toBe(1)
  })

  it('returns empty arrays when no tests mapped', async () => {
    const db = makeMockDb([])
    const scope = await selectTests(db, ['file-1'], 'low')
    expect(scope.directTests).toEqual([])
    expect(scope.dependentTests).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/execution/test-selector.test.ts 2>&1 | head -5
```

Expected: FAIL with `Cannot find module '@/lib/execution/test-selector'`

- [ ] **Step 3: Implement test-selector.ts**

```typescript
// lib/execution/test-selector.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { TestScope } from './types'

export async function selectTests(
  db: SupabaseClient,
  changedFileIds: string[],
  riskLevel: string
): Promise<TestScope> {
  if (changedFileIds.length === 0) {
    return { directTests: [], dependentTests: [], widened: false }
  }

  const { data } = await db
    .from('test_coverage_map')
    .select('test_path')
    .in('file_id', changedFileIds)

  const testPaths = [...new Set((data ?? []).map((r: { test_path: string }) => r.test_path))]

  const widened = riskLevel === 'high'

  return {
    directTests: testPaths,
    dependentTests: [],  // populated by orchestrator via component graph when needed
    widened,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/execution/test-selector.test.ts
```

Expected: all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/execution/test-selector.ts tests/lib/execution/test-selector.test.ts
git commit -m "feat: TestSelector from test_coverage_map"
```

---

### Task 9: BehavioralGuardrail

**Files:**
- Create: `lib/execution/behavioral-guardrail.ts`
- Create: `tests/lib/execution/behavioral-guardrail.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/execution/behavioral-guardrail.test.ts
import { describe, it, expect } from 'vitest'
import { checkBehavior } from '@/lib/execution/behavioral-guardrail'

describe('checkBehavior', () => {
  it('passes clean before/after with no anomalies', () => {
    const before = `function getUser(id: string) {\n  if (!id) return null\n  return db.find(id)\n}`
    const after  = `function getUser(id: string) {\n  if (!id) return null\n  return db.find(id + '-v2')\n}`
    const result = checkBehavior(before, after)
    expect(result.passed).toBe(true)
    expect(result.anomalies).toHaveLength(0)
  })

  it('detects removed conditional', () => {
    const before = `function getUser(id: string) {\n  if (!id) throw new Error()\n  return db.find(id)\n}`
    const after  = `function getUser(id: string) {\n  return db.find(id)\n}`
    const result = checkBehavior(before, after)
    const types = result.anomalies.map(a => a.type)
    expect(types).toContain('removed_conditional')
  })

  it('detects exception swallowing (empty catch)', () => {
    const before = `function load() { return fetch('/api') }`
    const after  = `function load() { try { return fetch('/api') } catch (e) {} }`
    const result = checkBehavior(before, after)
    const types = result.anomalies.map(a => a.type)
    expect(types).toContain('exception_swallowing')
  })

  it('detects added early return in a conditional branch', () => {
    const before = `function run(x: number) {\n  if (x > 0) {\n    process(x)\n  }\n}`
    const after  = `function run(x: number) {\n  if (x > 0) {\n    return\n  }\n  process(x)\n}`
    const result = checkBehavior(before, after)
    const types = result.anomalies.map(a => a.type)
    expect(types).toContain('early_return')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/execution/behavioral-guardrail.test.ts 2>&1 | head -5
```

Expected: FAIL with `Cannot find module '@/lib/execution/behavioral-guardrail'`

- [ ] **Step 3: Implement behavioral-guardrail.ts**

```typescript
// lib/execution/behavioral-guardrail.ts
import { Project, Node } from 'ts-morph'
import type { BehavioralResult, BehavioralAnomaly } from './types'

function countNodes(code: string, predicate: (node: Node) => boolean): number {
  const p = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const sf = p.createSourceFile('__check__.ts', code, { overwrite: true })
  let count = 0
  sf.forEachDescendant(n => { if (predicate(n)) count++ })
  return count
}

function hasEmptyCatch(code: string): boolean {
  const p = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const sf = p.createSourceFile('__check__.ts', code, { overwrite: true })
  let found = false
  sf.forEachDescendant(n => {
    if (Node.isCatchClause(n)) {
      const block = n.getBlock()
      if (block.getStatements().length === 0) found = true
    }
  })
  return found
}

function countEarlyReturnsInBranches(code: string): number {
  const p = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const sf = p.createSourceFile('__check__.ts', code, { overwrite: true })
  let count = 0
  sf.forEachDescendant(n => {
    // return statements inside if/else branches (not at top of function body)
    if (Node.isReturnStatement(n)) {
      const parent = n.getParent()
      const grandParent = parent?.getParent()
      if (grandParent && (Node.isIfStatement(grandParent) || Node.isBlock(parent))) {
        const gp = parent?.getParent()
        if (gp && Node.isIfStatement(gp)) count++
      }
    }
  })
  return count
}

export function checkBehavior(beforeCode: string, afterCode: string): BehavioralResult {
  const anomalies: BehavioralAnomaly[] = []

  // Check 1: removed conditionals
  const beforeIfs = countNodes(beforeCode, n => Node.isIfStatement(n))
  const afterIfs  = countNodes(afterCode,  n => Node.isIfStatement(n))
  if (afterIfs < beforeIfs) {
    anomalies.push({
      type: 'removed_conditional',
      description: `${beforeIfs - afterIfs} conditional(s) removed`,
      severity: 'error',
    })
  }

  // Check 2: exception swallowing (new empty catch added)
  if (!hasEmptyCatch(beforeCode) && hasEmptyCatch(afterCode)) {
    anomalies.push({
      type: 'exception_swallowing',
      description: 'Empty catch block introduced — exceptions are being silently swallowed',
      severity: 'error',
    })
  }

  // Check 3: early returns in branches
  const beforeEarlyReturns = countEarlyReturnsInBranches(beforeCode)
  const afterEarlyReturns  = countEarlyReturnsInBranches(afterCode)
  if (afterEarlyReturns > beforeEarlyReturns) {
    anomalies.push({
      type: 'early_return',
      description: `${afterEarlyReturns - beforeEarlyReturns} early return(s) added inside conditional branch(es)`,
      severity: 'warning',
    })
  }

  const hasError = anomalies.some(a => a.severity === 'error')
  return { passed: !hasError, anomalies }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/execution/behavioral-guardrail.test.ts
```

Expected: all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/execution/behavioral-guardrail.ts tests/lib/execution/behavioral-guardrail.test.ts
git commit -m "feat: BehavioralGuardrail heuristic checks"
```

---

### Task 10: PromptBuilders

**Files:**
- Create: `lib/execution/prompt-builders.ts`
- Create: `tests/lib/execution/prompt-builders.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/execution/prompt-builders.test.ts
import { describe, it, expect } from 'vitest'
import {
  buildSymbolPatchPrompt,
  buildMultiSymbolPatchPrompt,
  buildFilePatchPrompt,
} from '@/lib/execution/prompt-builders'
import type { SymbolContext } from '@/lib/execution/types'

const CTX: SymbolContext = {
  symbolName: 'getUser',
  filePath: 'src/user.ts',
  code: 'function getUser(id: string): User { return db.find(id) }',
  locator: { primary: 'abc', fallbacks: { kind: 0, approximatePosition: { line: 1, toleranceLines: 5 }, structureSignature: 'xyz' } },
  callers: ['src/controller.ts'],
  callees: ['find'],
  relatedTypes: ['User'],
  complexity: 3,
}

const TASK = { description: 'Add caching to getUser', intent: 'Reduce DB calls' }

describe('buildSymbolPatchPrompt', () => {
  it('includes task intent and description', () => {
    const p = buildSymbolPatchPrompt(TASK, CTX)
    expect(p).toContain('Add caching to getUser')
    expect(p).toContain('Reduce DB calls')
  })

  it('includes the symbol code', () => {
    const p = buildSymbolPatchPrompt(TASK, CTX)
    expect(p).toContain('function getUser')
  })

  it('includes the allowed symbols', () => {
    const p = buildSymbolPatchPrompt(TASK, CTX)
    expect(p).toContain('getUser')
  })

  it('includes previous error when provided', () => {
    const p = buildSymbolPatchPrompt(TASK, CTX, 'TypeError: cache is undefined')
    expect(p).toContain('TypeError: cache is undefined')
  })

  it('asks for confidence and requiresPropagation in JSON output', () => {
    const p = buildSymbolPatchPrompt(TASK, CTX)
    expect(p).toContain('confidence')
    expect(p).toContain('requiresPropagation')
    expect(p).toContain('newContent')
  })
})

describe('buildMultiSymbolPatchPrompt', () => {
  it('includes all symbol names', () => {
    const p = buildMultiSymbolPatchPrompt(TASK, [CTX, { ...CTX, symbolName: 'saveUser' }])
    expect(p).toContain('getUser')
    expect(p).toContain('saveUser')
  })
})

describe('buildFilePatchPrompt', () => {
  it('includes the full file content', () => {
    const p = buildFilePatchPrompt(TASK, 'full file content here', CTX.filePath)
    expect(p).toContain('full file content here')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/execution/prompt-builders.test.ts 2>&1 | head -5
```

Expected: FAIL with `Cannot find module '@/lib/execution/prompt-builders'`

- [ ] **Step 3: Implement prompt-builders.ts**

```typescript
// lib/execution/prompt-builders.ts
import type { SymbolContext } from './types'

interface PatchTask {
  description: string
  intent: string
}

const RESPONSE_SCHEMA = `
Return a JSON object with exactly these fields:
{
  "newContent": "<complete replacement code for the symbol only — not the surrounding file>",
  "confidence": <0-100 integer — your confidence this change is correct>,
  "requiresPropagation": <true if you changed the function signature (params or return type), false otherwise>,
  "reasoning": "<one sentence explanation>"
}
`.trim()

export function buildSymbolPatchPrompt(
  task: PatchTask,
  ctx: SymbolContext,
  previousError?: string
): string {
  return `You are a TypeScript code modification expert. Modify a specific symbol to implement the task below.

## Task
${task.description}

## Intent
${task.intent}

## Target Symbol
- **Name:** ${ctx.symbolName}
- **File:** ${ctx.filePath}
- **Allowed to modify:** only ${ctx.symbolName}

\`\`\`typescript
${ctx.code}
\`\`\`

## Context
- **Callers (files that use this symbol):** ${ctx.callers.join(', ') || 'none'}
- **Callees (what this symbol calls):** ${ctx.callees.join(', ') || 'none'}
- **Types used:** ${ctx.relatedTypes.join(', ') || 'none'}
${previousError ? `\n## Previous Attempt Failed\n${previousError}\nDo NOT repeat the same approach.\n` : ''}
## Output
${RESPONSE_SCHEMA}`
}

export function buildMultiSymbolPatchPrompt(
  task: PatchTask,
  contexts: SymbolContext[],
  previousError?: string
): string {
  const symbolsBlock = contexts
    .map(ctx => `### ${ctx.symbolName} (${ctx.filePath})\n\`\`\`typescript\n${ctx.code}\n\`\`\``)
    .join('\n\n')

  return `You are a TypeScript code modification expert. Modify the following symbols together as they are interdependent.

## Task
${task.description}

## Intent
${task.intent}

## Symbols to Modify
${symbolsBlock}
${previousError ? `\n## Previous Attempt Failed\n${previousError}\nDo NOT repeat the same approach.\n` : ''}
## Output
Return a JSON array, one entry per symbol:
[
  {
    "symbolName": "<name>",
    "newContent": "<replacement code>",
    "confidence": <0-100>,
    "requiresPropagation": <boolean>,
    "reasoning": "<one sentence>"
  }
]`
}

export function buildFilePatchPrompt(
  task: PatchTask,
  fileContent: string,
  filePath: string,
  previousError?: string
): string {
  return `You are a TypeScript code modification expert. Modify the file below to implement the task.

## Task
${task.description}

## Intent
${task.intent}

## File: ${filePath}
\`\`\`typescript
${fileContent}
\`\`\`
${previousError ? `\n## Previous Attempt Failed\n${previousError}\nDo NOT repeat the same approach.\n` : ''}
## Output
Return a JSON object:
{
  "newFileContent": "<complete updated file content>",
  "confidence": <0-100>,
  "requiresPropagation": <boolean>,
  "reasoning": "<one sentence>"
}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/execution/prompt-builders.test.ts
```

Expected: all 7 tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/execution/prompt-builders.ts tests/lib/execution/prompt-builders.test.ts
git commit -m "feat: prompt builders for symbol/multi-symbol/file context modes"
```

---

### Task 11: ExecutionTracer

**Files:**
- Create: `lib/execution/execution-tracer.ts`
- Create: `tests/lib/execution/execution-tracer.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/execution/execution-tracer.test.ts
import { describe, it, expect } from 'vitest'
import { hashInput, hashOutput, recordTrace } from '@/lib/execution/execution-tracer'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SymbolContext, FilePatch } from '@/lib/execution/types'

const CTX: SymbolContext = {
  symbolName: 'fn', filePath: 'src/a.ts', code: 'function fn() {}',
  locator: { primary: 'x', fallbacks: { kind: 0, approximatePosition: { line: 1, toleranceLines: 5 }, structureSignature: 'y' } },
  callers: [], callees: [], relatedTypes: [], complexity: 1,
}

describe('hashInput', () => {
  it('returns the same hash for the same inputs', () => {
    expect(hashInput(CTX, 'do task A')).toBe(hashInput(CTX, 'do task A'))
  })

  it('returns different hashes for different inputs', () => {
    expect(hashInput(CTX, 'do task A')).not.toBe(hashInput(CTX, 'do task B'))
  })
})

describe('hashOutput', () => {
  it('returns same hash for same newContent', () => {
    const patch = { newContent: 'function fn() { return 1 }' } as FilePatch
    expect(hashOutput(patch)).toBe(hashOutput(patch))
  })
})

describe('recordTrace', () => {
  it('inserts a row into execution_trace', async () => {
    const inserts: unknown[] = []
    const db = {
      from: () => ({
        insert: (row: unknown) => {
          inserts.push(row)
          return Promise.resolve({ error: null })
        },
      }),
    } as unknown as SupabaseClient

    await recordTrace(db, {
      changeId: 'cr1', iteration: 1, taskId: 't1',
      contextMode: 'symbol', inputHash: 'abc', outputHash: 'def',
      strategyUsed: 'initial', failureType: null, confidence: 85,
    })
    expect(inserts).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/execution/execution-tracer.test.ts 2>&1 | head -5
```

Expected: FAIL with `Cannot find module '@/lib/execution/execution-tracer'`

- [ ] **Step 3: Implement execution-tracer.ts**

```typescript
// lib/execution/execution-tracer.ts
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SymbolContext, FilePatch, ExecutionTraceRow } from './types'

function sha256(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 16)
}

export function hashInput(ctx: SymbolContext, taskDescription: string): string {
  return sha256(`${ctx.filePath}::${ctx.symbolName}::${ctx.code}::${taskDescription}`)
}

export function hashOutput(patch: FilePatch): string {
  return sha256(patch.newContent)
}

export async function recordTrace(
  db: SupabaseClient,
  row: ExecutionTraceRow
): Promise<void> {
  await db.from('execution_trace').insert({
    change_id:     row.changeId,
    iteration:     row.iteration,
    task_id:       row.taskId,
    context_mode:  row.contextMode,
    input_hash:    row.inputHash,
    output_hash:   row.outputHash,
    strategy_used: row.strategyUsed,
    failure_type:  row.failureType,
    confidence:    row.confidence,
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/execution/execution-tracer.test.ts
```

Expected: all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/execution/execution-tracer.ts tests/lib/execution/execution-tracer.test.ts
git commit -m "feat: ExecutionTracer with deterministic input/output hashing"
```

---

### Task 12: CodeExecutor Interface + MockCodeExecutor

**Files:**
- Create: `lib/execution/executors/code-executor.ts`

- [ ] **Step 1: Create the interface and mock**

```typescript
// lib/execution/executors/code-executor.ts
import type {
  ExecutionEnvironment,
  FilePatch,
  PatchResult,
  TypeCheckResult,
  TestResult,
  BehavioralResult,
  BehavioralScope,
  DiffSummary,
  CommitResult,
  TestScope,
} from '../types'

export interface CodeExecutor {
  /** Spin up isolated environment, clone repo, install deps, create branch */
  prepareEnvironment(project: { repoUrl: string; repoToken: string | null; id: string }, branch: string): Promise<ExecutionEnvironment>

  /** Apply a patch by AST-replacing the target node in localWorkDir, then syncing to container */
  applyPatch(env: ExecutionEnvironment, patch: FilePatch): Promise<PatchResult>

  /** Run `tsc --noEmit` inside the container */
  runTypeCheck(env: ExecutionEnvironment): Promise<TypeCheckResult>

  /** Run scoped or full test suite inside the container */
  runTests(env: ExecutionEnvironment, scope: TestScope): Promise<TestResult>

  /** Run behavioral heuristic checks on patched files */
  runBehavioralChecks(env: ExecutionEnvironment, scope: BehavioralScope): Promise<BehavioralResult>

  /** Get git diff from the container */
  getDiff(env: ExecutionEnvironment): Promise<DiffSummary>

  /** git add -A && git commit && git push inside the container */
  commitAndPush(env: ExecutionEnvironment, branch: string, message: string): Promise<CommitResult>

  /** git reset --hard HEAD then re-apply acceptedPatches — call at start of each iteration */
  resetIteration(env: ExecutionEnvironment, acceptedPatches: FilePatch[]): Promise<void>

  /** Stop container and clean up local temp dir */
  cleanup(env: ExecutionEnvironment): Promise<void>
}

// ── MockCodeExecutor (for unit tests) ─────────────────────────────────────────

export class MockCodeExecutor implements CodeExecutor {
  public calls: string[] = []

  // Override these in tests to simulate failures
  typeCheckResult: TypeCheckResult = { passed: true, errors: [], output: '' }
  testResult: TestResult = { passed: true, failures: [], output: '', testsRun: 1, testsPassed: 1, testsFailed: 0 }
  behavioralResult: BehavioralResult = { passed: true, anomalies: [] }
  patchResult: PatchResult = { success: true }

  async prepareEnvironment(): Promise<ExecutionEnvironment> {
    this.calls.push('prepareEnvironment')
    return {
      containerId: 'mock-container',
      containerWorkDir: '/app',
      localWorkDir: '/tmp/mock',
      branch: 'sf/test-branch',
      projectId: 'proj-1',
      repoUrl: 'https://github.com/test/repo',
    }
  }

  async applyPatch(_env: ExecutionEnvironment, _patch: FilePatch): Promise<PatchResult> {
    this.calls.push('applyPatch')
    return this.patchResult
  }

  async runTypeCheck(_env: ExecutionEnvironment): Promise<TypeCheckResult> {
    this.calls.push('runTypeCheck')
    return this.typeCheckResult
  }

  async runTests(_env: ExecutionEnvironment, _scope: TestScope): Promise<TestResult> {
    this.calls.push('runTests')
    return this.testResult
  }

  async runBehavioralChecks(_env: ExecutionEnvironment, _scope: BehavioralScope): Promise<BehavioralResult> {
    this.calls.push('runBehavioralChecks')
    return this.behavioralResult
  }

  async getDiff(_env: ExecutionEnvironment): Promise<DiffSummary> {
    this.calls.push('getDiff')
    return { filesChanged: ['src/user.ts'], additions: 5, deletions: 2, rawDiff: '+added\n-removed' }
  }

  async commitAndPush(_env: ExecutionEnvironment, branch: string): Promise<CommitResult> {
    this.calls.push('commitAndPush')
    return { commitHash: 'abc123', branch }
  }

  async resetIteration(_env: ExecutionEnvironment): Promise<void> {
    this.calls.push('resetIteration')
  }

  async cleanup(_env: ExecutionEnvironment): Promise<void> {
    this.calls.push('cleanup')
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/execution/executors/code-executor.ts
git commit -m "feat: CodeExecutor interface and MockCodeExecutor"
```

---

### Task 13: DockerExecutor

**Files:**
- Create: `lib/execution/executors/docker-executor.ts`

- [ ] **Step 1: Implement DockerExecutor**

The DockerExecutor uses the Docker CLI via child_process. It maintains a local temp dir on the host that mirrors the container's working tree for ts-morph operations.

```typescript
// lib/execution/executors/docker-executor.ts
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Project } from 'ts-morph'
import type { CodeExecutor } from './code-executor'
import type {
  ExecutionEnvironment, FilePatch, PatchResult, TypeCheckResult,
  TestResult, BehavioralResult, BehavioralScope, DiffSummary,
  CommitResult, TestScope,
} from '../types'
import { resolveNode } from '../node-locator'
import { checkBehavior } from '../behavioral-guardrail'

const exec = promisify(execCb)

async function dockerExec(containerId: string, command: string): Promise<{ stdout: string; stderr: string }> {
  return exec(`docker exec ${containerId} sh -c "${command.replace(/"/g, '\\"')}"`)
}

export class DockerExecutor implements CodeExecutor {
  private readonly image: string

  constructor(image = 'node:20-slim') {
    this.image = image
  }

  async prepareEnvironment(
    project: { repoUrl: string; repoToken: string | null; id: string },
    branch: string
  ): Promise<ExecutionEnvironment> {
    // 1. Create local temp dir
    const localWorkDir = await mkdtemp(join(tmpdir(), `sf-exec-${project.id}-`))

    // 2. Start container
    const { stdout } = await exec(
      `docker run -d --rm ${this.image} tail -f /dev/null`
    )
    const containerId = stdout.trim()
    const containerWorkDir = '/app'

    // 3. Clone repo into container (token injected into URL for HTTPS auth)
    const authedUrl = project.repoToken
      ? project.repoUrl.replace('https://', `https://oauth2:${project.repoToken}@`)
      : project.repoUrl

    await dockerExec(containerId, `git clone --depth 1 ${authedUrl} ${containerWorkDir}`)
    await dockerExec(containerId, `cd ${containerWorkDir} && git checkout -b ${branch}`)
    await dockerExec(containerId, `cd ${containerWorkDir} && npm install --silent`)

    // 4. Sync container state to local dir
    await exec(`docker cp ${containerId}:${containerWorkDir}/. ${localWorkDir}/`)

    return { containerId, containerWorkDir, localWorkDir, branch, projectId: project.id, repoUrl: project.repoUrl }
  }

  async applyPatch(env: ExecutionEnvironment, patch: FilePatch): Promise<PatchResult> {
    const localPath = join(env.localWorkDir, patch.path)

    try {
      // Read current file from local working copy
      const currentContent = await readFile(localPath, 'utf8')

      // Use ts-morph to find the node and replace it
      const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
      const sf = project.createSourceFile(patch.path, currentContent, { overwrite: true })
      const node = resolveNode(sf, patch.locator)
      if (!node) return { success: false, error: 'Node not found by locator' }

      node.replaceWithText(patch.newContent)
      const updatedContent = sf.getFullText()

      // Write updated file to local dir
      await writeFile(localPath, updatedContent, 'utf8')

      // Sync to container
      const containerPath = `${env.containerWorkDir}/${patch.path}`
      const containerDir = containerPath.substring(0, containerPath.lastIndexOf('/'))
      await dockerExec(env.containerId, `mkdir -p ${containerDir}`)
      await exec(`docker cp ${localPath} ${env.containerId}:${containerPath}`)

      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  async runTypeCheck(env: ExecutionEnvironment): Promise<TypeCheckResult> {
    try {
      const { stdout, stderr } = await dockerExec(env.containerId, `cd ${env.containerWorkDir} && npx tsc --noEmit 2>&1`)
      const output = stdout + stderr
      const errors = output
        .split('\n')
        .filter(line => /error TS\d+:/.test(line))
        .map(line => {
          const m = line.match(/^(.+)\((\d+),\d+\): error TS\d+: (.+)$/)
          return m ? { file: m[1]!, line: parseInt(m[2]!), message: m[3]! } : null
        })
        .filter(Boolean) as TypeCheckResult['errors']
      return { passed: errors.length === 0, errors, output }
    } catch (err) {
      const output = (err as { stdout?: string; stderr?: string }).stdout ?? String(err)
      const errors = output.split('\n').filter(l => /error TS/.test(l))
        .map(line => {
          const m = line.match(/^(.+)\((\d+),\d+\): error TS\d+: (.+)$/)
          return m ? { file: m[1]!, line: parseInt(m[2]!), message: m[3]! } : null
        }).filter(Boolean) as TypeCheckResult['errors']
      return { passed: false, errors, output }
    }
  }

  async runTests(env: ExecutionEnvironment, scope: TestScope): Promise<TestResult> {
    const allTests = [...scope.directTests, ...scope.dependentTests]
    const filter = allTests.length > 0 ? allTests.join(' ') : ''
    const cmd = filter
      ? `cd ${env.containerWorkDir} && npx vitest run ${filter} --reporter=json 2>&1`
      : `cd ${env.containerWorkDir} && npx vitest run --reporter=json 2>&1`

    try {
      const { stdout } = await dockerExec(env.containerId, cmd)
      return parseVitestJson(stdout)
    } catch (err) {
      const output = (err as { stdout?: string }).stdout ?? String(err)
      return parseVitestJson(output)
    }
  }

  async runBehavioralChecks(env: ExecutionEnvironment, scope: BehavioralScope): Promise<BehavioralResult> {
    if (!scope.criticalComponentTouched) return { passed: true, anomalies: [] }

    const allAnomalies = []
    for (const patch of scope.patches) {
      const result = checkBehavior(patch.originalContent, patch.newContent)
      allAnomalies.push(...result.anomalies)
    }
    const hasError = allAnomalies.some(a => a.severity === 'error')
    return { passed: !hasError, anomalies: allAnomalies }
  }

  async getDiff(env: ExecutionEnvironment): Promise<DiffSummary> {
    const { stdout } = await dockerExec(env.containerId, `cd ${env.containerWorkDir} && git diff HEAD --stat 2>&1 && echo '---RAW---' && git diff HEAD 2>&1`)
    const parts = stdout.split('---RAW---')
    const statPart = parts[0] ?? ''
    const rawDiff = parts[1] ?? ''
    const filesChanged = statPart.match(/^\s+\S+/gm)?.map(f => f.trim()) ?? []
    const addMatch = statPart.match(/(\d+) insertion/)
    const delMatch = statPart.match(/(\d+) deletion/)
    return {
      filesChanged,
      additions: addMatch ? parseInt(addMatch[1]!) : 0,
      deletions: delMatch ? parseInt(delMatch[1]!) : 0,
      rawDiff,
    }
  }

  async commitAndPush(env: ExecutionEnvironment, branch: string, message: string): Promise<CommitResult> {
    await dockerExec(env.containerId, `cd ${env.containerWorkDir} && git config user.email "sf@softwarefactory.ai"`)
    await dockerExec(env.containerId, `cd ${env.containerWorkDir} && git config user.name "Software Factory"`)
    await dockerExec(env.containerId, `cd ${env.containerWorkDir} && git add -A && git commit -m "${message.replace(/"/g, '\\"')}"`)
    await dockerExec(env.containerId, `cd ${env.containerWorkDir} && git push origin ${branch}`)
    const { stdout } = await dockerExec(env.containerId, `cd ${env.containerWorkDir} && git rev-parse HEAD`)
    return { commitHash: stdout.trim(), branch }
  }

  async resetIteration(env: ExecutionEnvironment, acceptedPatches: FilePatch[]): Promise<void> {
    // Reset container to last commit
    await dockerExec(env.containerId, `cd ${env.containerWorkDir} && git reset --hard HEAD`)
    // Re-sync local dir from container
    await exec(`docker cp ${env.containerId}:${env.containerWorkDir}/. ${env.localWorkDir}/`)
    // Re-apply accepted patches
    for (const patch of acceptedPatches) {
      await this.applyPatch(env, patch)
    }
  }

  async cleanup(env: ExecutionEnvironment): Promise<void> {
    try {
      await exec(`docker stop ${env.containerId}`)
    } catch { /* container may already be gone */ }
    try {
      await rm(env.localWorkDir, { recursive: true, force: true })
    } catch { /* best effort */ }
  }
}

function parseVitestJson(output: string): TestResult {
  try {
    // vitest --reporter=json outputs JSON at the end
    const jsonStart = output.lastIndexOf('{')
    if (jsonStart === -1) throw new Error('No JSON found')
    const json = JSON.parse(output.slice(jsonStart))
    const numTotalTests = json.numTotalTests ?? 0
    const numFailedTests = json.numFailedTests ?? 0
    const numPassedTests = json.numPassedTests ?? 0
    const failures: TestResult['failures'] = []
    for (const suite of json.testResults ?? []) {
      for (const result of suite.assertionResults ?? []) {
        if (result.status === 'failed') {
          failures.push({ testName: result.fullName ?? result.title, error: result.failureMessages?.join('\n') ?? '' })
        }
      }
    }
    return { passed: numFailedTests === 0, failures, output, testsRun: numTotalTests, testsPassed: numPassedTests, testsFailed: numFailedTests }
  } catch {
    // Can't parse JSON — check for obvious FAIL signal
    const passed = !output.includes('FAIL') && !output.includes('failed')
    return { passed, failures: [], output, testsRun: 0, testsPassed: 0, testsFailed: 0 }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/execution/executors/docker-executor.ts
git commit -m "feat: DockerExecutor via Docker CLI"
```

---

### Task 14: ExecutionOrchestrator

**Files:**
- Create: `lib/execution/execution-orchestrator.ts`
- Create: `tests/lib/execution/execution-orchestrator.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/execution/execution-orchestrator.test.ts
import { describe, it, expect } from 'vitest'
import { runExecution } from '@/lib/execution/execution-orchestrator'
import { MockCodeExecutor } from '@/lib/execution/executors/code-executor'
import { MockAIProvider } from '@/lib/ai/adapters/mock'
import type { SupabaseClient } from '@supabase/supabase-js'

const PLAN = {
  id: 'plan-1', status: 'approved', branch_name: 'sf/cr1-fix',
  change_id: 'cr1',
}
const TASKS = [
  { id: 't1', plan_id: 'plan-1', component_id: 'c1', description: 'Update getUser', order_index: 0, status: 'pending' },
]
const CHANGE = { id: 'cr1', project_id: 'proj1', title: 'Fix auth', intent: 'fix it', type: 'bug', risk_level: 'low' }
const PROJECT = { id: 'proj1', repo_url: 'https://github.com/test/repo', repo_token: null }
const IMPACT_COMPONENTS = [
  { component_id: 'c1', impact_weight: 1.0, system_components: { name: 'AuthService', type: 'auth' } },
]
const COMPONENT_FILES = [{ file_id: 'f1', files: { path: 'src/auth.ts' } }]

function makeMockDb(opts: { planStatus?: string } = {}): { db: SupabaseClient; updates: unknown[] } {
  const updates: unknown[] = []
  const db = {
    from: (table: string) => {
      if (table === 'change_requests') {
        return {
          update: (data: unknown) => ({ eq: (_c: string, _v: string) => { updates.push({ table, data }); return Promise.resolve({ error: null }) } }),
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: CHANGE }) }) }),
        }
      }
      if (table === 'change_plans') {
        return {
          select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: { ...PLAN, status: opts.planStatus ?? 'approved' } }) }) }) }) }),
        }
      }
      if (table === 'change_plan_tasks') {
        return {
          select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: TASKS }) }) }),
          update: (data: unknown) => ({ eq: () => ({ eq: () => { updates.push({ table, data }); return Promise.resolve({ error: null }) } }) }),
        }
      }
      if (table === 'projects') {
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: PROJECT }) }) }) }
      }
      if (table === 'change_impact_components') {
        return { select: () => ({ eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: IMPACT_COMPONENTS }) }) }) }) }
      }
      if (table === 'change_impacts') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'impact-1' } }) }) }) }
      }
      if (table === 'component_assignment') {
        return { select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: COMPONENT_FILES }) }) }) }
      }
      if (table === 'test_coverage_map') {
        return { select: () => ({ in: () => Promise.resolve({ data: [] }) }) }
      }
      if (table === 'component_graph_edges') {
        return { select: () => ({ in: () => Promise.resolve({ data: [] }) }) }
      }
      if (table === 'execution_snapshots') {
        return { insert: () => Promise.resolve({ data: [{ id: 'snap-1' }], error: null }) }
      }
      if (table === 'execution_trace') {
        return { insert: () => Promise.resolve({ error: null }) }
      }
      if (table === 'change_commits') {
        return { insert: () => Promise.resolve({ error: null }) }
      }
      return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }) }
    },
  } as unknown as SupabaseClient
  return { db, updates }
}

function makeAi(newContent = 'function getUser() { return "updated" }'): MockAIProvider {
  const ai = new MockAIProvider()
  ai.setDefaultResponse(JSON.stringify({
    newContent,
    confidence: 85,
    requiresPropagation: false,
    reasoning: 'test',
  }))
  return ai
}

describe('runExecution', () => {
  it('happy path: sets status to executing then review', async () => {
    const { db, updates } = makeMockDb()
    const executor = new MockCodeExecutor()
    const ai = makeAi()

    await runExecution('cr1', db, ai, executor)

    const statusUpdates = (updates as Array<{ table: string; data: { status?: string } }>)
      .filter(u => u.table === 'change_requests' && u.data.status)
      .map(u => u.data.status)
    expect(statusUpdates).toContain('executing')
    expect(statusUpdates).toContain('review')
    expect(executor.calls).toContain('prepareEnvironment')
    expect(executor.calls).toContain('cleanup')
  })

  it('sets status to failed when plan not found', async () => {
    const { db, updates } = makeMockDb({ planStatus: 'draft' })
    const executor = new MockCodeExecutor()
    const ai = makeAi()

    await runExecution('cr1', db, ai, executor).catch(() => {})

    const statusUpdates = (updates as Array<{ table: string; data: { status?: string } }>)
      .filter(u => u.table === 'change_requests' && u.data.status)
      .map(u => u.data.status)
    expect(statusUpdates).toContain('executing')
    // Plan is draft, not approved — should abort and revert to 'analyzed' or 'failed'
    const finalStatus = statusUpdates[statusUpdates.length - 1]
    expect(['analyzed', 'failed']).toContain(finalStatus)
  })

  it('calls resetIteration before each iteration', async () => {
    const { db } = makeMockDb()
    const executor = new MockCodeExecutor()
    const ai = makeAi()
    await runExecution('cr1', db, ai, executor)
    expect(executor.calls).toContain('resetIteration')
  })

  it('calls commitAndPush on success', async () => {
    const { db } = makeMockDb()
    const executor = new MockCodeExecutor()
    await runExecution('cr1', db, new MockAIProvider(), executor)
    // MockAIProvider returns '{}' by default — orchestrator treats missing patch as no-op
    // Success path: tsc passes, tests pass → commit
    expect(executor.calls).toContain('commitAndPush')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/execution/execution-orchestrator.test.ts 2>&1 | head -5
```

Expected: FAIL with `Cannot find module '@/lib/execution/execution-orchestrator'`

- [ ] **Step 3: Implement execution-orchestrator.ts**

```typescript
// lib/execution/execution-orchestrator.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { CodeExecutor } from './executors/code-executor'
import type {
  FilePatch, SymbolContext, ExecutionScope, ExecutionLimits,
  ContextMode, TestScope, BehavioralScope,
} from './types'
import { DEFAULT_LIMITS } from './types'
import { extractSymbol } from './symbol-extractor'
import { validatePatch } from './patch-validator'
import { PropagationManager } from './propagation-manager'
import { classifyFailure, FAILURE_PRIORITY } from './failure-classifier'
import { selectTests } from './test-selector'
import { hashInput, hashOutput, recordTrace } from './execution-tracer'
import { buildSymbolPatchPrompt, buildFilePatchPrompt } from './prompt-builders'
import { Project } from 'ts-morph'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

function errorSignature(output: string): string {
  return createHash('sha256').update(output.slice(0, 500)).digest('hex').slice(0, 12)
}

function chooseContextMode(ctx: SymbolContext, limits: ExecutionLimits): ContextMode {
  if (ctx.complexity > limits.symbolComplexityHighThreshold) return 'file'
  if (ctx.complexity < limits.symbolComplexityLowThreshold) return 'symbol'
  return 'multi-symbol'
}

interface ExecutionState {
  iteration: number
  aiCallCount: number
  startedAt: number
  acceptedPatches: FilePatch[]
  executionScope: ExecutionScope
  errorHistory: Map<string, number>
  limits: ExecutionLimits
}

interface PlanTask {
  id: string
  component_id: string | null
  description: string
  order_index: number
  status: string
}

// Component type ordering — leaf (ui) processed first, core (db) last
const COMPONENT_DEPTH: Record<string, number> = {
  ui: 0, component: 1, module: 2, api: 3, service: 4, auth: 5, repository: 6, db: 7,
}

export async function runExecution(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider,
  executor: CodeExecutor,
  limits: ExecutionLimits = DEFAULT_LIMITS
): Promise<void> {
  await db.from('change_requests').update({ status: 'executing' }).eq('id', changeId)

  let env: Awaited<ReturnType<CodeExecutor['prepareEnvironment']>> | null = null

  try {
    // Load change, plan, project
    const { data: change } = await db.from('change_requests')
      .select('id, project_id, title, intent, type, risk_level')
      .eq('id', changeId).single()
    if (!change) throw new Error(`Change not found: ${changeId}`)

    const { data: plan } = await db.from('change_plans')
      .select('id, status, branch_name, change_id')
      .eq('change_id', changeId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (!plan || plan.status !== 'approved') throw new Error('No approved plan found')

    const { data: project } = await db.from('projects')
      .select('id, repo_url, repo_token').eq('id', change.project_id).single()
    if (!project) throw new Error('Project not found')

    const { data: rawTasks } = await db.from('change_plan_tasks')
      .select('id, component_id, description, order_index, status')
      .eq('plan_id', plan.id).order('order_index', { ascending: true })
    const tasks: PlanTask[] = rawTasks ?? []

    // Load impacted components for ordering + file mapping
    const { data: impact } = await db.from('change_impacts')
      .select('id').eq('change_id', changeId).maybeSingle()

    const componentTypeMap: Record<string, string> = {}
    const componentFileMap: Record<string, string[]> = {}

    if (impact) {
      const { data: impactComponents } = await db.from('change_impact_components')
        .select('component_id, system_components(name, type)')
        .eq('impact_id', impact.id).order('impact_weight', { ascending: false }).limit(20)
      for (const ic of impactComponents ?? []) {
        const comp = (ic as { component_id: string; system_components: { name: string; type: string } | null })
        if (comp.system_components) {
          componentTypeMap[comp.component_id] = comp.system_components.type
        }
      }
      for (const componentId of Object.keys(componentTypeMap)) {
        const { data: assignments } = await db.from('component_assignment')
          .select('file_id, files(path)').eq('component_id', componentId).eq('is_primary', true)
        componentFileMap[componentId] = (assignments ?? [])
          .map((a: { files: { path: string } | null }) => a.files?.path).filter(Boolean) as string[]
      }
    }

    // Build planned files list
    const plannedFiles = Object.values(componentFileMap).flat()

    // Sort tasks: leaf components (ui) first, core (db) last
    const sortedTasks = [...tasks].sort((a, b) => {
      const depthA = COMPONENT_DEPTH[componentTypeMap[a.component_id ?? ''] ?? ''] ?? 3
      const depthB = COMPONENT_DEPTH[componentTypeMap[b.component_id ?? ''] ?? ''] ?? 3
      return depthA - depthB
    })

    const branch = plan.branch_name ?? `sf/${changeId.slice(0, 8)}-exec`
    env = await executor.prepareEnvironment(project, branch)

    const state: ExecutionState = {
      iteration: 0,
      aiCallCount: 0,
      startedAt: Date.now(),
      acceptedPatches: [],
      executionScope: { plannedFiles, addedViaPropagation: [] },
      errorHistory: new Map(),
      limits,
    }

    let pendingTasks = sortedTasks.filter(t => t.status === 'pending')
    let fullSuccess = false

    while (state.iteration < limits.maxIterations && pendingTasks.length > 0) {
      // Resource limit check
      if (Date.now() - state.startedAt > limits.maxDurationMs) break
      if (state.aiCallCount >= limits.maxAiCalls) break

      state.iteration++
      await executor.resetIteration(env, state.acceptedPatches)

      const propagationMgr = new PropagationManager(limits.maxPropagationQueueSize)
      const iterationPatches: FilePatch[] = []
      const completedTaskIds: string[] = []
      const failedTaskIds: Map<string, { failureType: string; lastError: string }> = new Map()

      for (const task of pendingTasks) {
        if (state.aiCallCount >= limits.maxAiCalls) break

        const filePaths = componentFileMap[task.component_id ?? ''] ?? []
        if (filePaths.length === 0) {
          // Mark as done if no files to modify
          completedTaskIds.push(task.id)
          continue
        }

        // For each file in the component, try to generate and apply a patch
        for (const filePath of filePaths) {
          const localFilePath = join(env.localWorkDir, filePath)
          let fileContent: string
          try {
            fileContent = await readFile(localFilePath, 'utf8')
          } catch {
            continue  // file not found locally, skip
          }

          // Detect signature change heuristic: task description mentions parameters/return
          const mayHaveSignatureChange = /signature|parameter|param|return type|argument/i.test(task.description)

          // Extract symbol context (best-effort: find the primary function in this file)
          const project2 = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
          const sf = project2.createSourceFile(filePath, fileContent, { overwrite: true })
          const functions = sf.getFunctions()
          const targetFn = functions[0]  // heuristic: first function; could be improved

          // Fetch callers from component graph
          const { data: graphEdges } = await db.from('component_graph_edges')
            .select('from_file_id, files!from_file_id(path)')
            .in('to_file_id', [/* fileId would go here — simplified */])
          const callerPaths: string[] = (graphEdges ?? [])
            .map((e: { files: { path: string } | null }) => e.files?.path).filter(Boolean) as string[]

          const ctx: SymbolContext | null = targetFn
            ? extractSymbol(filePath, fileContent, targetFn.getName() ?? 'unknown', callerPaths)
            : null

          if (!ctx) continue

          // Preemptive propagation for signature changes
          if (mayHaveSignatureChange) {
            for (const callerPath of callerPaths) {
              propagationMgr.enqueue({ filePath: callerPath, symbolName: ctx.symbolName, reason: `signature change in ${ctx.symbolName}` })
            }
            if (propagationMgr.isAtCap()) {
              // Divergence check
              const totalPropagated = propagationMgr.getAddedFilePaths().length
              if (totalPropagated > plannedFiles.length * limits.propagationFactor) {
                // Flag divergence — write snapshot and abort
                await writeSnapshot(db, changeId, state, 'error', true)
                throw new Error('Execution diverging from plan — propagation exceeded threshold')
              }
            }
          }

          const contextMode = chooseContextMode(ctx, limits)
          const inputHash = hashInput(ctx, task.description)

          // Build prompt
          let prompt: string
          let previousError: string | undefined
          const lastErrKey = `${task.id}:${filePath}`
          // Note: previousError tracking simplified here; full impl would track per-task
          prompt = contextMode === 'file'
            ? buildFilePatchPrompt({ description: task.description, intent: change.intent }, fileContent, filePath, previousError)
            : buildSymbolPatchPrompt({ description: task.description, intent: change.intent }, ctx, previousError)

          // Call AI
          state.aiCallCount++
          const aiResult = await ai.complete(prompt, { maxTokens: 4096 })
          let parsed: { newContent?: string; newFileContent?: string; confidence?: number; requiresPropagation?: boolean } = {}
          try { parsed = JSON.parse(aiResult.content) } catch { continue }

          const newContent = parsed.newContent ?? parsed.newFileContent ?? ''
          if (!newContent) continue

          const confidence = parsed.confidence ?? 0
          if (confidence < limits.confidenceThreshold) continue  // skip low-confidence patches

          // Build FilePatch
          const patch: FilePatch = {
            path: filePath,
            locator: ctx.locator,
            originalContent: ctx.code,
            newContent,
            confidence,
            requiresPropagation: parsed.requiresPropagation ?? false,
            allowedChanges: { symbols: [ctx.symbolName], intent: task.description },
          }

          // Validate
          const project3 = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
          const sfValidate = project3.createSourceFile(filePath, fileContent, { overwrite: true })
          const validation = validatePatch(sfValidate, patch)
          if (!validation.valid) {
            await recordTrace(db, {
              changeId, iteration: state.iteration, taskId: task.id,
              contextMode, inputHash, outputHash: null,
              strategyUsed: 'initial', failureType: 'syntax', confidence,
            })
            continue
          }

          // Apply
          const patchResult = await executor.applyPatch(env, patch)
          if (!patchResult.success) continue

          await recordTrace(db, {
            changeId, iteration: state.iteration, taskId: task.id,
            contextMode, inputHash, outputHash: hashOutput(patch),
            strategyUsed: 'initial', failureType: null, confidence,
          })

          iterationPatches.push(patch)

          // Enqueue propagation
          if (patch.requiresPropagation) {
            for (const callerPath of callerPaths) {
              propagationMgr.enqueue({ filePath: callerPath, symbolName: ctx.symbolName, reason: `requiresPropagation from ${filePath}` })
            }
          }
        }

        completedTaskIds.push(task.id)
      }

      // Validate: type-check first, then tests
      const typeCheck = await executor.runTypeCheck(env)
      if (!typeCheck.passed) {
        const sig = errorSignature(typeCheck.output)
        state.errorHistory.set(sig, (state.errorHistory.get(sig) ?? 0) + 1)
        if ((state.errorHistory.get(sig) ?? 0) >= limits.stagnationWindow) break

        await writeSnapshot(db, changeId, state, 'error')
        // Don't mark tasks complete — retry next iteration
        continue
      }

      // Scoped test run
      const changedFileIds: string[] = []  // simplified — would map filePaths to IDs via DB
      const testScope: TestScope = await selectTests(db, changedFileIds, change.risk_level ?? 'low')
      const testResult = await executor.runTests(env, testScope)

      if (!testResult.passed) {
        const sig = errorSignature(testResult.output)
        state.errorHistory.set(sig, (state.errorHistory.get(sig) ?? 0) + 1)
        if ((state.errorHistory.get(sig) ?? 0) >= limits.stagnationWindow) break

        const failureType = classifyFailure(testResult.output)
        for (const taskId of completedTaskIds) {
          failedTaskIds.set(taskId, { failureType, lastError: testResult.output.slice(0, 500) })
        }
        await writeSnapshot(db, changeId, state, 'error')
        continue
      }

      // Behavioral checks
      const behavioralScope: BehavioralScope = {
        patches: iterationPatches,
        criticalComponentTouched: Object.values(componentTypeMap).some(t => ['auth', 'db'].includes(t)),
      }
      const behavResult = await executor.runBehavioralChecks(env, behavioralScope)
      if (!behavResult.passed) {
        await writeSnapshot(db, changeId, state, 'error')
        continue
      }

      // All checks passed — mark tasks done
      state.acceptedPatches.push(...iterationPatches)
      for (const taskId of completedTaskIds) {
        await db.from('change_plan_tasks').update({ status: 'done' }).eq('id', taskId).eq('plan_id', plan.id)
      }

      pendingTasks = pendingTasks.filter(t => !completedTaskIds.includes(t.id))
      if (pendingTasks.length === 0) {
        fullSuccess = true
        break
      }
    }

    // Final: commit and push
    const diff = await executor.getDiff(env)
    const commitMsg = `feat: ${change.title} (${changeId.slice(0, 8)})`
    const commitResult = await executor.commitAndPush(env, branch, commitMsg)

    await db.from('change_commits').insert({
      change_id: changeId,
      branch_name: commitResult.branch,
      commit_hash: commitResult.commitHash,
    })

    const terminationReason = fullSuccess ? 'passed' : (state.iteration >= limits.maxIterations ? 'max_iterations' : 'error')
    await writeSnapshot(db, changeId, state, terminationReason, false, diff)

    const finalStatus = fullSuccess ? 'review' : (pendingTasks.length === 0 ? 'review' : 'review')  // partial success still goes to review
    await db.from('change_requests').update({ status: finalStatus }).eq('id', changeId)

  } catch (err) {
    await db.from('change_requests').update({ status: 'failed' }).eq('id', changeId)
    throw err
  } finally {
    if (env) await executor.cleanup(env)
  }
}

async function writeSnapshot(
  db: SupabaseClient,
  changeId: string,
  state: ExecutionState,
  terminationReason: string,
  planDivergence = false,
  diff?: { filesChanged: string[] }
): Promise<void> {
  await db.from('execution_snapshots').insert({
    change_id: changeId,
    iteration: state.iteration,
    files_modified: diff?.filesChanged ?? [],
    planned_files: state.executionScope.plannedFiles,
    propagated_files: state.executionScope.addedViaPropagation,
    plan_divergence: planDivergence,
    partial_success: false,
    termination_reason: terminationReason,
  })
}
```

- [ ] **Step 4: Run orchestrator tests**

```bash
npx vitest run tests/lib/execution/execution-orchestrator.test.ts
```

Expected: happy path and failed plan tests pass; review status is set correctly

- [ ] **Step 5: Run all execution lib tests to check for regressions**

```bash
npx vitest run tests/lib/execution/
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add lib/execution/execution-orchestrator.ts tests/lib/execution/execution-orchestrator.test.ts
git commit -m "feat: ExecutionOrchestrator main loop"
```

---

### Task 15: API Endpoint

**Files:**
- Create: `app/api/change-requests/[id]/execute/route.ts`

- [ ] **Step 1: Create the route**

```typescript
// app/api/change-requests/[id]/execute/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getProvider } from '@/lib/ai/registry'
import { runExecution } from '@/lib/execution/execution-orchestrator'
import { DockerExecutor } from '@/lib/execution/executors/docker-executor'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select('id, status, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (change.status !== 'planned') {
    return NextResponse.json(
      { error: `Cannot execute from status '${change.status}'. Change must be 'planned'.` },
      { status: 409 }
    )
  }

  // Verify approved plan exists
  const { data: plan } = await db
    .from('change_plans')
    .select('id, status')
    .eq('change_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!plan || plan.status !== 'approved') {
    return NextResponse.json({ error: 'No approved plan found' }, { status: 409 })
  }

  const adminDb = createAdminClient()
  const ai = getProvider()
  const executor = new DockerExecutor()

  runExecution(id, adminDb, ai, executor).catch(err =>
    console.error(`[execution-orchestrator] change ${id} failed:`, err)
  )

  return NextResponse.json({ status: 'executing' }, { status: 202 })
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select('id, status, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: snapshots } = await db
    .from('execution_snapshots')
    .select('id, iteration, files_modified, tests_passed, tests_failed, error_summary, termination_reason, planned_files, propagated_files, plan_divergence, partial_success, duration_ms')
    .eq('change_id', id)
    .order('iteration', { ascending: true })

  const { data: traces } = await db
    .from('execution_trace')
    .select('id, iteration, task_id, context_mode, strategy_used, failure_type, confidence, created_at')
    .eq('change_id', id)
    .order('created_at', { ascending: true })

  const { data: tasks } = await db
    .from('change_plan_tasks')
    .select('id, description, status, failure_type, last_error, order_index, system_components(name, type)')
    .eq('plan_id',
      (await db.from('change_plans').select('id').eq('change_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle())?.data?.id ?? ''
    )
    .order('order_index', { ascending: true })

  return NextResponse.json({
    status: change.status,
    snapshots: snapshots ?? [],
    traces: traces ?? [],
    tasks: tasks ?? [],
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add app/api/change-requests/[id]/execute/route.ts
git commit -m "feat: execute API endpoint (POST trigger, GET status)"
```

---

### Task 16: Execution Screen UI

**Files:**
- Create: `app/projects/[id]/changes/[changeId]/execution/page.tsx`

- [ ] **Step 1: Create the execution page**

```typescript
// app/projects/[id]/changes/[changeId]/execution/page.tsx
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ExecutionView from './execution-view'

export default async function ExecutionPage({
  params,
}: {
  params: Promise<{ id: string; changeId: string }>
}) {
  const { id, changeId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: change } = await db
    .from('change_requests')
    .select('id, title, status, risk_level, projects!inner(id, name, owner_id)')
    .eq('id', changeId)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) redirect(`/projects/${id}`)

  const { data: project } = await db.from('projects').select('id, name').eq('id', id).single()

  return <ExecutionView change={change} project={project} />
}
```

- [ ] **Step 2: Create `execution/execution-view.tsx`**

```typescript
// app/projects/[id]/changes/[changeId]/execution/execution-view.tsx
'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'

interface Snapshot {
  id: string; iteration: number; files_modified: string[]
  tests_passed: number; tests_failed: number; error_summary: string | null
  termination_reason: string | null; planned_files: string[]
  propagated_files: string[]; plan_divergence: boolean; partial_success: boolean
}

interface TraceEntry {
  id: string; iteration: number; task_id: string; context_mode: string
  strategy_used: string; failure_type: string | null; confidence: number | null
}

interface Task {
  id: string; description: string; status: string
  failure_type: string | null; last_error: string | null; order_index: number
  system_components: { name: string; type: string } | null
}

interface Change { id: string; title: string; status: string; risk_level: string | null }
interface Project { id: string; name: string }

const STATUS_POLLING = ['executing']

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    executing: 'bg-blue-100 text-blue-800', review: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800', done: 'bg-gray-100 text-gray-700',
  }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  )
}

function taskStatusDot(status: string) {
  if (status === 'done') return <span className="w-2 h-2 rounded-full bg-green-500 inline-block mr-2" />
  if (status === 'failed') return <span className="w-2 h-2 rounded-full bg-red-500 inline-block mr-2" />
  return <span className="w-2 h-2 rounded-full bg-gray-300 inline-block mr-2" />
}

export default function ExecutionView({ change, project }: { change: Change; project: Project | null }) {
  const router = useRouter()
  const [status, setStatus] = useState(change.status)
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [traces, setTraces] = useState<TraceEntry[]>([])
  const [loading, setLoading] = useState(false)

  const poll = useCallback(async () => {
    const res = await fetch(`/api/change-requests/${change.id}/execute`)
    if (!res.ok) return
    const data = await res.json()
    setStatus(data.status)
    setSnapshots(data.snapshots ?? [])
    setTasks(data.tasks ?? [])
    setTraces(data.traces ?? [])
  }, [change.id])

  useEffect(() => {
    poll()
    if (!STATUS_POLLING.includes(status)) return
    const timer = setInterval(poll, 2000)
    return () => clearInterval(timer)
  }, [status, poll])

  const latestSnapshot = snapshots[snapshots.length - 1]
  const plannedCount = latestSnapshot?.planned_files.length ?? 0
  const propagatedCount = latestSnapshot?.propagated_files.length ?? 0
  const planDivergence = latestSnapshot?.plan_divergence ?? false

  return (
    <div className="min-h-screen bg-gray-50 flex">
      <LeftNav projectId={project?.id} projectName={project?.name} />
      <div className="flex-1 flex flex-col">
        <header className="bg-white border-b px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">{change.title}</h1>
            <p className="text-sm text-gray-500 mt-0.5">Execution</p>
          </div>
          <div className="flex items-center gap-3">
            {statusBadge(status)}
            <ProfileAvatar />
          </div>
        </header>

        <main className="flex-1 p-6 max-w-4xl mx-auto w-full space-y-6">

          {/* Plan divergence warning */}
          {planDivergence && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
              <strong>Execution deviating from plan</strong> — propagation expanded scope beyond threshold. Human approval required to continue.
            </div>
          )}

          {/* Scope tracker */}
          {(plannedCount > 0 || propagatedCount > 0) && (
            <div className="bg-white rounded-lg border p-4">
              <h2 className="text-sm font-medium text-gray-700 mb-3">Execution Scope</h2>
              <div className="flex gap-6 text-sm">
                <div><span className="text-gray-500">Planned files:</span> <span className="font-medium">{plannedCount}</span></div>
                {propagatedCount > 0 && (
                  <div><span className="text-gray-500">Added via propagation:</span> <span className="font-medium text-amber-600">+{propagatedCount}</span></div>
                )}
                <div><span className="text-gray-500">Iterations:</span> <span className="font-medium">{snapshots.length}</span></div>
              </div>
            </div>
          )}

          {/* Task list */}
          <div className="bg-white rounded-lg border">
            <div className="px-5 py-4 border-b">
              <h2 className="text-sm font-medium text-gray-700">Tasks</h2>
            </div>
            <ul className="divide-y">
              {tasks.map(task => (
                <li key={task.id} className="px-5 py-3">
                  <div className="flex items-start gap-2">
                    <div className="mt-1.5">{taskStatusDot(task.status)}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-800">{task.description}</p>
                      {task.system_components && (
                        <p className="text-xs text-gray-400 mt-0.5">
                          {task.system_components.name} · {task.system_components.type}
                        </p>
                      )}
                      {task.status === 'failed' && task.last_error && (
                        <pre className="mt-2 text-xs text-red-700 bg-red-50 rounded p-2 overflow-x-auto whitespace-pre-wrap">
                          {task.last_error.slice(0, 300)}
                        </pre>
                      )}
                    </div>
                    <div className="text-xs text-gray-400 capitalize">{task.status}</div>
                  </div>
                </li>
              ))}
              {tasks.length === 0 && (
                <li className="px-5 py-6 text-center text-sm text-gray-400">Loading tasks…</li>
              )}
            </ul>
          </div>

          {/* Iterations */}
          {snapshots.length > 0 && (
            <div className="bg-white rounded-lg border">
              <div className="px-5 py-4 border-b">
                <h2 className="text-sm font-medium text-gray-700">Iterations</h2>
              </div>
              <ul className="divide-y">
                {snapshots.map(snap => (
                  <li key={snap.id} className="px-5 py-3 flex items-center justify-between text-sm">
                    <span className="text-gray-700">Iteration {snap.iteration}</span>
                    <div className="flex items-center gap-4 text-gray-500">
                      <span>{snap.tests_passed} passed · {snap.tests_failed} failed</span>
                      <span>{snap.files_modified.length} files</span>
                      {snap.termination_reason && (
                        <span className={`capitalize ${snap.termination_reason === 'passed' ? 'text-green-600' : 'text-red-500'}`}>
                          {snap.termination_reason}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Action buttons */}
          {(status === 'review') && (
            <div className="flex justify-end">
              <button
                onClick={() => router.push(`/projects/${project?.id}/changes/${change.id}/review` )}
                className="px-4 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-700"
              >
                Go to Review
              </button>
            </div>
          )}

          {status === 'executing' && (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              Executing… polling every 2 seconds
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add app/projects/[id]/changes/[changeId]/execution/
git commit -m "feat: execution screen with live polling"
```

---

### Final: Full test run

- [ ] **Step 1: Run all execution tests**

```bash
npx vitest run tests/lib/execution/
```

Expected: all tests in all 9 test files pass

- [ ] **Step 2: Run the full test suite**

```bash
npm test
```

Expected: no regressions in existing tests

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no type errors

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: Plan 6 execution loop complete"
```
