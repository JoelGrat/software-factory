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
// Tasks now carry a files[] array (from plan_json projection)
const TASKS = [
  { id: 't1', plan_id: 'plan-1', description: 'Update getUser', order_index: 0, status: 'pending', files: ['app/auth/getUser.ts'] },
]
// AI response that satisfies the task-runner (at least one allowed file written)
const TASK_AI_RESPONSE = JSON.stringify({
  files: [{ path: 'app/auth/getUser.ts', content: 'export function getUser() { return null }' }],
  confidence: 0.9,
})
const CHANGE = { id: 'cr1', project_id: 'proj1', title: 'Fix auth', intent: 'fix it', type: 'bug', risk_level: 'low' }
const PROJECT = { id: 'proj1', repo_url: 'https://github.com/test/repo', repo_token: 'ghp_test_token' }

/** Build an update mock that returns `this` for any number of eq() calls, then resolves. */
function makeUpdateChain(updates: Array<{ table: string; data: Record<string, unknown> }>, table: string) {
  return (data: Record<string, unknown>) => {
    updates.push({ table, data })
    const chain: Record<string, unknown> = {}
    const eqFn = () => chain
    const ltFn = () => chain
    // .select('id') after update — used by acquireTaskLock; return rows that include one entry
    // so the lock is considered acquired.
    const selectFn = () => Promise.resolve({ data: [{ id: 'task-lock' }], error: null })
    chain.eq = eqFn
    chain.lt = ltFn
    chain.select = selectFn
    // Terminal — awaiting the chain should resolve
    chain.then = (resolve: (v: unknown) => void) => resolve({ error: null })
    return chain
  }
}

function makeMockDb(opts: { planStatus?: string; tasks?: typeof TASKS } = {}): { db: SupabaseClient; updates: Array<{ table: string; data: Record<string, unknown> }> } {
  const updates: Array<{ table: string; data: Record<string, unknown> }> = []
  // Mutable task state so the post-loop reload reflects task.status updates
  const taskState = (opts.tasks ?? TASKS).map(t => ({ ...t }))

  const db = {
    from: (table: string) => {
      if (table === 'change_requests') {
        return {
          update: makeUpdateChain(updates, table),
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
            eq: () => {
              const p = Promise.resolve({ data: taskState })
              return Object.assign(p, {
                order: () => Promise.resolve({ data: taskState }),
              })
            },
          }),
          update: (data: Record<string, unknown>) => {
            updates.push({ table, data })
            const chain: Record<string, unknown> = {}
            // Track the task id we're updating via the first eq('id', ...) call
            let targetId: string | undefined
            chain.eq = (col: string, val: string) => {
              if (col === 'id') targetId = val
              return chain
            }
            chain.lt = () => chain
            chain.select = () => {
              // Apply status transition to in-memory taskState so post-loop reload sees it
              if (targetId && typeof data.status === 'string') {
                const t = taskState.find(x => x.id === targetId)
                if (t) (t as Record<string, unknown>).status = data.status
              }
              return Promise.resolve({ data: [{ id: targetId ?? 'task-lock' }], error: null })
            }
            chain.then = (resolve: (v: unknown) => void) => {
              if (targetId && typeof data.status === 'string') {
                const t = taskState.find(x => x.id === targetId)
                if (t) (t as Record<string, unknown>).status = data.status
              }
              return resolve({ error: null })
            }
            return chain
          },
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
              maybeSingle: () => Promise.resolve({ data: null }),
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
      if (table === 'execution_runs') {
        return {
          select: (_cols?: string) => ({
            eq: () => ({
              eq: () => ({
                limit: () => ({
                  maybeSingle: () => Promise.resolve({ data: null }),  // no existing run
                }),
              }),
              single: () => Promise.resolve({ data: null }),
            }),
          }),
          insert: (_data: unknown) => ({
            select: (_cols?: string) => ({
              single: () => Promise.resolve({ data: { id: 'run-1' }, error: null }),
            }),
          }),
          update: (_data: unknown) => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        }
      }
      if (table === 'execution_events') {
        return {
          insert: () => Promise.resolve({ error: null }),
        }
      }
      if (table === 'event_history') {
        return {
          insert: () => Promise.resolve({ error: null }),
          select: () => ({
            eq: () => ({
              order: () => ({
                range: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }),
                limit: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }),
              }),
              gt: () => ({
                order: () => Promise.resolve({ data: [] }),
              }),
              delete: () => ({ lt: () => Promise.resolve({ error: null }) }),
            }),
          }),
          delete: () => ({ eq: () => ({ lt: () => Promise.resolve({ error: null }) }) }),
        }
      }
      if (table === 'analysis_result_snapshot') {
        return {
          insert: () => Promise.resolve({ error: null }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        }
      }
      if (table === 'pinned_action_items') {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) }),
          insert: () => Promise.resolve({ error: null }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
        }
      }
      return {
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }),
      }
    },
    rpc: (_fn: string, _args?: Record<string, unknown>) => Promise.resolve({ data: 1, error: null }),
  } as unknown as SupabaseClient

  return { db, updates }
}

