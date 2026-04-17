// lib/execution/task-validator.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CodeExecutor } from './executors/code-executor'
import type { ExecutionEnvironment } from './types'
import type { DiagnosticSet } from './execution-types-v2'
import { insertEvent } from './event-emitter'
import { selectTests } from './test-selector'

export interface TaskValidationResult {
  passed: boolean
  typeErrors: DiagnosticSet | null
  testFailures: DiagnosticSet | null
  /** Files added to repair scope because they import from task.files and also have errors */
  expandedFiles: string[]
}

export interface TaskValidatorOptions {
  taskId: string
  taskIndex: number
  taskFiles: string[]
  baselineTypeErrorSigs: Set<string>
  preExistingFailedTests: Set<string>
  runId: string
  changeId: string
  seq: () => number
}

/**
 * Run scoped validation for a single task.
 *
 * Layer 1 (always): TypeScript compile, errors filtered to task.files
 *                   + adjacent files that import from task.files and also have errors.
 * Layer 2 (always): Tests scoped to task.files via selectTests.
 */
export async function runTaskValidation(
  db: SupabaseClient,
  executor: CodeExecutor,
  env: ExecutionEnvironment,
  opts: TaskValidatorOptions,
): Promise<TaskValidationResult> {
  const startMs = Date.now()
  const { taskId, taskIndex, taskFiles, baselineTypeErrorSigs, preExistingFailedTests, runId, changeId, seq } = opts

  await insertEvent(db, {
    runId, changeId, seq: seq(), iteration: taskIndex,
    eventType: 'task.validation_started',
    payload: { taskId, checks: ['tsc', 'tests'] },
  })

  // ── Layer 1: TypeScript compile ───────────────────────────────────────────
  const typeCheck = await executor.runTypeCheck(env)

  const filterNewErrors = (errors: typeof typeCheck.errors) =>
    errors.filter(e => !baselineTypeErrorSigs.has(`${e.file}:${e.line}:${e.message}`))

  const newErrors = filterNewErrors(typeCheck.errors)

  // Errors in task.files
  const taskFileSet = new Set(taskFiles)
  const directErrors = newErrors.filter(e => taskFileSet.has(e.file))

  // File scope expansion: errors in files NOT in task.files (adjacent files that import from task.files)
  const expandedFiles: string[] = []
  const nonDirectErrors = newErrors.filter(e => !taskFileSet.has(e.file))
  for (const err of nonDirectErrors) {
    if (!expandedFiles.includes(err.file)) {
      expandedFiles.push(err.file)
    }
  }

  const allScopedErrors = [...directErrors, ...newErrors.filter(e => expandedFiles.includes(e.file))]

  if (allScopedErrors.length > 0) {
    const diags = allScopedErrors.map(e => ({ file: e.file, line: e.line, message: e.message, code: 'TS' }))
    const typeErrorSet: DiagnosticSet = {
      diagnostics: diags.slice(0, 20),
      totalCount: diags.length,
      truncated: diags.length > 20,
    }
    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: taskIndex,
      eventType: 'task.validation_failed',
      payload: {
        taskId,
        failureType: 'TSC',
        summary: `${diags.length} type error(s)`,
        errors: diags.slice(0, 8).map(d => `${d.file}:${d.line} ${d.message.slice(0, 120)}`),
        expandedFiles,
      },
    })
    return { passed: false, typeErrors: typeErrorSet, testFailures: null, expandedFiles }
  }

  // ── Layer 2: Scoped tests ─────────────────────────────────────────────────
  const testScope = await selectTests(db, taskFiles, 'low')
  const testResult = await executor.runTests(env, testScope)

  if (!testResult.passed) {
    // Filter out failures that were already present before execution started
    const newFailures = testResult.failures.filter(f => !preExistingFailedTests.has(f.testName))

    if (newFailures.length === 0) {
      // Only pre-existing failures — treat as pass for this task
      await insertEvent(db, {
        runId, changeId, seq: seq(), iteration: taskIndex,
        eventType: 'task.validation_passed',
        payload: { taskId, durationMs: Date.now() - startMs, note: 'test failures are all pre-existing' },
      })
      return { passed: true, typeErrors: null, testFailures: null, expandedFiles: [] }
    }

    const failures = newFailures.map((f, i) => ({
      file: f.testName, line: i + 1, message: f.error.slice(0, 200), code: 'TEST',
    }))
    const testFailureSet: DiagnosticSet = {
      diagnostics: failures.slice(0, 20),
      totalCount: failures.length,
      truncated: failures.length > 20,
    }
    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: taskIndex,
      eventType: 'task.validation_failed',
      payload: {
        taskId,
        failureType: testResult.failureType ?? 'TEST',
        summary: `${failures.length} new test failure(s)`,
        errors: failures.slice(0, 5).map(f => `${f.file}: ${f.message.slice(0, 120)}`),
        expandedFiles: [],
      },
    })
    return { passed: false, typeErrors: null, testFailures: testFailureSet, expandedFiles: [] }
  }

  await insertEvent(db, {
    runId, changeId, seq: seq(), iteration: taskIndex,
    eventType: 'task.validation_passed',
    payload: { taskId, durationMs: Date.now() - startMs },
  })

  return { passed: true, typeErrors: null, testFailures: null, expandedFiles: [] }
}
