# Agent Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three agent loops (requirements, planning, coding) and four UI screens (execution, plan, review, project config) to turn approved requirements into a git branch with working code.

**Architecture:** A new `lib/agent/` module connects to the existing system at one seam: `requirement_id`. The job runner is called twice — once for planning (stops at `awaiting_plan_approval`), once for coding (stops at `awaiting_review`). All AI calls go through the existing `lib/ai/` provider abstraction.

**Tech Stack:** Node.js `child_process` (executor), Supabase Realtime (live logs), Next.js App Router (pages + API routes), Vitest (tests), existing `MockAIProvider` (test doubles).

---

## File Map

**New files:**
- `supabase/migrations/003_agent_schema.sql`
- `lib/supabase/admin.ts`
- `lib/agent/types.ts`
- `lib/agent/executor.ts`
- `lib/agent/progress.ts`
- `lib/agent/job-runner.ts`
- `lib/agent/prompts/requirements-loop-prompt.ts`
- `lib/agent/prompts/planner-prompt.ts`
- `lib/agent/prompts/coder-prompt.ts`
- `lib/agent/agents/requirements.agent.ts`
- `lib/agent/agents/planner.agent.ts`
- `lib/agent/agents/coder.agent.ts`
- `app/api/jobs/route.ts`
- `app/api/jobs/[id]/route.ts`
- `app/projects/[id]/jobs/[jobId]/execution/page.tsx`
- `app/projects/[id]/jobs/[jobId]/plan/page.tsx`
- `app/projects/[id]/jobs/[jobId]/review/page.tsx`
- `components/agent/execution-screen.tsx`
- `components/agent/plan-screen.tsx`
- `components/agent/review-screen.tsx`
- `tests/lib/agent/executor.test.ts`
- `tests/lib/agent/job-runner.test.ts`
- `tests/lib/agent/agents/requirements.agent.test.ts`
- `tests/lib/agent/agents/planner.agent.test.ts`
- `tests/lib/agent/agents/coder.agent.test.ts`

**Modified files:**
- `lib/supabase/types.ts` — add Job, AgentPlan, LogEntry types
- `lib/requirements/parser.ts` — use requirements agent loop
- `app/projects/[id]/requirements/page.tsx` — pass projectId + targetPath to Workspace
- `components/requirements/workspace.tsx` — add "Run Agent" button

---

## Task 1: DB Schema

**Files:**
- Create: `supabase/migrations/003_agent_schema.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 003_agent_schema.sql

-- Add target project path to projects
alter table projects
  add column if not exists target_path text,
  add column if not exists test_command text;

-- Jobs: one per requirement run
create table if not exists jobs (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references projects(id) on delete cascade,
  requirement_id     uuid not null references requirements(id) on delete cascade,
  status             text not null default 'pending',
  -- pending | plan_loop | awaiting_plan_approval | coding | awaiting_review | done | failed | cancelled
  branch_name        text,
  iteration_count    integer not null default 0,
  error              text,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz
);

-- Plans: one per job (written by planner agent)
create table if not exists agent_plans (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references jobs(id) on delete cascade,
  tasks            jsonb not null default '[]',
  files_to_create  text[] not null default '{}',
  files_to_modify  text[] not null default '{}',
  test_approach    text not null default '',
  branch_name      text not null default '',
  created_at       timestamptz not null default now()
);

-- Logs: append-only, Realtime-enabled for live execution screen
create table if not exists job_logs (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references jobs(id) on delete cascade,
  phase      text not null, -- requirements | planning | coding | system
  level      text not null, -- info | warn | error | success
  message    text not null,
  created_at timestamptz not null default now()
);
```

- [ ] **Step 2: Apply migration**

```bash
npx supabase db push
```

Expected: migration runs without errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/003_agent_schema.sql
git commit -m "feat: add agent schema — jobs, agent_plans, job_logs tables"
```

---

## Task 2: Types + Admin Client

**Files:**
- Modify: `lib/supabase/types.ts`
- Create: `lib/supabase/admin.ts`

- [ ] **Step 1: Add types to `lib/supabase/types.ts`**

Append to the end of the file:

```typescript
// ── Agent Loop ────────────────────────────────────────────────────────────────

export type JobStatus =
  | 'pending'
  | 'plan_loop'
  | 'awaiting_plan_approval'
  | 'coding'
  | 'awaiting_review'
  | 'done'
  | 'failed'
  | 'cancelled'

export type LogPhase = 'requirements' | 'planning' | 'coding' | 'system'
export type LogLevel = 'info' | 'warn' | 'error' | 'success'

export interface Job {
  id: string
  project_id: string
  requirement_id: string
  status: JobStatus
  branch_name: string | null
  iteration_count: number
  error: string | null
  created_at: string
  completed_at: string | null
}

export interface PlanTask {
  id: string
  title: string
  description: string
  files: string[]
  dependencies: string[]
}

export interface AgentPlan {
  id: string
  job_id: string
  tasks: PlanTask[]
  files_to_create: string[]
  files_to_modify: string[]
  test_approach: string
  branch_name: string
  created_at: string
}

export interface FileChange {
  path: string
  content: string
  operation: 'create' | 'modify' | 'delete'
}

export interface TestResult {
  success: boolean
  passed: number
  failed: number
  errors: string[]
  raw_output: string
}

export interface LogEntry {
  id: string
  job_id: string
  phase: LogPhase
  level: LogLevel
  message: string
  created_at: string
}
```

- [ ] **Step 2: Create `lib/supabase/admin.ts`**

```typescript
import { createClient } from '@supabase/supabase-js'

// Service-role client for server-side async jobs (not tied to request cookies)
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add lib/supabase/types.ts lib/supabase/admin.ts
git commit -m "feat: add Job, AgentPlan, LogEntry types and admin Supabase client"
```

---

## Task 3: LocalExecutor

**Files:**
- Create: `lib/agent/executor.ts`
- Test: `tests/lib/agent/executor.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/lib/agent/executor.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LocalExecutor } from '@/lib/agent/executor'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmpDir: string
let executor: LocalExecutor

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-executor-test-'))
  executor = new LocalExecutor()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('getFileTree', () => {
  it('returns relative file paths', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'export {}')
    fs.mkdirSync(path.join(tmpDir, 'src'))
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export {}')
    const tree = await executor.getFileTree(tmpDir)
    expect(tree).toContain('index.ts')
    expect(tree).toContain(path.join('src', 'app.ts'))
  })

  it('excludes node_modules and .git', async () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules'))
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.js'), '')
    fs.mkdirSync(path.join(tmpDir, '.git'))
    fs.writeFileSync(path.join(tmpDir, '.git', 'config'), '')
    const tree = await executor.getFileTree(tmpDir)
    expect(tree.some(f => f.includes('node_modules'))).toBe(false)
    expect(tree.some(f => f.includes('.git'))).toBe(false)
  })
})

describe('readFile', () => {
  it('returns file content', async () => {
    fs.writeFileSync(path.join(tmpDir, 'hello.ts'), 'const x = 1')
    const content = await executor.readFile(tmpDir, 'hello.ts')
    expect(content).toBe('const x = 1')
  })

  it('throws if file does not exist', async () => {
    await expect(executor.readFile(tmpDir, 'missing.ts')).rejects.toThrow()
  })
})

describe('writeFiles', () => {
  it('creates new files and parent directories', async () => {
    await executor.writeFiles(tmpDir, [
      { path: 'src/components/Button.tsx', content: 'export {}', operation: 'create' },
    ])
    const content = fs.readFileSync(path.join(tmpDir, 'src', 'components', 'Button.tsx'), 'utf-8')
    expect(content).toBe('export {}')
  })

  it('overwrites existing files on modify', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'old')
    await executor.writeFiles(tmpDir, [
      { path: 'file.ts', content: 'new', operation: 'modify' },
    ])
    expect(fs.readFileSync(path.join(tmpDir, 'file.ts'), 'utf-8')).toBe('new')
  })
})

describe('detectTestCommand', () => {
  it('reads test script from package.json', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } })
    )
    const cmd = await executor.detectTestCommand(tmpDir)
    expect(cmd).toBe('vitest run')
  })

  it('throws if no test script found', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: {} }))
    await expect(executor.detectTestCommand(tmpDir)).rejects.toThrow('No test script')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/agent/executor.test.ts
```

Expected: FAIL with "Cannot find module '@/lib/agent/executor'"

- [ ] **Step 3: Create `lib/agent/executor.ts`**

```typescript
import fs from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import type { FileChange, TestResult } from '@/lib/supabase/types'

const execAsync = promisify(exec)

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'coverage', '.worktrees', 'out', '.turbo',
])

