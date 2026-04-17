// lib/execution/task-runner.ts
import { readFile, access } from 'node:fs/promises'
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
}

export interface TaskRunResult {
  success: boolean
  filesWritten: string[]
  newFiles: NewFileCreation[]
}

function parseAiJson(content: string): Record<string, unknown> {
  // Handle fenced code blocks: capture content between ``` fences (if present)
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  const text = fenced ? fenced[1] : content
  return JSON.parse(text.trim())
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

  // From here: task is in_progress. Any unhandled exception must release the lock.
  try {
    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: taskIndex,
      eventType: 'task.started',
      payload: {
        taskId: task.id,
        taskIndex,
        title: task.description.slice(0, 100),
        files: task.files,
        dependsOn: task.dependencies,
      },
    })

    // ── Implement ────────────────────────────────────────────────────────────
    // taskFiles may be empty when the planner didn't assign explicit file paths
    // (e.g. tasks driven by substep commands). In that case we pass an empty
    // context so the AI determines which files to create or modify itself.
    const taskFiles = task.files.filter(isPathAllowed).slice(0, TASK_FILE_CAP)
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
    try { parsed = parseAiJson(aiResult.content) } catch { /* AI returned unparseable content — zero files written */ }

    const filesWritten: string[] = []
    const newFiles: NewFileCreation[] = []

    // Pre-check existence before writing so new-file detection is accurate.
    // For pre-specified files the isNew flag from fileContexts is authoritative.
    // For AI-determined files (open-ended mode, empty fileContexts) we probe disk now.
    const aiFiles = (parsed.files ?? []).filter(f => isPathAllowed(f.path)).slice(0, TASK_FILE_CAP)
    const preExistenceMap = new Map<string, boolean>()
    for (const fw of aiFiles) {
      if (!fw.content) continue
      const knownCtx = fileContexts.find(fc => fc.path === fw.path)
      if (knownCtx) {
        preExistenceMap.set(fw.path, !knownCtx.isNew)
      } else {
        const exists = await access(join(env.localWorkDir, fw.path)).then(() => true).catch(() => false)
        preExistenceMap.set(fw.path, exists)
      }
    }

    for (const fw of aiFiles) {
      if (!fw.content) continue
      const result = await executor.createFile(env, fw.path, fw.content)
      if (result.success) {
        filesWritten.push(fw.path)
        if (!preExistenceMap.get(fw.path)) {
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

    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: taskIndex,
      eventType: 'task.files_written',
      payload: { taskId: task.id, files: filesWritten, newFileCount: newFiles.length },
    })

    // ── Validate ─────────────────────────────────────────────────────────────
    const validation = await runTaskValidation(db, executor, env, {
      taskId: task.id,
      taskIndex,
      taskFiles,
      baselineTypeErrorSigs,
      preExistingFailedTests,
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
        baselineTypeErrorSigs,
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

  } catch (err) {
    // Release lock on unexpected error so crash recovery doesn't have to wait 10min
    await releaseTaskFailed(db, task.id, err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500))
    throw err
  }
}
