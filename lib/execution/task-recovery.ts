// lib/execution/task-recovery.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { CodeExecutor } from './executors/code-executor'
import type { ExecutionEnvironment } from './types'
import type { DiagnosticSet, TaskBudget, IterationRecord } from './execution-types-v2'
import { detectStuck } from './stuck-detector'
import { runInlineRepair } from './inline-repair'
import { runRepairPhase } from './repair-phase'
import { insertEvent } from './event-emitter'
import { selectTests } from './test-selector'

export interface TaskRepairResult {
  success: boolean
  filesPatched: string[]
  stuckReason?: string
}

export interface TaskRepairOptions {
  taskId: string
  taskIndex: number
  runId: string
  changeId: string
  changeIntent: string
  seq: () => number
  budget: TaskBudget
  preExistingFailedTests: Set<string>
  baselineTypeErrorSigs: Set<string>
}

/**
 * Scoped repair loop for a single task.
 * - If typeErrors present: run inline-repair loop
 * - If testFailures present: run repair-phase loop
 * - Reuses existing inline-repair, repair-phase, stuck-detector
 * - State (iterationHistory) is fresh per task — reset between tasks
 */
export async function runTaskRepair(
  db: SupabaseClient,
  ai: AIProvider,
  executor: CodeExecutor,
  env: ExecutionEnvironment,
  typeErrors: DiagnosticSet | null,
  testFailures: DiagnosticSet | null,
  opts: TaskRepairOptions,
): Promise<TaskRepairResult> {
  const { taskId, taskIndex, runId, changeId, changeIntent, seq, budget, baselineTypeErrorSigs } = opts
  const allFilesPatched: string[] = []

  // ── Type error repair ────────────────────────────────────────────────────
  if (typeErrors && typeErrors.totalCount > 0) {
    const iterationHistory: IterationRecord[] = []
    let inlineRepairCount = 0
    let currentErrors = typeErrors

    while (currentErrors.totalCount > 0 && inlineRepairCount < budget.maxInlineRepairs) {
      await insertEvent(db, {
        runId, changeId, seq: seq(), iteration: taskIndex,
        eventType: 'task.repair_started',
        payload: { taskId, attempt: inlineRepairCount, strategy: 'inline' },
      })

      const attempt = await runInlineRepair(
        db, ai, executor, env, runId, changeId, taskIndex,
        currentErrors, seq, inlineRepairCount,
      )
      allFilesPatched.push(...attempt.filesPatched)
      inlineRepairCount++

      const typeCheck = await executor.runTypeCheck(env)
      // Filter out baseline errors so repair loop stays focused on task-introduced errors
      const newErrors = typeCheck.errors
        .filter(e => !baselineTypeErrorSigs.has(`${e.file}:${e.line}:${e.message}`))
        .map(e => ({ file: e.file, line: e.line, message: e.message, code: 'TS' }))

      await insertEvent(db, {
        runId, changeId, seq: seq(), iteration: taskIndex,
        eventType: 'task.repair_completed',
        payload: { taskId, attempt: inlineRepairCount - 1, success: newErrors.length === 0, remainingErrors: newErrors.length },
      })

      if (newErrors.length === 0) return { success: true, filesPatched: allFilesPatched }

      const sigs = newErrors.map(e => `${e.file}:${e.line}:${e.message.slice(0, 40)}`)
      const record: IterationRecord = {
        iteration: inlineRepairCount,
        diagnosticSigs: sigs,
        errorCount: newErrors.length,
        resolvedCount: 0,
        newCount: 0,
        repairedFiles: attempt.filesPatched,
      }
      const stuck = detectStuck(iterationHistory, record, budget)
      if (stuck.stuck) {
        return { success: false, filesPatched: allFilesPatched, stuckReason: stuck.reason ?? undefined }
      }
      iterationHistory.push(record)

      currentErrors = {
        diagnostics: newErrors.slice(0, 20),
        totalCount: newErrors.length,
        truncated: newErrors.length > 20,
      }
    }

    if (currentErrors.totalCount > 0) {
      return { success: false, filesPatched: allFilesPatched, stuckReason: 'max_attempts_reached' }
    }
    return { success: true, filesPatched: allFilesPatched }
  }

  // ── Test repair ──────────────────────────────────────────────────────────
  if (testFailures && testFailures.totalCount > 0) {
    const testRepairHistory: IterationRecord[] = []
    let repairPhaseCount = 0

    while (repairPhaseCount < budget.maxRepairPhaseAttempts) {
      await insertEvent(db, {
        runId, changeId, seq: seq(), iteration: taskIndex,
        eventType: 'task.repair_started',
        payload: { taskId, attempt: repairPhaseCount, strategy: 'repair_phase' },
      })

      const attempt = await runRepairPhase(
        db, ai, executor, env, runId, changeId, taskIndex,
        testFailures, changeIntent, seq, repairPhaseCount,
      )
      allFilesPatched.push(...attempt.filesPatched)
      repairPhaseCount++

      if (attempt.filesPatched.length === 0) {
        await insertEvent(db, {
          runId, changeId, seq: seq(), iteration: taskIndex,
          eventType: 'task.repair_completed',
          payload: { taskId, attempt: repairPhaseCount - 1, success: false },
        })
        return { success: false, filesPatched: allFilesPatched, stuckReason: 'no_diff_after_repair' }
      }

      const testScope = await selectTests(db, [], 'low')
      const retest = await executor.runTests(env, testScope)
      const success = retest.passed

      await insertEvent(db, {
        runId, changeId, seq: seq(), iteration: taskIndex,
        eventType: 'task.repair_completed',
        payload: { taskId, attempt: repairPhaseCount - 1, success },
      })

      if (success) return { success: true, filesPatched: allFilesPatched }

      const sigs = retest.failures.map(f => `test:${f.testName}:${f.error.slice(0, 60)}`)
      const record: IterationRecord = {
        iteration: repairPhaseCount,
        diagnosticSigs: sigs,
        errorCount: retest.failures.length,
        resolvedCount: 0,
        newCount: 0,
        repairedFiles: attempt.filesPatched,
      }
      const stuck = detectStuck(testRepairHistory, record, budget)
      if (stuck.stuck) {
        return { success: false, filesPatched: allFilesPatched, stuckReason: stuck.reason ?? undefined }
      }
      testRepairHistory.push(record)
    }

    return { success: false, filesPatched: allFilesPatched, stuckReason: 'max_attempts_reached' }
  }

  // No errors to repair
  return { success: true, filesPatched: [] }
}