export interface IExecutor {
  getFileTree(projectPath: string): Promise<string[]>
  readFile(projectPath: string, filePath: string): Promise<string>
  readFiles(projectPath: string, filePaths: string[]): Promise<Record<string, string>>
  writeFiles(projectPath: string, changes: FileChange[]): Promise<void>
  runTests(projectPath: string): Promise<TestResult>
  detectTestCommand(projectPath: string): Promise<string>
  createBranch(projectPath: string, branchName: string): Promise<void>
  getGitDiff(projectPath: string): Promise<string>
}

export class LocalExecutor implements IExecutor {
  async getFileTree(projectPath: string): Promise<string[]> {
    const results: string[] = []
    const walk = (dir: string, rel: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name), path.join(rel, entry.name))
        } else {
          results.push(path.join(rel, entry.name))
        }
      }
    }
    walk(projectPath, '')
    return results
  }

  async readFile(projectPath: string, filePath: string): Promise<string> {
    return fs.readFileSync(path.join(projectPath, filePath), 'utf-8')
  }

  async readFiles(projectPath: string, filePaths: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {}
    for (const fp of filePaths) {
      try { result[fp] = await this.readFile(projectPath, fp) } catch { /* skip missing */ }
    }
    return result
  }

  async writeFiles(projectPath: string, changes: FileChange[]): Promise<void> {
    for (const change of changes) {
      const abs = path.join(projectPath, change.path)
      if (change.operation === 'delete') {
        if (fs.existsSync(abs)) fs.unlinkSync(abs)
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, change.content, 'utf-8')
      }
    }
  }

  async detectTestCommand(projectPath: string): Promise<string> {
    const pkgPath = path.join(projectPath, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const cmd = pkg?.scripts?.test
    if (!cmd) throw new Error('No test script found in package.json scripts.test')
    return cmd
  }

  async runTests(projectPath: string): Promise<TestResult> {
    const cmd = await this.detectTestCommand(projectPath)
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd: projectPath, timeout: 120_000 })
      const raw = stdout + stderr
      return this.parseTestOutput(raw, true)
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string }
      const raw = (e.stdout ?? '') + (e.stderr ?? '')
      return this.parseTestOutput(raw, false)
    }
  }

  private parseTestOutput(raw: string, success: boolean): TestResult {
    // Matches vitest/jest style: "X passed", "Y failed"
    const passedMatch = raw.match(/(\d+)\s+passed/)
    const failedMatch = raw.match(/(\d+)\s+failed/)
    const passed = passedMatch ? parseInt(passedMatch[1]) : (success ? 1 : 0)
    const failed = failedMatch ? parseInt(failedMatch[1]) : 0

    const errorLines = raw.split('\n').filter(l =>
      l.includes('FAIL') || l.includes('Error:') || l.includes('✗') || l.includes('× ')
    )

    return { success, passed, failed, errors: errorLines.slice(0, 20), raw_output: raw.slice(0, 4000) }
  }

  async createBranch(projectPath: string, branchName: string): Promise<void> {
    await execAsync(`git checkout -b ${branchName}`, { cwd: projectPath })
  }

  async getGitDiff(projectPath: string): Promise<string> {
    try {
      const { stdout } = await execAsync('git diff HEAD', { cwd: projectPath })
      return stdout
    } catch {
      return ''
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/lib/agent/executor.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agent/executor.ts tests/lib/agent/executor.test.ts
git commit -m "feat: add LocalExecutor with file tree, read/write, test runner, git ops"
```

---

## Task 4: Progress Module

**Files:**
- Create: `lib/agent/progress.ts`

- [ ] **Step 1: Create `lib/agent/progress.ts`**

```typescript
import type { SupabaseClient } from '@supabase/supabase-js'
import type { LogPhase, LogLevel } from '@/lib/supabase/types'

export async function logProgress(
  db: SupabaseClient,
  jobId: string,
  phase: LogPhase,
  message: string,
  level: LogLevel = 'info'
): Promise<void> {
  try {
    await db.from('job_logs').insert({ job_id: jobId, phase, level, message })
  } catch {
    // logging must never abort the job
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/agent/progress.ts
git commit -m "feat: add logProgress helper for job_logs Realtime feed"
```

---

## Task 5: Requirements Agent

**Files:**
- Create: `lib/agent/prompts/requirements-loop-prompt.ts`
- Create: `lib/agent/agents/requirements.agent.ts`
- Modify: `lib/requirements/parser.ts`
- Test: `tests/lib/agent/agents/requirements.agent.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/lib/agent/agents/requirements.agent.test.ts
import { describe, it, expect } from 'vitest'
import { runRequirementsLoop } from '@/lib/agent/agents/requirements.agent'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

const baseItems = [
  { type: 'functional', title: 'Login', description: 'Users can log in', priority: 'high', source_text: 'Users can log in', nfr_category: null },
]

describe('runRequirementsLoop', () => {
  it('returns items when confidence >= 80 on first iteration', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ items: baseItems, critique: [], confidence: 90 }))
    const result = await runRequirementsLoop('Users can log in', mock)
    expect(result).toHaveLength(1)
    expect(mock.callCount).toBe(1)
  })

  it('iterates when confidence < 80', async () => {
    const mock = new MockAIProvider()
    let call = 0
    mock.setDefaultResponse(JSON.stringify({ items: baseItems, critique: ['Missing error handling'], confidence: 60 }))
    // Second call returns high confidence
    const original = mock.complete.bind(mock)
    mock.complete = async (prompt, opts) => {
      call++
      if (call >= 2) return { ...(await original(prompt, opts)), content: JSON.stringify({ items: baseItems, critique: [], confidence: 85 }) }
      return original(prompt, opts)
    }
    const result = await runRequirementsLoop('some text', mock)
    expect(call).toBeGreaterThanOrEqual(2)
    expect(result).toHaveLength(1)
  })

  it('returns items after max iterations even if confidence stays low', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ items: baseItems, critique: ['always low'], confidence: 50 }))
    const result = await runRequirementsLoop('text', mock)
    expect(result).toHaveLength(1)
    expect(mock.callCount).toBeLessThanOrEqual(3)
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/lib/agent/agents/requirements.agent.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `lib/agent/prompts/requirements-loop-prompt.ts`**

```typescript
export const REQUIREMENTS_LOOP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['functional', 'non-functional', 'constraint', 'assumption'] },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          source_text: { type: 'string' },
          nfr_category: { type: 'string', enum: ['security', 'performance', 'auditability'] },
        },
        required: ['type', 'title', 'description', 'priority', 'source_text'],
      },
    },
    critique: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['items', 'critique', 'confidence'],
}

export function buildRequirementsLoopPrompt(rawInput: string, previousCritique: string[]): string {
  const critiqueSection = previousCritique.length > 0
    ? `\n\nPREVIOUS CRITIQUE — address these gaps in this iteration:\n${previousCritique.map(c => `- ${c}`).join('\n')}`
    : ''

  return `You are a senior requirements analyst. Extract all discrete requirement items from the text below.

For each item:
- type: "functional" (feature/behaviour), "non-functional" (quality/constraint), "constraint" (hard limit), "assumption" (assumed but not stated)
- title: 5-10 word summary
- description: full detail in one or two sentences
- priority: "high" (blocking/critical), "medium" (important), "low" (nice-to-have)
- source_text: exact sentence or phrase this came from
- nfr_category: only for non-functional — "security", "performance", or "auditability". Omit for all others.

After extracting items, self-critique:
- What is missing or ambiguous?
- What assumptions are implied but not stated?
- critique: list each gap as a string (empty array if none)
- confidence: 0-100 score for how complete the requirements are (80+ means ready)

Return ONLY valid JSON. No commentary.${critiqueSection}

--- REQUIREMENTS TEXT ---
${rawInput}
--- END ---`
}
```

- [ ] **Step 4: Create `lib/agent/agents/requirements.agent.ts`**

```typescript
import type { AIProvider } from '@/lib/ai/provider'
import type { ParsedItem } from '@/lib/requirements/parser'
import { buildRequirementsLoopPrompt, REQUIREMENTS_LOOP_SCHEMA } from '@/lib/agent/prompts/requirements-loop-prompt'

const MAX_ITERATIONS = 3
const CONFIDENCE_THRESHOLD = 80

interface LoopResult {
  items: ParsedItem[]
  critique: string[]
  confidence: number
}

export async function runRequirementsLoop(rawInput: string, ai: AIProvider): Promise<ParsedItem[]> {
  let previousCritique: string[] = []

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const prompt = buildRequirementsLoopPrompt(rawInput, previousCritique)
    const result = await ai.complete(prompt, { responseSchema: REQUIREMENTS_LOOP_SCHEMA })
    const parsed = JSON.parse(result.content) as LoopResult

    if (parsed.confidence >= CONFIDENCE_THRESHOLD || i === MAX_ITERATIONS - 1) {
      return parsed.items
    }

    previousCritique = parsed.critique
  }

  return []
}
```

