// lib/execution/task-runner.ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { CodeExecutor } from './executors/code-executor'
import type { ExecutionEnvironment, NewFileCreation } from './types'
import type { TaskBudget } from './execution-types-v2'
import { insertEvent } from './event-emitter'
import { isPathAllowed } from './repair-guard'
import { buildTaskImplementationPrompt } from './prompt-builders'
import type { TaskFileContext } from './prompt-builders'
import { acquireTaskLock, releaseTaskDone, releaseTaskFailed } from './task-locker'
import { runTaskValidation } from './task-validator'
import { runTaskRepair } from './task-recovery'

const TASK_FILE_CHAR_CAP = 24_000
const TASK_FILE_CAP = 5

interface PlanTask {
  id: string
  description: string
  order_index: number
  status: string
  files: string[]
  dependencies: string[]
}

export interface TaskRunnerOptions {
  runId: string
  changeId: string
  changeIntent: string
  taskIndex: number
  baselineTypeErrorSigs: Set<string>
  preExistingFailedTests: Set<string>
  budget: TaskBudget
  seq: () => number
  availablePackages: string[]
}

export interface TaskRunResult {
  success: boolean
  filesWritten: string[]
  newFiles: NewFileCreation[]
}

function parseAiJson(content: string): Record<string, unknown> {
  const stripped = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim()
  return JSON.parse(stripped)
}

/**
 * Execute one task from start to finish.
 * Caller is responsible for:
 *   - Calling executor.resetIteration(env, acceptedFileWrites) BEFORE calling this
 *   - Adding result.filesWritten to acceptedFileWrites on success
 */
export async function runTask(
  task: PlanTask,
  env: ExecutionEnvironment,
  db: SupabaseClient,
  ai: AIProvider,
  executor: CodeExecutor,
  opts: TaskRunnerOptions,
): Promise<TaskRunResult> {
  const { runId, changeId, changeIntent, taskIndex, baselineTypeErrorSigs, preExistingFailedTests, budget, seq } = opts
  const taskStartMs = Date.now()

  // Acquire lock (conditional — prevents double-execution)
  const locked = await acquireTaskLock(db, task.id, runId)
  if (!locked) {
    return { success: false, filesWritten: [], newFiles: [] }
  }

  await insertEvent(db, {
    runId, changeId, seq: seq(), iteration: taskIndex,
    eventType: 'task.started',
    payload: { taskId: task.id, taskIndex, title: task.description.slice(0, 80) },
  })

  // No files to implement
  const taskFiles = task.files.filter(isPathAllowed).slice(0, TASK_FILE_CAP)
  if (taskFiles.length === 0) {
    await releaseTaskDone(db, task.id)
    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: taskIndex,
      eventType: 'task.completed',
      payload: { taskId: task.id, durationMs: Date.now() - taskStartMs },
    })
    return { success: true, filesWritten: [], newFiles: [] }
  }

  // ── Implement ────────────────────────────────────────────────────────────
  const fileContexts: TaskFileContext[] = []
  let charBudget = TASK_FILE_CHAR_CAP

  for (const filePath of taskFiles) {
    try {
      const raw = await readFile(join(env.localWorkDir, filePath), 'utf8')
      const chars = Math.min(raw.length, charBudget)
      fileContexts.push({ path: filePath, content: raw.slice(0, chars), isNew: false })
      charBudget -= chars
    } catch {
      fileContexts.push({ path: filePath, content: '', isNew: true })
    }
    if (charBudget <= 0) break
  }

  const prompt = buildTaskImplementationPrompt(
    { description: task.description, intent: changeIntent },
    fileContexts,
  )

  const aiResult = await ai.complete(prompt, { maxTokens: 8192 })
  let parsed: { files?: { path: string; content: string }[]; confidence?: number } = {}
  try { parsed = parseAiJson(aiResult.content) } catch { /* leave empty */ }

  const filesWritten: string[] = []
  const newFiles: NewFileCreation[] = []

  for (const fw of (parsed.files ?? []).filter(f => isPathAllowed(f.path)).slice(0, TASK_FILE_CAP)) {
    if (!fw.content) continue
    const result = await executor.createFile(env, fw.path, fw.content)
    if (result.success) {
      filesWritten.push(fw.path)
      // Track whether it's a new file (for acceptedNewFiles in orchestrator)
      if (fileContexts.find(fc => fc.path === fw.path)?.isNew) {
        newFiles.push({ path: fw.path, content: fw.content })
      }
    }
  }

  if (filesWritten.length === 0) {
    await releaseTaskFailed(db, task.id, 'AI returned no applicable file writes')
    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: taskIndex,
      eventType: 'task.failed',
      payload: { taskId: task.id, reason: 'no_files_written', stuckReason: null },
    })
    return { success: false, filesWritten: [], newFiles: [] }
  }

  // ── Validate ─────────────────────────────────────────────────────────────
  const validation = await runTaskValidation(db, executor, env, {
    taskId: task.id,
    taskIndex,
    taskFiles,
    baselineTypeErrorSigs,
    runId,
    changeId,
    seq,
  })

  if (validation.passed) {
    await releaseTaskDone(db, task.id)
    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: taskIndex,
      eventType: 'task.completed',
      payload: { taskId: task.id, durationMs: Date.now() - taskStartMs },
    })
    return { success: true, filesWritten, newFiles }
  }

  // ── Repair ───────────────────────────────────────────────────────────────
  const repair = await runTaskRepair(db, ai, executor, env,
    validation.typeErrors,
    validation.testFailures,
    {
      taskId: task.id,
      taskIndex,
      runId,
      changeId,
      changeIntent,
      seq,
      budget,
      preExistingFailedTests,
    },
  )

  if (repair.success) {
    await releaseTaskDone(db, task.id)
    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: taskIndex,
      eventType: 'task.completed',
      payload: { taskId: task.id, durationMs: Date.now() - taskStartMs },
    })
    return {
      success: true,
      filesWritten: [...new Set([...filesWritten, ...repair.filesPatched])],
      newFiles,
    }
  }

  const failureReason = repair.stuckReason
    ?? (validation.typeErrors ? `tsc: ${validation.typeErrors.totalCount} errors` : 'tests failed')
  await releaseTaskFailed(db, task.id, failureReason)
  await insertEvent(db, {
    runId, changeId, seq: seq(), iteration: taskIndex,
    eventType: 'task.failed',
    payload: { taskId: task.id, reason: failureReason, stuckReason: repair.stuckReason ?? null },
  })
  return { success: false, filesWritten: [], newFiles: [] }
}
