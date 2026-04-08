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
const PROJECT = { id: 'proj1', repo_url: 'https://github.com/test/repo', repo_token: 'ghp_test_token' }
const IMPACT_COMPONENTS = [
  { component_id: 'c1', impact_weight: 1.0, system_components: { name: 'AuthService', type: 'auth' } },
]

function makeMockDb(opts: { planStatus?: string } = {}): { db: SupabaseClient; updates: Array<{ table: string; data: Record<string, unknown> }> } {
  const updates: Array<{ table: string; data: Record<string, unknown> }> = []

  const db = {
    from: (table: string) => {
      if (table === 'change_requests') {
        return {
          update: (data: Record<string, unknown>) => ({
            eq: (_c: string, _v: string) => {
              updates.push({ table, data })
              return Promise.resolve({ error: null })
            },
          }),
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: CHANGE }),
            }),
          }),
        }
      }
      if (table === 'change_plans') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: () => Promise.resolve({ data: { ...PLAN, status: opts.planStatus ?? 'approved' } }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'change_plan_tasks') {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: TASKS }),
            }),
          }),
          update: (data: Record<string, unknown>) => ({
            eq: () => ({
              eq: () => {
                updates.push({ table, data })
                return Promise.resolve({ error: null })
              },
            }),
          }),
        }
      }
      if (table === 'projects') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: PROJECT }),
            }),
          }),
        }
      }
      if (table === 'change_impacts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { id: 'impact-1' } }),
            }),
          }),
        }
      }
      if (table === 'change_impact_components') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: IMPACT_COMPONENTS }),
              }),
            }),
          }),
        }
      }
      if (table === 'component_assignment') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: [] }),
            }),
          }),
        }
      }
      if (table === 'test_coverage_map') {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: [] }),
          }),
        }
      }
      if (table === 'component_graph_edges') {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: [] }),
          }),
        }
      }
      if (table === 'execution_snapshots') {
        return {
          insert: () => Promise.resolve({ data: [{ id: 'snap-1' }], error: null }),
        }
      }
      if (table === 'execution_trace') {
        return {
          insert: () => Promise.resolve({ error: null }),
        }
      }
      if (table === 'change_commits') {
        return {
          insert: () => Promise.resolve({ error: null }),
        }
      }
      if (table === 'execution_logs') {
        return {
          insert: () => Promise.resolve({ error: null }),
        }
      }
      return {
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }),
      }
    },
  } as unknown as SupabaseClient

  return { db, updates }
}

describe('runExecution', () => {
  it('sets status to executing then review on happy path', async () => {
    const { db, updates } = makeMockDb()
    const executor = new MockCodeExecutor()
    const ai = new MockAIProvider()

    await runExecution('cr1', db, ai, executor)

    const statusUpdates = updates
      .filter(u => u.table === 'change_requests' && u.data.status)
      .map(u => u.data.status as string)

    expect(statusUpdates).toContain('executing')
    expect(statusUpdates).toContain('review')
    expect(executor.calls).toContain('prepareEnvironment')
    expect(executor.calls).toContain('cleanup')
  })

  it('sets status to failed when no approved plan', async () => {
    const { db, updates } = makeMockDb({ planStatus: 'draft' })
    const executor = new MockCodeExecutor()
    const ai = new MockAIProvider()

    try {
      await runExecution('cr1', db, ai, executor)
    } catch { /* expected */ }

    const statusUpdates = updates
      .filter(u => u.table === 'change_requests' && u.data.status)
      .map(u => u.data.status as string)

    expect(statusUpdates[0]).toBe('executing')
    const finalStatus = statusUpdates[statusUpdates.length - 1]
    expect(['failed', 'analyzed']).toContain(finalStatus)
  })

  it('calls resetIteration at start of iteration', async () => {
    const { db } = makeMockDb()
    const executor = new MockCodeExecutor()
    await runExecution('cr1', db, new MockAIProvider(), executor)
    expect(executor.calls).toContain('resetIteration')
  })

  it('calls commitAndPush when execution succeeds', async () => {
    const { db } = makeMockDb()
    const executor = new MockCodeExecutor()
    await runExecution('cr1', db, new MockAIProvider(), executor)
    expect(executor.calls).toContain('commitAndPush')
  })

  it('calls createFile when task has new_file_path', async () => {
    const newFileTasks = [
      { id: 't2', plan_id: 'plan-1', component_id: null, description: 'Create new file: lib/foo.ts', order_index: 0, status: 'pending', new_file_path: 'lib/foo.ts' },
    ]
    const { db } = makeMockDb()
    // Build a db that returns new-file tasks
    const dbWithNewFile = {
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
        return (db as any).from(table)
      },
    } as unknown as SupabaseClient

    const executor = new MockCodeExecutor()
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ newFileContent: 'export const foo = 1', confidence: 90, reasoning: 'simple' }))

    await runExecution('cr1', dbWithNewFile, ai, executor)

    expect(executor.calls).toContain('createFile')
  })

  it('snapshot files_modified includes new file path when createFile succeeds', async () => {
    const newFileTasks = [
      { id: 't3', plan_id: 'plan-1', component_id: null, description: 'Create new file: lib/bar.ts', order_index: 0, status: 'pending', new_file_path: 'lib/bar.ts' },
    ]
    const snapshotInserts: any[] = []
    const { db } = makeMockDb()

    const dbCapture = {
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
    ai.setDefaultResponse(JSON.stringify({ newFileContent: 'export const bar = 2', confidence: 90, reasoning: 'simple' }))

    await runExecution('cr1', dbCapture, ai, executor)

    const successSnapshot = snapshotInserts.find((s: any) => s.termination_reason === 'passed')
    expect(successSnapshot?.files_modified).toContain('lib/bar.ts')
  })

  it('populates componentFileMap from single-object files join and calls applyPatch', async () => {
    // Regression test: Supabase returns files/system_components as single objects (not arrays)
    // for forward FK joins. Previously these were accessed as [0] causing componentFileMap
    // to always be empty and applyPatch to never be called.
    const { writeFile, mkdir, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const tmpDir = join(tmpdir(), 'sf-orch-test-' + Math.random().toString(36).slice(2))
    await mkdir(join(tmpDir, 'src'), { recursive: true })
    await writeFile(join(tmpDir, 'src/auth.ts'), 'export function getUser(id: string) { return id }')

    const executor = new MockCodeExecutor()
    const origPrepare = executor.prepareEnvironment.bind(executor)
    executor.prepareEnvironment = async (_p: unknown, _b: string, log?: unknown) => ({
      ...await origPrepare(_p as any, _b, log as any),
      localWorkDir: tmpDir,
    })

    const { db } = makeMockDb()
    const dbWithFiles = {
      from: (table: string) => {
        if (table === 'component_assignment') {
          // files is a single object — matches Supabase forward FK join shape
          return {
            select: () => ({
              eq: () => ({
                eq: () => Promise.resolve({ data: [{ file_id: 'f1', files: { path: 'src/auth.ts' } }] }),
              }),
            }),
          }
        }
        return (db as any).from(table)
      },
    } as unknown as SupabaseClient

    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      newContent: 'export function getUser(id: string) { return id + "_v2" }',
      confidence: 90, requiresPropagation: false, reasoning: 'test',
    }))

    await runExecution('cr1', dbWithFiles, ai, executor)

    expect(executor.calls).toContain('applyPatch')

    await rm(tmpDir, { recursive: true, force: true })
  })
})