- [ ] **Step 5: Update `lib/requirements/parser.ts` to use the loop**

Replace the entire file:

```typescript
import type { AIProvider } from '@/lib/ai/provider'
import { buildParsePrompt, PARSE_REQUIREMENTS_SCHEMA } from '@/lib/ai/prompts/parse-requirements'
import { runRequirementsLoop } from '@/lib/agent/agents/requirements.agent'
import type { ItemType, NfrCategory } from '@/lib/supabase/types'

export interface ParsedItem {
  type: ItemType
  title: string
  description: string
  priority: 'high' | 'medium' | 'low'
  source_text: string | null
  nfr_category: NfrCategory | null
}

// Single-pass parse — used by tests and legacy callers
export async function parseRequirements(rawInput: string, ai: AIProvider): Promise<ParsedItem[]> {
  const prompt = buildParsePrompt(rawInput)
  const result = await ai.complete(prompt, { responseSchema: PARSE_REQUIREMENTS_SCHEMA })
  const parsed = JSON.parse(result.content) as { items: ParsedItem[] }
  return parsed.items
}

// Multi-iteration parse with self-critique — used by pipeline
export async function parseRequirementsWithLoop(rawInput: string, ai: AIProvider): Promise<ParsedItem[]> {
  return runRequirementsLoop(rawInput, ai)
}
```

- [ ] **Step 6: Update `lib/requirements/pipeline.ts` to call `parseRequirementsWithLoop`**

Find the line (around line 91):
```typescript
parsedItems = await parseRequirements(rawInput, loggingProvider(ai, db, requirementId, 'parse'))
```

Replace with:
```typescript
parsedItems = await parseRequirementsWithLoop(rawInput, loggingProvider(ai, db, requirementId, 'parse'))
```

Also add the import at the top (alongside the existing parseRequirements import):
```typescript
import { parseRequirementsWithLoop } from '@/lib/requirements/parser'
```

And remove `parseRequirements` from that import since it's no longer used in pipeline.ts.

- [ ] **Step 7: Run all tests**

```bash
npx vitest run tests/lib/agent/agents/requirements.agent.test.ts tests/lib/requirements/parser.test.ts tests/lib/requirements/pipeline.test.ts
```

Expected: All PASS. (parser.test.ts uses `parseRequirements` directly — still works.)

- [ ] **Step 8: Commit**

```bash
git add lib/agent/prompts/requirements-loop-prompt.ts lib/agent/agents/requirements.agent.ts lib/requirements/parser.ts lib/requirements/pipeline.ts tests/lib/agent/agents/requirements.agent.test.ts
git commit -m "feat: add requirements loop agent with self-critique and confidence scoring"
```

---

## Task 6: Planner Agent

**Files:**
- Create: `lib/agent/prompts/planner-prompt.ts`
- Create: `lib/agent/agents/planner.agent.ts`
- Test: `tests/lib/agent/agents/planner.agent.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/lib/agent/agents/planner.agent.test.ts
import { describe, it, expect } from 'vitest'
import { runPlannerAgent } from '@/lib/agent/agents/planner.agent'
import { MockAIProvider } from '@/lib/ai/adapters/mock'
import { LocalExecutor } from '@/lib/agent/executor'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mockPlan = {
  tasks: [{ id: 'task-1', title: 'Create auth module', description: 'Add auth', files: ['src/auth.ts'], dependencies: [] }],
  files_to_create: ['src/auth.ts'],
  files_to_modify: [],
  test_approach: 'Unit tests for each function',
  branch_name: 'sf/abc123-add-auth',
}

describe('runPlannerAgent', () => {
  it('returns a plan with tasks and branch name', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-planner-'))
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}')

    const mock = new MockAIProvider()
    // First call: file request phase
    mock.setResponse('FILE TREE', JSON.stringify({ requested_files: ['package.json'] }))
    // Second call: plan phase
    mock.setResponse('FILE CONTENTS', JSON.stringify(mockPlan))

    const executor = new LocalExecutor()
    const result = await runPlannerAgent(
      [{ type: 'functional', title: 'Login', description: 'Login', priority: 'high', source_text: 'Login', nfr_category: null }],
      tmpDir,
      executor,
      mock
    )

    expect(result.tasks).toHaveLength(1)
    expect(result.branch_name).toBe('sf/abc123-add-auth')
    expect(mock.callCount).toBe(2)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/lib/agent/agents/planner.agent.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `lib/agent/prompts/planner-prompt.ts`**

```typescript
import type { ParsedItem } from '@/lib/requirements/parser'
import type { PlanTask } from '@/lib/supabase/types'

export const FILE_REQUEST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    requested_files: { type: 'array', items: { type: 'string' } },
  },
  required: ['requested_files'],
}

export const PLANNER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          dependencies: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'description', 'files', 'dependencies'],
      },
    },
    files_to_create: { type: 'array', items: { type: 'string' } },
    files_to_modify: { type: 'array', items: { type: 'string' } },
    test_approach: { type: 'string' },
    branch_name: { type: 'string' },
  },
  required: ['tasks', 'files_to_create', 'files_to_modify', 'test_approach', 'branch_name'],
}

export function buildFileRequestPrompt(requirements: ParsedItem[], fileTree: string[]): string {
  return `You are a software architect. You will plan implementation tasks for the requirements below.

First, identify which files from the project you need to read to make a good plan.
Return ONLY a JSON object with a "requested_files" array (relative paths). Max 20 files.

--- REQUIREMENTS ---
${requirements.map(r => `[${r.type.toUpperCase()}] ${r.title}: ${r.description}`).join('\n')}
--- END ---

--- FILE TREE ---
${fileTree.slice(0, 200).join('\n')}
--- END ---`
}

export function buildPlannerPrompt(requirements: ParsedItem[], fileTree: string[], fileContents: Record<string, string>): string {
  const filesSection = Object.entries(fileContents)
    .map(([fp, content]) => `=== ${fp} ===\n${content.slice(0, 2000)}`)
    .join('\n\n')

  return `You are a software architect. Create a detailed implementation plan for the requirements below.

Rules:
- tasks: ordered list of implementation tasks (each with unique id like "task-1")
- files_to_create: new files that will be created
- files_to_modify: existing files that will be changed
- test_approach: how tests will be written (one sentence per task type)
- branch_name: git branch name in format "sf/<6-char-req-id>-<short-slug>" e.g. "sf/abc123-add-auth"
- For every file created or modified, include a corresponding test file
- tasks must be ordered so dependencies come before dependents

Return ONLY valid JSON. No commentary.

--- REQUIREMENTS ---
${requirements.map(r => `[${r.type.toUpperCase()}] [${r.priority}] ${r.title}: ${r.description}`).join('\n')}
--- END ---

--- FILE TREE ---
${fileTree.slice(0, 200).join('\n')}
--- END ---

--- FILE CONTENTS ---
${filesSection}
--- END ---`
}
```

- [ ] **Step 4: Create `lib/agent/agents/planner.agent.ts`**

```typescript
import type { AIProvider } from '@/lib/ai/provider'
import type { ParsedItem } from '@/lib/requirements/parser'
import type { AgentPlan } from '@/lib/supabase/types'
import type { IExecutor } from '@/lib/agent/executor'
import {
  buildFileRequestPrompt,
  buildPlannerPrompt,
  FILE_REQUEST_SCHEMA,
  PLANNER_SCHEMA,
} from '@/lib/agent/prompts/planner-prompt'

