import { describe, it, expect, vi } from 'vitest'
import { runJob } from '@/lib/agent/job-runner'
import { MockAIProvider } from '@/lib/ai/adapters/mock'
import type { IExecutor } from '@/lib/agent/executor'
import type { TestResult } from '@/lib/supabase/types'

function makeExecutor(testSuccess = true): IExecutor {
  return {
    getFileTree: vi.fn().mockResolvedValue(['src/index.ts']),
    readFile: vi.fn().mockResolvedValue('content'),
    readFiles: vi.fn().mockResolvedValue({}),
    writeFiles: vi.fn().mockResolvedValue(undefined),
    runTests: vi.fn().mockResolvedValue({ success: testSuccess, passed: testSuccess ? 1 : 0, failed: testSuccess ? 0 : 1, errors: testSuccess ? [] : ['Test failed'], raw_output: '' } as TestResult),
    detectTestCommand: vi.fn().mockResolvedValue('vitest run'),
    createBranch: vi.fn().mockResolvedValue(undefined),
    getGitDiff: vi.fn().mockResolvedValue(''),
  }
}

function makeDb(tables: Record<string, unknown> = {}) {
  const fromImpl = (table: string) => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: tables[table] ?? null, error: null }),
    insert: vi.fn().mockResolvedValue({ data: { id: 'new-id' }, error: null }),
    update: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
  })
  return { from: vi.fn((t: string) => fromImpl(t)) } as unknown as Parameters<typeof runJob>[3]
}

const JOB = { id: 'job-1', project_id: 'proj-1', requirement_id: 'req-1', status: 'plan_loop', branch_name: null, iteration_count: 0, error: null, created_at: '', completed_at: null }
const PROJECT = { id: 'proj-1', target_path: '/tmp/test-project' }
const REQUIREMENT = { id: 'req-1', raw_input: 'build login feature' }
const ITEMS = [{ type: 'functional', title: 'Login', description: 'Login', priority: 'high', source_text: 'Login', nfr_category: null }]
const PLAN_ROW = { tasks: [{ id: 'task-1', title: 'Add login', description: 'Add login', files: ['src/login.ts'], dependencies: [] }], files_to_create: ['src/login.ts'], files_to_modify: [], test_approach: 'unit tests', branch_name: 'sf/abc-login' }

describe('runJob — planning phase', () => {
  it('calls planner and writes plan to DB', async () => {
    const mock = new MockAIProvider()
    mock.setResponse('FILE TREE', JSON.stringify({ requested_files: [] }))
    mock.setResponse('FILE CONTENTS', JSON.stringify(PLAN_ROW))
    mock.setResponse('PROJECT TREE', JSON.stringify({ requested_files: [] }))

    const db = makeDb({ jobs: JOB, projects: PROJECT, requirements: REQUIREMENT, requirement_items: ITEMS })
    const executor = makeExecutor()

    await runJob('job-1', 'planning', db, mock, executor)

    expect(executor.getFileTree).toHaveBeenCalledWith('/tmp/test-project')
    expect(db.from).toHaveBeenCalledWith('agent_plans')
  })
})

describe('runJob — coding phase', () => {
  it('runs coding loop until tests pass', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ changes: [{ path: 'src/login.ts', content: 'export {}', operation: 'create' }] }))

    const db = makeDb({ jobs: { ...JOB, status: 'coding' }, projects: PROJECT, requirements: REQUIREMENT, requirement_items: ITEMS, agent_plans: PLAN_ROW })
    const executor = makeExecutor(true)

    await runJob('job-1', 'coding', db, mock, executor)

    expect(executor.writeFiles).toHaveBeenCalled()
    expect(executor.runTests).toHaveBeenCalledWith('/tmp/test-project')
    expect(executor.createBranch).toHaveBeenCalledWith('/tmp/test-project', 'sf/abc-login')
  })
})