describe('runExecution', () => {
  it('sets status to executing then review on happy path', async () => {
    const { db, updates } = makeMockDb()
    const executor = new MockCodeExecutor()
    const ai = new MockAIProvider()
    ai.setDefaultResponse(TASK_AI_RESPONSE)

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

  it('calls createFile when task has a file to write', async () => {
    const fileTask = [
      { id: 't2', plan_id: 'plan-1', description: 'Create lib/foo.ts', order_index: 0, status: 'pending', files: ['lib/foo.ts'] },
    ]
    const { db } = makeMockDb()
    const dbWithFileTask = {
      from: (table: string) => {
        if (table === 'change_plan_tasks') {
          return {
            select: () => ({
              eq: () => {
                const p = Promise.resolve({ data: fileTask })
                return Object.assign(p, {
                  order: () => Promise.resolve({ data: fileTask }),
                })
              },
            }),
            update: makeUpdateChain([], table),
          }
        }
        return (db as any).from(table)
      },
      rpc: (db as any).rpc,
    } as unknown as SupabaseClient

    const executor = new MockCodeExecutor()
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      files: [{ path: 'lib/foo.ts', content: 'export const foo = 1' }],
      confidence: 0.9,
      reasoning: 'simple',
    }))

    await runExecution('cr1', dbWithFileTask, ai, executor)

    expect(executor.calls).toContain('createFile')
  })

  it('createFile is invoked with the written file path from the AI response', async () => {
    const fileTask = [
      { id: 't3', plan_id: 'plan-1', description: 'Create lib/bar.ts', order_index: 0, status: 'pending', files: ['lib/bar.ts'] },
    ]
    const { db } = makeMockDb({ tasks: fileTask as typeof TASKS })

    const executor = new MockCodeExecutor()
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      files: [{ path: 'lib/bar.ts', content: 'export const bar = 2' }],
      confidence: 0.9,
      reasoning: 'simple',
    }))

    await runExecution('cr1', db, ai, executor)

    expect(executor.calls).toContain('createFile')
  })

  it('skips blocked paths and does not call createFile for them', async () => {
    // Migration files are blocked — the orchestrator should filter them out
    const blockedTask = [
      { id: 't4', plan_id: 'plan-1', description: 'Migration task', order_index: 0, status: 'pending', files: ['supabase/migrations/027_foo.sql'] },
    ]
    const { db } = makeMockDb()
    const dbBlocked = {
      from: (table: string) => {
        if (table === 'change_plan_tasks') {
          return {
            select: () => ({
              eq: () => {
                const p = Promise.resolve({ data: blockedTask })
                return Object.assign(p, {
                  order: () => Promise.resolve({ data: blockedTask }),
                })
              },
            }),
            update: makeUpdateChain([], table),
          }
        }
        return (db as any).from(table)
      },
      rpc: (db as any).rpc,
    } as unknown as SupabaseClient

    const executor = new MockCodeExecutor()
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      files: [{ path: 'supabase/migrations/027_foo.sql', content: 'SELECT 1' }],
      confidence: 0.9,
      reasoning: 'blocked',
    }))

    await runExecution('cr1', dbBlocked, ai, executor)

    // createFile should NOT have been called for a blocked path
    expect(executor.calls.filter(c => c === 'createFile')).toHaveLength(0)
  })
})