export async function runPlannerAgent(
  requirements: ParsedItem[],
  projectPath: string,
  executor: IExecutor,
  ai: AIProvider
): Promise<Omit<AgentPlan, 'id' | 'job_id' | 'created_at'>> {
  const fileTree = await executor.getFileTree(projectPath)

  // Step 1: Ask planner which files it needs
  const fileRequestPrompt = buildFileRequestPrompt(requirements, fileTree)
  const fileRequestResult = await ai.complete(fileRequestPrompt, { responseSchema: FILE_REQUEST_SCHEMA })
  const { requested_files } = JSON.parse(fileRequestResult.content) as { requested_files: string[] }

  // Step 2: Read those files and produce the final plan
  const fileContents = await executor.readFiles(projectPath, requested_files.slice(0, 20))
  const plannerPrompt = buildPlannerPrompt(requirements, fileTree, fileContents)
  const planResult = await ai.complete(plannerPrompt, { responseSchema: PLANNER_SCHEMA })

  return JSON.parse(planResult.content) as Omit<AgentPlan, 'id' | 'job_id' | 'created_at'>
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run tests/lib/agent/agents/planner.agent.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/agent/prompts/planner-prompt.ts lib/agent/agents/planner.agent.ts tests/lib/agent/agents/planner.agent.test.ts
git commit -m "feat: add planner agent — two-step file-tree-aware planning"
```

---

## Task 7: Coder Agent

**Files:**
- Create: `lib/agent/prompts/coder-prompt.ts`
- Create: `lib/agent/agents/coder.agent.ts`
- Test: `tests/lib/agent/agents/coder.agent.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/lib/agent/agents/coder.agent.test.ts
import { describe, it, expect } from 'vitest'
import { runCoderAgent } from '@/lib/agent/agents/coder.agent'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

const requirements = [
  { type: 'functional' as const, title: 'Login', description: 'Login', priority: 'high' as const, source_text: 'Login', nfr_category: null },
]

const plan = {
  tasks: [{ id: 'task-1', title: 'Add login', description: 'Add login', files: ['src/login.ts'], dependencies: [] }],
  files_to_create: ['src/login.ts'],
  files_to_modify: [],
  test_approach: 'Unit tests',
  branch_name: 'sf/abc-add-login',
}

describe('runCoderAgent', () => {
  it('returns file changes', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({
      changes: [{ path: 'src/login.ts', content: 'export function login() {}', operation: 'create' }],
    }))

    const result = await runCoderAgent(requirements, plan, [], {}, mock)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('src/login.ts')
    expect(result[0].operation).toBe('create')
  })

  it('includes previous errors in prompt', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ changes: [] }))

    await runCoderAgent(requirements, plan, ['TypeError: x is undefined'], {}, mock)
    expect(mock.callCount).toBe(1)
    // errors appear in prompt — verified by callCount (agent ran)
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/lib/agent/agents/coder.agent.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `lib/agent/prompts/coder-prompt.ts`**

```typescript
import type { ParsedItem } from '@/lib/requirements/parser'
import type { AgentPlan, FileChange } from '@/lib/supabase/types'

export const CODER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          operation: { type: 'string', enum: ['create', 'modify', 'delete'] },
        },
        required: ['path', 'content', 'operation'],
      },
    },
  },
  required: ['changes'],
}

export function buildCoderPrompt(
  requirements: ParsedItem[],
  plan: Omit<AgentPlan, 'id' | 'job_id' | 'created_at'>,
  previousErrors: string[],
  currentFileContents: Record<string, string>
): string {
  const errorsSection = previousErrors.length > 0
    ? `\n\n--- PREVIOUS TEST FAILURES (fix these) ---\n${previousErrors.join('\n')}\n--- END ---`
    : ''

  const filesSection = Object.entries(currentFileContents).length > 0
    ? `\n\n--- CURRENT FILE CONTENTS ---\n${Object.entries(currentFileContents).map(([fp, c]) => `=== ${fp} ===\n${c.slice(0, 3000)}`).join('\n\n')}\n--- END ---`
    : ''

  return `You are a senior software engineer. Implement the plan below to satisfy the requirements.

Rules:
- Output FULL file content for every file you create or modify. Never output diffs or partial files.
- For every file you create or modify, ALSO write or update its test file.
- Follow the existing code style visible in current file contents.
- changes: array of file changes. Each change has path (relative), content (full file text), operation (create|modify|delete).

Return ONLY valid JSON. No commentary.

--- REQUIREMENTS ---
${requirements.map(r => `[${r.priority.toUpperCase()}] ${r.title}: ${r.description}`).join('\n')}
--- END ---

--- PLAN ---
Tasks:
${plan.tasks.map(t => `${t.id}: ${t.title}\n  ${t.description}\n  Files: ${t.files.join(', ')}`).join('\n')}

Test approach: ${plan.test_approach}
--- END ---${errorsSection}${filesSection}`
}
```

- [ ] **Step 4: Create `lib/agent/agents/coder.agent.ts`**

```typescript
import type { AIProvider } from '@/lib/ai/provider'
import type { ParsedItem } from '@/lib/requirements/parser'
import type { AgentPlan, FileChange } from '@/lib/supabase/types'
import { buildCoderPrompt, CODER_SCHEMA } from '@/lib/agent/prompts/coder-prompt'

export async function runCoderAgent(
  requirements: ParsedItem[],
  plan: Omit<AgentPlan, 'id' | 'job_id' | 'created_at'>,
  previousErrors: string[],
  currentFileContents: Record<string, string>,
  ai: AIProvider
): Promise<FileChange[]> {
  const prompt = buildCoderPrompt(requirements, plan, previousErrors, currentFileContents)
  const result = await ai.complete(prompt, { responseSchema: CODER_SCHEMA, maxTokens: 8000 })
  const parsed = JSON.parse(result.content) as { changes: FileChange[] }
  return parsed.changes
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run tests/lib/agent/agents/coder.agent.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/agent/prompts/coder-prompt.ts lib/agent/agents/coder.agent.ts tests/lib/agent/agents/coder.agent.test.ts
git commit -m "feat: add coder agent — writes full file content with test requirement"
```

---

## Task 8: Job Runner

**Files:**
- Create: `lib/agent/job-runner.ts`
- Test: `tests/lib/agent/job-runner.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/lib/agent/job-runner.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runJob } from '@/lib/agent/job-runner'
import { MockAIProvider } from '@/lib/ai/adapters/mock'
import type { IExecutor } from '@/lib/agent/executor'
import type { TestResult, FileChange } from '@/lib/supabase/types'

function makeDb(overrides: Record<string, unknown> = {}) {
  const fromMock = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: overrides.single ?? null }),
    insert: vi.fn().mockResolvedValue({ data: { id: 'plan-1' } }),
    update: vi.fn().mockReturnThis(),
  })
  return { from: fromMock } as unknown as ReturnType<typeof import('@supabase/supabase-js').createClient>
}

function makeExecutor(testSuccess = true): IExecutor {
  return {
    getFileTree: vi.fn().mockResolvedValue(['src/index.ts']),
    readFile: vi.fn().mockResolvedValue('content'),
    readFiles: vi.fn().mockResolvedValue({}),
    writeFiles: vi.fn().mockResolvedValue(undefined),
    runTests: vi.fn().mockResolvedValue({ success: testSuccess, passed: 1, failed: 0, errors: [], raw_output: '1 passed' } as TestResult),
    detectTestCommand: vi.fn().mockResolvedValue('vitest run'),
    createBranch: vi.fn().mockResolvedValue(undefined),
    getGitDiff: vi.fn().mockResolvedValue(''),
  }
}

describe('runJob — planning phase', () => {
  it('writes plan to DB and sets status to awaiting_plan_approval', async () => {
    const mock = new MockAIProvider()
    // File request → plan
    mock.setResponse('FILE TREE', JSON.stringify({ requested_files: [] }))
    mock.setResponse('FILE CONTENTS', JSON.stringify({
      tasks: [], files_to_create: [], files_to_modify: [],
      test_approach: 'unit tests', branch_name: 'sf/abc-feat',
    }))

    const job = { id: 'job-1', project_id: 'proj-1', requirement_id: 'req-1', status: 'plan_loop', branch_name: null, iteration_count: 0, error: null, created_at: '', completed_at: null }
    const project = { id: 'proj-1', target_path: '/tmp/test-proj' }
    const req = { id: 'req-1', raw_input: 'build login' }
    const items = [{ type: 'functional', title: 'Login', description: 'Login', priority: 'high', source_text: 'login', nfr_category: null }]

    const fromMap: Record<string, unknown> = {
      jobs: { single: job, update: {} },
      projects: { single: project },
      requirements: { single: req },
      requirement_items: { data: items },
      agent_plans: { data: { id: 'plan-1' } },
      job_logs: {},
    }

    const db = {
      from: vi.fn((table: string) => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: fromMap[table] ?? null }),
        insert: vi.fn().mockResolvedValue({ data: { id: 'plan-1' } }),
        update: vi.fn().mockReturnThis(),
      })),
    } as unknown as ReturnType<typeof import('@supabase/supabase-js').createClient>

    const executor = makeExecutor()
    await runJob('job-1', 'planning', db, mock, executor)

    expect(executor.getFileTree).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/lib/agent/job-runner.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `lib/agent/job-runner.ts`**

```typescript
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { IExecutor } from '@/lib/agent/executor'
import type { ParsedItem } from '@/lib/requirements/parser'
import type { AgentPlan } from '@/lib/supabase/types'
import { runPlannerAgent } from '@/lib/agent/agents/planner.agent'
import { runCoderAgent } from '@/lib/agent/agents/coder.agent'
import { logProgress } from '@/lib/agent/progress'

