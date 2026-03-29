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
    mock.setResponse('FILE TREE', JSON.stringify({ requested_files: ['package.json'] }))
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
    expect(mock.callCount).toBe(3) // file tree + plan JSON + spec markdown

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
