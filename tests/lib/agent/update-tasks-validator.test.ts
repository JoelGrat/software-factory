import { describe, it, expect } from 'vitest'
import { validateUpdateTasks } from '@/lib/agent/update-tasks-validator'

describe('validateUpdateTasks', () => {
  it('accepts a valid tasks array', () => {
    const tasks = [
      { id: 'task-1', title: 'Do X', description: 'desc', files: ['a.ts'], dependencies: [] },
    ]
    expect(validateUpdateTasks(tasks)).toEqual({ valid: true })
  })

  it('rejects non-array', () => {
    expect(validateUpdateTasks('not an array')).toEqual({ valid: false, error: 'tasks must be an array' })
  })

  it('rejects task missing title', () => {
    const tasks = [{ id: 'task-1', description: 'desc', files: [], dependencies: [] }]
    expect(validateUpdateTasks(tasks)).toEqual({ valid: false, error: expect.stringContaining('title') })
  })

  it('rejects task missing id', () => {
    const tasks = [{ title: 'T', description: 'desc', files: [], dependencies: [] }]
    expect(validateUpdateTasks(tasks)).toEqual({ valid: false, error: expect.stringContaining('id') })
  })

  it('accepts empty array', () => {
    expect(validateUpdateTasks([])).toEqual({ valid: true })
  })
})