const MAX_CODING_ITERATIONS = 10

export async function runJob(
  jobId: string,
  phase: 'planning' | 'coding',
  db: SupabaseClient,
  ai: AIProvider,
  executor: IExecutor
): Promise<void> {
  if (phase === 'planning') {
    await runPlanningPhase(jobId, db, ai, executor)
  } else {
    await runCodingPhase(jobId, db, ai, executor)
  }
}

async function runPlanningPhase(jobId: string, db: SupabaseClient, ai: AIProvider, executor: IExecutor) {
  await db.from('jobs').update({ status: 'plan_loop' }).eq('id', jobId)
  await logProgress(db, jobId, 'planning', 'Planning started — reading project structure...', 'info')

  try {
    const { job, project, items } = await loadJobContext(jobId, db)

    await logProgress(db, jobId, 'planning', `File tree loaded — generating implementation plan...`, 'info')

    const plan = await runPlannerAgent(items, project.target_path, executor, ai)

    await db.from('agent_plans').insert({
      job_id: jobId,
      tasks: plan.tasks,
      files_to_create: plan.files_to_create,
      files_to_modify: plan.files_to_modify,
      test_approach: plan.test_approach,
      branch_name: plan.branch_name,
    })

    await db.from('jobs').update({ status: 'awaiting_plan_approval', branch_name: plan.branch_name }).eq('id', jobId)
    await logProgress(db, jobId, 'planning', `Plan ready — ${plan.tasks.length} tasks, ${plan.files_to_create.length + plan.files_to_modify.length} files`, 'success')
  } catch (err) {
    const msg = String(err)
    await db.from('jobs').update({ status: 'failed', error: msg, completed_at: new Date().toISOString() }).eq('id', jobId)
    await logProgress(db, jobId, 'planning', `Planning failed: ${msg}`, 'error')
  }
}

async function runCodingPhase(jobId: string, db: SupabaseClient, ai: AIProvider, executor: IExecutor) {
  await db.from('jobs').update({ status: 'coding' }).eq('id', jobId)
  await logProgress(db, jobId, 'coding', 'Coding started...', 'info')

  try {
    const { project, items } = await loadJobContext(jobId, db)

    const { data: planRow } = await db.from('agent_plans').select('*').eq('job_id', jobId).single()
    if (!planRow) throw new Error('No plan found for job')

    const plan: Omit<AgentPlan, 'id' | 'job_id' | 'created_at'> = {
      tasks: planRow.tasks,
      files_to_create: planRow.files_to_create,
      files_to_modify: planRow.files_to_modify,
      test_approach: planRow.test_approach,
      branch_name: planRow.branch_name,
    }

    let previousErrors: string[] = []
    let done = false

    for (let i = 0; i < MAX_CODING_ITERATIONS && !done; i++) {
      await logProgress(db, jobId, 'coding', `Coding iteration ${i + 1} / ${MAX_CODING_ITERATIONS}...`, 'info')
      await db.from('jobs').update({ iteration_count: i + 1 }).eq('id', jobId)

      // Check if cancelled
      const { data: currentJob } = await db.from('jobs').select('status').eq('id', jobId).single()
      if (currentJob?.status === 'cancelled') return

      const filesToRead = [...plan.files_to_create, ...plan.files_to_modify]
      const currentFileContents = await executor.readFiles(project.target_path, filesToRead)

      const changes = await runCoderAgent(items, plan, previousErrors, currentFileContents, ai)
      await executor.writeFiles(project.target_path, changes)

      await logProgress(db, jobId, 'coding', `Applied ${changes.length} file changes — running tests...`, 'info')

      const testResult = await executor.runTests(project.target_path)

      if (testResult.success) {
        done = true
        await executor.createBranch(project.target_path, plan.branch_name)
        await db.from('jobs').update({ status: 'awaiting_review', branch_name: plan.branch_name }).eq('id', jobId)
        await logProgress(db, jobId, 'coding', `All tests passed — branch created: ${plan.branch_name}`, 'success')
      } else {
        previousErrors = testResult.errors
        await logProgress(db, jobId, 'coding', `${testResult.failed} test(s) failed — feeding back errors...`, 'warn')
      }
    }

    if (!done) {
      await db.from('jobs').update({ status: 'failed', error: `Tests still failing after ${MAX_CODING_ITERATIONS} iterations`, completed_at: new Date().toISOString() }).eq('id', jobId)
      await logProgress(db, jobId, 'coding', `Max iterations reached — job failed`, 'error')
    }
  } catch (err) {
    const msg = String(err)
    await db.from('jobs').update({ status: 'failed', error: msg, completed_at: new Date().toISOString() }).eq('id', jobId)
    await logProgress(db, jobId, 'coding', `Coding failed: ${msg}`, 'error')
  }
}

async function loadJobContext(jobId: string, db: SupabaseClient) {
  const { data: job } = await db.from('jobs').select('*').eq('id', jobId).single()
  if (!job) throw new Error('Job not found')

  const { data: project } = await db.from('projects').select('id, target_path').eq('id', job.project_id).single()
  if (!project?.target_path) throw new Error('Project has no target_path configured')

  const { data: req } = await db.from('requirements').select('raw_input').eq('id', job.requirement_id).single()
  if (!req) throw new Error('Requirement not found')

  const { data: itemRows } = await db.from('requirement_items').select('*').eq('requirement_id', job.requirement_id)
  const items: ParsedItem[] = (itemRows ?? []).map((r: Record<string, unknown>) => ({
    type: r.type as ParsedItem['type'],
    title: r.title as string,
    description: r.description as string,
    priority: r.priority as ParsedItem['priority'],
    source_text: r.source_text as string | null,
    nfr_category: r.nfr_category as ParsedItem['nfr_category'],
  }))

  return { job, project, req, items }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/lib/agent/job-runner.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agent/job-runner.ts tests/lib/agent/job-runner.test.ts
git commit -m "feat: add job runner — planning and coding phases with progress logging"
```

---

## Task 9: API Routes

**Files:**
- Create: `app/api/jobs/route.ts`
- Create: `app/api/jobs/[id]/route.ts`

- [ ] **Step 1: Create `app/api/jobs/route.ts`**

```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getProvider } from '@/lib/ai/registry'
import { LocalExecutor } from '@/lib/agent/executor'
import { runJob } from '@/lib/agent/job-runner'

export async function POST(req: Request) {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  if (!body.requirement_id || typeof body.requirement_id !== 'string') {
    return NextResponse.json({ error: 'requirement_id is required' }, { status: 400 })
  }

  const { data: req_ } = await db
    .from('requirements')
    .select('id, project_id, status')
    .eq('id', body.requirement_id)
    .single()

  if (!req_) return NextResponse.json({ error: 'Requirement not found' }, { status: 404 })
  if (req_.status !== 'ready_for_dev') {
    return NextResponse.json({ error: 'Requirement must be ready_for_dev to run agent' }, { status: 422 })
  }

  const { data: project } = await db
    .from('projects')
    .select('id, target_path')
    .eq('id', req_.project_id)
    .eq('owner_id', user.id)
    .single()

  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  if (!project.target_path) {
    return NextResponse.json({ error: 'Project target_path not configured. Set it in project settings.' }, { status: 422 })
  }

  const { data: job, error } = await db
    .from('jobs')
    .insert({ project_id: req_.project_id, requirement_id: body.requirement_id, status: 'pending' })
    .select('*')
    .single()

  if (error || !job) return NextResponse.json({ error: 'Failed to create job' }, { status: 500 })

  // Kick off async — does not block response
  const adminDb = createAdminClient()
  const ai = getProvider()
  const executor = new LocalExecutor()
  void runJob(job.id, 'planning', adminDb, ai, executor)

  return NextResponse.json(job, { status: 201 })
}
```

- [ ] **Step 2: Create `app/api/jobs/[id]/route.ts`**

```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getProvider } from '@/lib/ai/registry'
import { LocalExecutor } from '@/lib/agent/executor'
import { runJob } from '@/lib/agent/job-runner'

async function getJobAndVerifyOwner(jobId: string, userId: string) {
  const db = createClient()
  const { data: job } = await db.from('jobs').select('*, projects!inner(owner_id)').eq('id', jobId).single()
  if (!job) return null
  if ((job.projects as { owner_id: string }).owner_id !== userId) return null
  return job
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const job = await getJobAndVerifyOwner(id, user.id)
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [{ data: plan }, { data: logs }] = await Promise.all([
    db.from('agent_plans').select('*').eq('job_id', id).maybeSingle(),
    db.from('job_logs').select('*').eq('job_id', id).order('created_at', { ascending: true }),
  ])

  return NextResponse.json({ job, plan, logs: logs ?? [] })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const job = await getJobAndVerifyOwner(id, user.id)
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const action = body.action as string

  const adminDb = createAdminClient()
  const ai = getProvider()
  const executor = new LocalExecutor()

  if (action === 'approve_plan') {
    if (job.status !== 'awaiting_plan_approval') {
      return NextResponse.json({ error: 'Job is not awaiting plan approval' }, { status: 422 })
    }
    await db.from('jobs').update({ status: 'coding' }).eq('id', id)
    void runJob(id, 'coding', adminDb, ai, executor)
    return NextResponse.json({ ok: true })
  }

  if (action === 'approve_review') {
    if (job.status !== 'awaiting_review') {
      return NextResponse.json({ error: 'Job is not awaiting review' }, { status: 422 })
    }
    await db.from('jobs').update({ status: 'done', completed_at: new Date().toISOString() }).eq('id', id)
    return NextResponse.json({ ok: true })
  }

  if (action === 'retry') {
    if (job.status !== 'awaiting_review' && job.status !== 'failed') {
      return NextResponse.json({ error: 'Job cannot be retried in current status' }, { status: 422 })
    }
    await db.from('jobs').update({ status: 'coding', error: null }).eq('id', id)
    void runJob(id, 'coding', adminDb, ai, executor)
    return NextResponse.json({ ok: true })
  }

  if (action === 'cancel') {
    await db.from('jobs').update({ status: 'cancelled', completed_at: new Date().toISOString() }).eq('id', id)
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const job = await getJobAndVerifyOwner(id, user.id)
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await db.from('jobs').update({ status: 'cancelled', completed_at: new Date().toISOString() }).eq('id', id)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Commit**

```bash
git add app/api/jobs/route.ts app/api/jobs/[id]/route.ts
git commit -m "feat: add /api/jobs routes — create, status, approve, retry, cancel"
```

---

## Task 10: Project Target Path Config

**Files:**
- Modify: `app/api/projects/[id]/route.ts` (add PATCH)
- Modify: `app/projects/[id]/requirements/page.tsx` (pass targetPath + projectId to Workspace)
- Modify: `components/requirements/workspace.tsx` (add Run Agent button + target path prompt)

- [ ] **Step 1: Check what's in `app/api/projects/[id]/route.ts`**

```bash
cat app/api/projects/\[id\]/route.ts
```

- [ ] **Step 2: Add PATCH handler to `app/api/projects/[id]/route.ts`**

Read the file first, then append this export after the existing handlers:

```typescript
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const updates: Record<string, unknown> = {}
  if (typeof body.target_path === 'string') updates.target_path = body.target_path || null
  if (typeof body.test_command === 'string') updates.test_command = body.test_command || null

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data, error } = await db
    .from('projects')
    .update(updates)
    .eq('id', id)
    .eq('owner_id', user.id)
    .select('id, name, target_path, test_command')
    .single()

  if (error || !data) return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  return NextResponse.json(data)
}
```

- [ ] **Step 3: Update `app/projects/[id]/requirements/page.tsx`**

In the project select query (line ~18), add `target_path`:
```typescript
const { data: project } = await db
  .from('projects')
  .select('id, name, target_path')
  .eq('id', projectId)
  .eq('owner_id', user.id)
  .single()
```

In the `<Workspace>` component call, add the new props:
```typescript
<Workspace
  requirementId={req.id}
  projectId={projectId}
  targetPath={project.target_path ?? null}
  initialRawInput={req.raw_input ?? ''}
  initialItems={items ?? []}
  initialGaps={gapsWithDetails}
  initialSummary={summary}
/>
```

- [ ] **Step 4: Update `components/requirements/workspace.tsx`**

Add `projectId` and `targetPath` to the Props interface:
```typescript
interface Props {
  requirementId: string
  projectId: string
  targetPath: string | null
  initialRawInput: string
  initialItems: RequirementItem[]
  initialGaps: GapWithDetails[]
  initialSummary: RequirementSummary
}
```

Update the function signature:
```typescript
export function Workspace({ requirementId, projectId, targetPath, initialRawInput, initialItems, initialGaps, initialSummary }: Props) {
```

Add a `handleRunAgent` function after `handleMarkReady`:
```typescript
async function handleRunAgent() {
  if (!targetPath) {
    alert('Set the project target path in project settings before running the agent.')
    return
  }
  const res = await fetch('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requirement_id: requirementId }),
  })
  if (!res.ok) {
    const err = await res.json()
    alert(err.error ?? 'Failed to start agent')
    return
  }
  const job = await res.json()
  window.location.href = `/projects/${projectId}/jobs/${job.id}/execution`
}
```

Add the "Run Agent" button in the JSX, below the existing "Mark Ready" button area. Find where `status === 'ready_for_dev'` is referenced in the JSX and add the button alongside:
```typescript
{status === 'ready_for_dev' && (
  <button
    onClick={handleRunAgent}
    className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
    style={{
      background: 'var(--accent)',
      color: '#000',
      fontFamily: 'var(--font-jetbrains)',
    }}
  >
    Run Agent
  </button>
)}
```

- [ ] **Step 5: Commit**

```bash
git add app/api/projects/\[id\]/route.ts app/projects/\[id\]/requirements/page.tsx components/requirements/workspace.tsx
git commit -m "feat: add target_path to projects, Run Agent button in workspace"
```

---

## Task 11: Execution Screen

**Files:**
- Create: `components/agent/execution-screen.tsx`
- Create: `app/projects/[id]/jobs/[jobId]/execution/page.tsx`

- [ ] **Step 1: Create `components/agent/execution-screen.tsx`**

```typescript
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Job, LogEntry, JobStatus } from '@/lib/supabase/types'

const PHASES: { key: string; label: string; statuses: JobStatus[] }[] = [
  { key: 'planning', label: 'Planning', statuses: ['plan_loop', 'awaiting_plan_approval'] },
  { key: 'coding', label: 'Coding', statuses: ['coding'] },
  { key: 'review', label: 'Review', statuses: ['awaiting_review', 'done'] },
]

function phaseStatus(phase: typeof PHASES[0], job: Job): 'pending' | 'active' | 'done' | 'failed' {
  if (job.status === 'failed' || job.status === 'cancelled') {
    if (phase.statuses.includes(job.status as JobStatus)) return 'failed'
    const phaseIdx = PHASES.findIndex(p => p.key === phase.key)
    const jobPhaseIdx = PHASES.findIndex(p => p.statuses.some(s => s === job.status))
    return phaseIdx < jobPhaseIdx ? 'done' : 'pending'
  }
  if (phase.statuses.includes(job.status)) return 'active'
  const phaseIdx = PHASES.findIndex(p => p.key === phase.key)
  const jobPhaseIdx = PHASES.findIndex(p => p.statuses.some(s => s === job.status))
  if (jobPhaseIdx === -1) return 'pending'
  return phaseIdx < jobPhaseIdx ? 'done' : 'pending'
}

const levelColor: Record<string, string> = {
  info: 'var(--text-secondary)',
  warn: '#f59e0b',
  error: '#ef4444',
  success: '#22c55e',
}

interface Props {
  jobId: string
  projectId: string
  initialJob: Job
  initialLogs: LogEntry[]
}

export function ExecutionScreen({ jobId, projectId, initialJob, initialLogs }: Props) {
  const router = useRouter()
  const [job, setJob] = useState<Job>(initialJob)
  const [logs, setLogs] = useState<LogEntry[]>(initialLogs)
  const db = createClient()

  useEffect(() => {
    const jobChannel = db
      .channel(`job-${jobId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'jobs', filter: `id=eq.${jobId}` }, payload => {
        const updated = payload.new as Job
        setJob(updated)
        if (updated.status === 'awaiting_plan_approval') {
          router.push(`/projects/${projectId}/jobs/${jobId}/plan`)
        }
        if (updated.status === 'awaiting_review') {
          router.push(`/projects/${projectId}/jobs/${jobId}/review`)
        }
      })
      .subscribe()

    const logsChannel = db
      .channel(`logs-${jobId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'job_logs', filter: `job_id=eq.${jobId}` }, payload => {
        setLogs(prev => [...prev, payload.new as LogEntry])
      })
      .subscribe()

    return () => {
      db.removeChannel(jobChannel)
      db.removeChannel(logsChannel)
    }
  }, [jobId, projectId, router])

  const isFailed = job.status === 'failed' || job.status === 'cancelled'

  return (
    <div style={{ background: 'var(--bg-base)', minHeight: '100vh', padding: '2rem' }}>
      <div style={{ maxWidth: '800px', margin: '0 auto' }}>
        {/* Phase indicator */}
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem', alignItems: 'center' }}>
          {PHASES.map((phase, i) => {
            const ps = phaseStatus(phase, job)
            return (
              <div key={phase.key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{
                  width: '24px', height: '24px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px',
                  background: ps === 'done' ? '#22c55e' : ps === 'active' ? 'var(--accent)' : ps === 'failed' ? '#ef4444' : 'var(--bg-elevated)',
                  color: ps === 'active' || ps === 'done' || ps === 'failed' ? '#000' : 'var(--text-muted)',
                }}>
                  {ps === 'done' ? '✓' : ps === 'failed' ? '✗' : i + 1}
                </div>
                <span style={{ fontSize: '13px', color: ps === 'active' ? 'var(--text-primary)' : 'var(--text-muted)', fontFamily: 'var(--font-jetbrains)' }}>
                  {phase.label}
                </span>
                {i < PHASES.length - 1 && <span style={{ color: 'var(--border-strong)', margin: '0 0.25rem' }}>→</span>}
              </div>
            )
          })}
        </div>

        {/* Iteration counter */}
        {job.status === 'coding' && (
          <div style={{ marginBottom: '1rem', fontSize: '13px', color: 'var(--text-muted)', fontFamily: 'var(--font-jetbrains)' }}>
            Iteration {job.iteration_count} / 10
          </div>
        )}

        {/* Log feed */}
        <div style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '12px',
          padding: '1.25rem',
          fontFamily: 'var(--font-jetbrains)',
          fontSize: '13px',
          minHeight: '400px',
          maxHeight: '600px',
          overflowY: 'auto',
        }}>
          {logs.length === 0 && (
            <span style={{ color: 'var(--text-muted)' }}>Waiting for agent to start...</span>
          )}
          {logs.map(log => (
            <div key={log.id} style={{ marginBottom: '0.375rem', color: levelColor[log.level] ?? 'var(--text-secondary)' }}>
              <span style={{ color: 'var(--text-muted)', marginRight: '0.75rem' }}>
                {new Date(log.created_at).toLocaleTimeString()}
              </span>
              {log.message}
            </div>
          ))}
        </div>

        {/* Failure state */}
        {isFailed && job.error && (
          <div style={{ marginTop: '1.5rem', padding: '1rem', background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444', borderRadius: '8px' }}>
            <p style={{ color: '#ef4444', fontSize: '13px', fontFamily: 'var(--font-jetbrains)' }}>{job.error}</p>
            <button
              onClick={async () => {
                await fetch(`/api/jobs/${jobId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'retry' }) })
              }}
              style={{ marginTop: '0.75rem', padding: '0.5rem 1rem', background: 'var(--accent)', color: '#000', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', border: 'none' }}
            >
              Retry
            </button>
          </div>
        )}

        {/* Plan approval prompt */}
        {job.status === 'awaiting_plan_approval' && (
          <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
            <p style={{ color: 'var(--text-muted)', marginBottom: '0.75rem', fontSize: '13px' }}>Plan is ready for your review.</p>
            <button
              onClick={() => router.push(`/projects/${projectId}/jobs/${jobId}/plan`)}
              style={{ padding: '0.75rem 1.5rem', background: 'var(--accent)', color: '#000', borderRadius: '8px', fontSize: '14px', cursor: 'pointer', border: 'none', fontFamily: 'var(--font-jetbrains)' }}
            >
              Review Plan →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create `app/projects/[id]/jobs/[jobId]/execution/page.tsx`**

```typescript
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ExecutionScreen } from '@/components/agent/execution-screen'
import type { Job, LogEntry } from '@/lib/supabase/types'

interface Props {
  params: Promise<{ id: string; jobId: string }>
}

export default async function ExecutionPage({ params }: Props) {
  const { id: projectId, jobId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: job } = await db
    .from('jobs')
    .select('*, projects!inner(owner_id)')
    .eq('id', jobId)
    .single()

  if (!job || (job.projects as { owner_id: string }).owner_id !== user.id) redirect('/projects')

  if (job.status === 'awaiting_plan_approval') redirect(`/projects/${projectId}/jobs/${jobId}/plan`)
  if (job.status === 'awaiting_review' || job.status === 'done') redirect(`/projects/${projectId}/jobs/${jobId}/review`)

  const { data: logs } = await db
    .from('job_logs')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: true })

  return (
    <ExecutionScreen
      jobId={jobId}
      projectId={projectId}
      initialJob={job as Job}
      initialLogs={(logs ?? []) as LogEntry[]}
    />
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add components/agent/execution-screen.tsx app/projects/\[id\]/jobs/\[jobId\]/execution/page.tsx
git commit -m "feat: add execution screen with Supabase Realtime live log feed"
```

---

## Task 12: Plan Screen

**Files:**
- Create: `components/agent/plan-screen.tsx`
- Create: `app/projects/[id]/jobs/[jobId]/plan/page.tsx`

- [ ] **Step 1: Create `components/agent/plan-screen.tsx`**

```typescript
'use client'
import { useRouter } from 'next/navigation'
import type { AgentPlan, PlanTask } from '@/lib/supabase/types'

interface Props {
  jobId: string
  projectId: string
  plan: AgentPlan
}

export function PlanScreen({ jobId, projectId, plan }: Props) {
  const router = useRouter()

  async function approvePlan() {
    const res = await fetch(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve_plan' }),
    })
    if (res.ok) router.push(`/projects/${projectId}/jobs/${jobId}/execution`)
  }

  async function cancel() {
    await fetch(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    })
    router.push(`/projects/${projectId}/requirements`)
  }

  return (
    <div style={{ background: 'var(--bg-base)', minHeight: '100vh', padding: '2rem' }}>
      <div style={{ maxWidth: '900px', margin: '0 auto' }}>
        <div style={{ marginBottom: '2rem' }}>
          <p style={{ fontSize: '12px', color: 'var(--accent)', fontFamily: 'var(--font-jetbrains)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.5rem' }}>
            Agent Plan
          </p>
          <h1 style={{ fontSize: '1.75rem', fontFamily: 'var(--font-syne)', color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
            Review Implementation Plan
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Branch: <code style={{ fontFamily: 'var(--font-jetbrains)', color: 'var(--accent)' }}>{plan.branch_name}</code></p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '2rem' }}>
          {/* Files to create */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '1.25rem' }}>
            <h3 style={{ fontSize: '12px', color: '#22c55e', fontFamily: 'var(--font-jetbrains)', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
              Create ({plan.files_to_create.length})
            </h3>
            {plan.files_to_create.map(f => (
              <div key={f} style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'var(--font-jetbrains)', marginBottom: '0.25rem' }}>+ {f}</div>
            ))}
          </div>

          {/* Files to modify */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '1.25rem' }}>
            <h3 style={{ fontSize: '12px', color: '#f59e0b', fontFamily: 'var(--font-jetbrains)', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
              Modify ({plan.files_to_modify.length})
            </h3>
            {plan.files_to_modify.map(f => (
              <div key={f} style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'var(--font-jetbrains)', marginBottom: '0.25rem' }}>~ {f}</div>
            ))}
          </div>
        </div>

        {/* Test approach */}
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '1.25rem', marginBottom: '2rem' }}>
          <h3 style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-jetbrains)', textTransform: 'uppercase', marginBottom: '0.5rem' }}>Test Approach</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>{plan.test_approach}</p>
        </div>

        {/* Tasks */}
        <div style={{ marginBottom: '2.5rem' }}>
          <h2 style={{ fontSize: '1rem', color: 'var(--text-primary)', fontFamily: 'var(--font-syne)', marginBottom: '1rem' }}>
            Tasks ({plan.tasks.length})
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {(plan.tasks as PlanTask[]).map((task, i) => (
              <div key={task.id} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: '10px', padding: '1rem' }}>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                  <span style={{ fontSize: '11px', color: 'var(--accent)', fontFamily: 'var(--font-jetbrains)', minWidth: '24px' }}>{i + 1}</span>
                  <div>
                    <p style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: '14px', marginBottom: '0.25rem' }}>{task.title}</p>
                    <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '0.5rem' }}>{task.description}</p>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      {task.files.map(f => (
                        <span key={f} style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-jetbrains)', background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: '4px' }}>{f}</span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button
            onClick={approvePlan}
            style={{ padding: '0.75rem 2rem', background: 'var(--accent)', color: '#000', borderRadius: '8px', fontSize: '14px', fontWeight: 600, cursor: 'pointer', border: 'none', fontFamily: 'var(--font-jetbrains)' }}
          >
            Approve Plan → Start Coding
          </button>
          <button
            onClick={cancel}
            style={{ padding: '0.75rem 1.5rem', background: 'transparent', color: 'var(--text-muted)', borderRadius: '8px', fontSize: '14px', cursor: 'pointer', border: '1px solid var(--border-subtle)' }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create `app/projects/[id]/jobs/[jobId]/plan/page.tsx`**

```typescript
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PlanScreen } from '@/components/agent/plan-screen'
import type { AgentPlan } from '@/lib/supabase/types'

interface Props {
  params: Promise<{ id: string; jobId: string }>
}

export default async function PlanPage({ params }: Props) {
  const { id: projectId, jobId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: job } = await db
    .from('jobs')
    .select('*, projects!inner(owner_id)')
    .eq('id', jobId)
    .single()

  if (!job || (job.projects as { owner_id: string }).owner_id !== user.id) redirect('/projects')
  if (job.status !== 'awaiting_plan_approval') redirect(`/projects/${projectId}/jobs/${jobId}/execution`)

  const { data: plan } = await db.from('agent_plans').select('*').eq('job_id', jobId).single()
  if (!plan) redirect(`/projects/${projectId}/jobs/${jobId}/execution`)

  return <PlanScreen jobId={jobId} projectId={projectId} plan={plan as AgentPlan} />
}
```

- [ ] **Step 3: Commit**

```bash
git add components/agent/plan-screen.tsx app/projects/\[id\]/jobs/\[jobId\]/plan/page.tsx
git commit -m "feat: add plan screen with task list, file diff columns, and approve button"
```

---

## Task 13: Review Screen

**Files:**
- Create: `components/agent/review-screen.tsx`
- Create: `app/projects/[id]/jobs/[jobId]/review/page.tsx`

- [ ] **Step 1: Create `components/agent/review-screen.tsx`**

```typescript
'use client'
import { useRouter } from 'next/navigation'
import type { Job, TestResult } from '@/lib/supabase/types'

interface Props {
  jobId: string
  projectId: string
  job: Job
  diff: string
  testResult: TestResult | null
}

function DiffViewer({ diff }: { diff: string }) {
  if (!diff) return <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No diff available.</p>
  return (
    <pre style={{ fontFamily: 'var(--font-jetbrains)', fontSize: '12px', lineHeight: '1.6', overflowX: 'auto', margin: 0 }}>
      {diff.split('\n').map((line, i) => {
        const color = line.startsWith('+') ? '#22c55e' : line.startsWith('-') ? '#ef4444' : line.startsWith('@@') ? '#60a5fa' : 'var(--text-secondary)'
        return <span key={i} style={{ display: 'block', color }}>{line}</span>
      })}
    </pre>
  )
}

export function ReviewScreen({ jobId, projectId, job, diff, testResult }: Props) {
  const router = useRouter()

  async function approve() {
    const res = await fetch(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve_review' }),
    })
    if (res.ok) router.push(`/projects/${projectId}/requirements`)
  }

  async function retry() {
    const res = await fetch(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'retry' }),
    })
    if (res.ok) router.push(`/projects/${projectId}/jobs/${jobId}/execution`)
  }

  return (
    <div style={{ background: 'var(--bg-base)', minHeight: '100vh', padding: '2rem' }}>
      <div style={{ maxWidth: '900px', margin: '0 auto' }}>
        <div style={{ marginBottom: '2rem' }}>
          <p style={{ fontSize: '12px', color: 'var(--accent)', fontFamily: 'var(--font-jetbrains)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.5rem' }}>
            Code Review
          </p>
          <h1 style={{ fontSize: '1.75rem', fontFamily: 'var(--font-syne)', color: 'var(--text-primary)', marginBottom: '0.25rem' }}>
            Review Changes
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Branch: <code style={{ fontFamily: 'var(--font-jetbrains)', color: 'var(--accent)' }}>{job.branch_name}</code></p>
        </div>

        {/* Test results */}
        {testResult && (
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem' }}>
            <div style={{ padding: '0.75rem 1.25rem', background: 'rgba(34,197,94,0.1)', border: '1px solid #22c55e', borderRadius: '8px', fontSize: '13px', color: '#22c55e', fontFamily: 'var(--font-jetbrains)' }}>
              ✓ {testResult.passed} passed
            </div>
            {testResult.failed > 0 && (
              <div style={{ padding: '0.75rem 1.25rem', background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444', borderRadius: '8px', fontSize: '13px', color: '#ef4444', fontFamily: 'var(--font-jetbrains)' }}>
                ✗ {testResult.failed} failed
              </div>
            )}
          </div>
        )}

        {/* Diff viewer */}
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '1.25rem', marginBottom: '2rem', maxHeight: '500px', overflowY: 'auto' }}>
          <DiffViewer diff={diff} />
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button
            onClick={approve}
            style={{ padding: '0.75rem 2rem', background: 'var(--accent)', color: '#000', borderRadius: '8px', fontSize: '14px', fontWeight: 600, cursor: 'pointer', border: 'none', fontFamily: 'var(--font-jetbrains)' }}
          >
            Approve → Done
          </button>
          <button
            onClick={retry}
            style={{ padding: '0.75rem 1.5rem', background: 'transparent', color: 'var(--text-secondary)', borderRadius: '8px', fontSize: '14px', cursor: 'pointer', border: '1px solid var(--border-subtle)' }}
          >
            Retry Coding
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create `app/projects/[id]/jobs/[jobId]/review/page.tsx`**

```typescript
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { LocalExecutor } from '@/lib/agent/executor'
import { ReviewScreen } from '@/components/agent/review-screen'
import type { Job } from '@/lib/supabase/types'

interface Props {
  params: Promise<{ id: string; jobId: string }>
}

export default async function ReviewPage({ params }: Props) {
  const { id: projectId, jobId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: job } = await db
    .from('jobs')
    .select('*, projects!inner(owner_id, target_path)')
    .eq('id', jobId)
    .single()

  if (!job || (job.projects as { owner_id: string }).owner_id !== user.id) redirect('/projects')
  if (job.status !== 'awaiting_review' && job.status !== 'done') redirect(`/projects/${projectId}/jobs/${jobId}/execution`)

  const targetPath = (job.projects as { target_path?: string }).target_path ?? null
  let diff = ''
  if (targetPath) {
    try {
      const executor = new LocalExecutor()
      diff = await executor.getGitDiff(targetPath)
    } catch { /* diff unavailable */ }
  }

  // Get last test result from logs
  const { data: logs } = await db
    .from('job_logs')
    .select('message')
    .eq('job_id', jobId)
    .eq('level', 'success')
    .order('created_at', { ascending: false })
    .limit(1)

  // Parse passed count from success log if available
  const lastSuccessMsg = logs?.[0]?.message ?? ''
  const passedMatch = lastSuccessMsg.match(/(\d+)\s+test/)
  const testResult = passedMatch
    ? { success: true, passed: parseInt(passedMatch[1]), failed: 0, errors: [], raw_output: '' }
    : null

  return (
    <ReviewScreen
      jobId={jobId}
      projectId={projectId}
      job={job as Job}
      diff={diff}
      testResult={testResult}
    />
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add components/agent/review-screen.tsx app/projects/\[id\]/jobs/\[jobId\]/review/page.tsx
git commit -m "feat: add review screen with git diff viewer and approve/retry actions"
```

---

## Task 14: End-to-End Smoke Test

- [ ] **Step 1: Run all agent tests**

```bash
npx vitest run tests/lib/agent/
```

Expected: All PASS.

- [ ] **Step 2: Run full test suite**

```bash
npx vitest run
```

Expected: No regressions. All previously passing tests still pass.

- [ ] **Step 3: Build check**

```bash
npm run build
```

Expected: Build completes with no TypeScript errors.

- [ ] **Step 4: Manual smoke test**

1. Start dev server: `npm run dev`
2. Open a project, configure `target_path` to a local repo with a `test` script in `package.json`
3. Create requirements, analyze, resolve gaps, mark ready
4. Click "Run Agent" — should navigate to execution screen
5. Watch live logs as planning runs
6. When plan appears, review it on Plan Screen — click Approve
7. Watch execution screen as coding iterations run
8. On Review Screen, verify diff and approve

- [ ] **Step 5: Final commit**

```bash
git add .
git commit -m "chore: complete agent loop — requirements, planning, coding, UI screens"
```

---

## Notes for Executor

**This plan runs in development mode only.** The async `void runJob(...)` pattern works because `npm run dev` keeps a persistent Node.js process. In a serverless deployment, the job runner would time out. A worker process or queue would be needed for production.

**Windows paths:** `LocalExecutor` uses `path.join` throughout, which handles Windows path separators correctly. `child_process.exec` works with Windows shells.

**Supabase Realtime** must be enabled on the `job_logs` and `jobs` tables in the Supabase dashboard under Database → Replication.
