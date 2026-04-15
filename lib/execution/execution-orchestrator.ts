// lib/execution/execution-orchestrator.ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { CodeExecutor } from './executors/code-executor'
import type {
  ExecutionScope, ExecutionLimits,
  BehavioralScope, ExecutionEnvironment,
  NewFileCreation,
} from './types'
import { DEFAULT_LIMITS } from './types'
import { selectTests } from './test-selector'
import { buildTaskImplementationPrompt, buildNewFilePrompt } from './prompt-builders'
import type { TaskFileContext } from './prompt-builders'
import { isPathAllowed } from './repair-guard'
import { makeLogger } from './execution-logger'
import { emitDashboardEvent } from '@/lib/dashboard/event-bus'
import { nextVersion } from '@/lib/dashboard/event-counter'
import { recordEvent } from '@/lib/dashboard/event-history'
import { writeStub, enrichSnapshot, markEnrichmentFailed } from '@/lib/dashboard/snapshot-writer'
import type { DashboardEvent } from '@/lib/dashboard/event-types'
import { runDashboardJobs } from '@/lib/dashboard/jobs/runner'
import { DEFAULT_BUDGET } from './execution-types-v2'
import type { ExecutionBudget, IterationRecord, OutcomeCategory } from './execution-types-v2'
import { insertEvent, clearSeq } from './event-emitter'
import { detectStuck } from './stuck-detector'
import { determineCommitOutcome } from './commit-policy'
import { runInlineRepair } from './inline-repair'
import { runRepairPhase } from './repair-phase'
import { runBaselineRepair, createBaselineBlockedSuggestion } from './baseline-repair'
import type { TestabilityStatus } from './execution-types-v2'
import { createExecutionRun, startHeartbeat, isCancellationRequested, finalizeRun } from './execution-run-manager'
import type { DiagnosticSet, CommitOutcome, ExecutionSummary, ConfidenceDimensions, ConfidenceLabel } from './execution-types-v2'

async function emitAndRecord(
  db: SupabaseClient,
  projectId: string,
  changeId: string,
  analysisVersion: number,
  type: DashboardEvent['type'],
  scope: DashboardEvent['scope'],
  payload: Record<string, unknown>
): Promise<void> {
  const version = await nextVersion(db, projectId)
  const event: DashboardEvent = {
    type, scope, changeId, projectId, analysisVersion, version, payload,
  }
  emitDashboardEvent(projectId, event)
  // fire-and-forget — don't let history write failures block execution
  recordEvent(db, projectId, event).catch(err =>
    console.warn('[dashboard] event_history write failed:', err)
  )
}

async function enrichSnapshotWithRetry(
  db: SupabaseClient,
  projectId: string,
  changeId: string,
  data: Parameters<typeof enrichSnapshot>[2],
  attempts = 3
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await enrichSnapshot(db, changeId, data)
      // Trigger background jobs after successful enrichment
      runDashboardJobs(db, projectId).catch(err =>
        console.warn('[dashboard-jobs] post-enrichment jobs failed:', err)
      )
      return
    } catch (err) {
      if (i === attempts - 1) {
        console.error('[dashboard] enrichment failed after retries:', err)
        await markEnrichmentFailed(db, changeId).catch(() => {})
      } else {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)))
      }
    }
  }
}

function parseAiJson(content: string): Record<string, unknown> {
  // Strip markdown code fences that Claude often wraps JSON in
  const stripped = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim()
  return JSON.parse(stripped)
}

/** Characters-per-prompt cap for file context sent to the AI */
const TASK_FILE_CHAR_CAP = 24_000
/** Max files loaded per task */
const TASK_FILE_CAP = 5

interface PlanTask {
  id: string
  description: string
  order_index: number
  status: string
  files: string[]
}

interface ExecutionState {
  iteration: number
  aiCallCount: number
  startedAt: number
  /** File writes that passed all checks — applied at the start of each iteration */
  acceptedFileWrites: { path: string; content: string }[]
  acceptedNewFiles: NewFileCreation[]
  executionScope: ExecutionScope
  errorHistory: Map<string, number>
  limits: ExecutionLimits
}

async function writeSnapshot(
  db: SupabaseClient,
  changeId: string,
  state: ExecutionState,
  terminationReason: string,
  planDivergence = false,
  testsPassed = 0,
  testsFailed = 0,
  errorSummary: string | null = null,
  filesModified: string[] = []
): Promise<void> {
  await db.from('execution_snapshots').insert({
    change_id: changeId,
    iteration: state.iteration,
    files_modified: filesModified,
    tests_passed: testsPassed,
    tests_failed: testsFailed,
    planned_files: state.executionScope.plannedFiles,
    propagated_files: state.executionScope.addedViaPropagation,
    plan_divergence: planDivergence,
    partial_success: false,
    termination_reason: terminationReason,
    error_summary: errorSummary,
  })
}

export async function runExecution(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider,
  executor: CodeExecutor,
  limits: ExecutionLimits = DEFAULT_LIMITS,
  budget: ExecutionBudget = DEFAULT_BUDGET,
): Promise<void> {
  await db.from('change_requests').update({ status: 'executing' }).eq('id', changeId)

  // Create execution run (concurrency guard)
  const runId = await createExecutionRun(db, changeId)
  if (!runId) {
    console.warn(`[execution-orchestrator] concurrency block: run already active for change ${changeId}`)
    return
  }

  let seqN = 0
  const seq = () => ++seqN
  const heartbeat = startHeartbeat(db, runId)
  let repairsAttempted = 0
  const iterationHistory: IterationRecord[] = []
  let allFilesChanged: string[] = []
  let finalFailureType: string | null = null
  let commitOutcome: CommitOutcome = { type: 'no_commit', reason: 'not started' }
  let runStatus: 'success' | 'wip' | 'budget_exceeded' | 'blocked' | 'cancelled' = 'budget_exceeded'

  let env: ExecutionEnvironment | null = null
  let projectId = ''
  let currentAnalysisVersion = 0

  try {
    // Load change
    const { data: change } = await db
      .from('change_requests')
      .select('id, project_id, title, intent, type, risk_level')
      .eq('id', changeId)
      .single()
    if (!change) throw new Error(`Change not found: ${changeId}`)

    projectId = change.project_id

    // Transition analysis_status to running
    const { data: analysisRow } = await db
      .from('change_requests')
      .select('analysis_version')
      .eq('id', changeId)
      .single()
    currentAnalysisVersion = (analysisRow?.analysis_version ?? 0) + 1

    await db
      .from('change_requests')
      .update({ analysis_status: 'running', analysis_version: currentAnalysisVersion })
      .eq('id', changeId)

    await emitAndRecord(db, projectId, changeId, currentAnalysisVersion, 'started', 'analysis', {})

    // Load approved plan
    const { data: plan } = await db
      .from('change_plans')
      .select('id, status, branch_name, change_id')
      .eq('change_id', changeId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!plan || plan.status !== 'approved') throw new Error('No approved plan found')

    // Load project
    const { data: project } = await db
      .from('projects')
      .select('id, repo_url, repo_token')
      .eq('id', change.project_id)
      .single()
    if (!project) throw new Error('Project not found')
    if (!(project as any).repo_url) throw new Error('No repository configured')
    if (!(project as any).repo_token) throw new Error('No access token configured')

    // Load tasks — ordered by plan's order_index (DB→UI order matches plan intent)
    const { data: rawTasks } = await db
      .from('change_plan_tasks')
      .select('id, description, order_index, status, files')
      .eq('plan_id', plan.id)
      .order('order_index', { ascending: true })
    const allTasks: PlanTask[] = (rawTasks ?? []).map(t => ({
      ...t,
      files: (t.files ?? []) as string[],
    }))

    // Reset any in_progress tasks left over from this run (safe — scoped to runId)
    await db
      .from('change_plan_tasks')
      .update({ status: 'pending', locked_by_run_id: null })
      .eq('plan_id', plan.id)
      .eq('locked_by_run_id', runId)
      .eq('status', 'in_progress')

    const plannedFiles = [...new Set(allTasks.flatMap(t => t.files))]

    const branch = (plan as { branch_name?: string }).branch_name ?? `sf/${changeId.slice(0, 8)}-exec`

    const state: ExecutionState = {
      iteration: 0,
      aiCallCount: 0,
      startedAt: Date.now(),
      acceptedFileWrites: [],
      acceptedNewFiles: [],
      executionScope: { plannedFiles, addedViaPropagation: [] },
      errorHistory: new Map(),
      limits,
    }

    const log = makeLogger(db, changeId, runId, () => state.iteration, seq)

    await log('info', `Cloning ${(project as any).repo_url} into container…`)
    env = await executor.prepareEnvironment(
      { id: project.id, repoUrl: (project as any).repo_url ?? '', repoToken: (project as any).repo_token ?? null },
      branch,
      log,
    )
    await log('success', `Environment ready · branch ${branch}`)

    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: 0,
      eventType: 'execution.started',
      payload: {},
    })

    // Read package.json once so new-file prompts know what imports are available
    let availablePackages: string[] = []
    try {
      const pkgRaw = await readFile(join(env.localWorkDir, 'package.json'), 'utf8')
      const pkg = JSON.parse(pkgRaw)
      availablePackages = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    } catch { /* best-effort */ }

    // ── Baseline test run + repair ────────────────────────────────────────────
    // Run tests before any patches are applied. If infrastructure is broken,
    // attempt repair. Hard-block if it cannot be fixed.
    const baselineTestScope = await selectTests(db, [], (change as { risk_level: string | null }).risk_level ?? 'low')
    const baselineResult = await runBaselineRepair(db, ai, executor, env, runId, changeId, baselineTestScope, log, seq)

    if (baselineResult.status === 'blocked') {
      finalFailureType = `baseline: test infrastructure unresolvable [${baselineResult.category}]`
      await log('error', `Execution blocked — test infrastructure cannot be made testable after ${baselineResult.repairAttempts} repair attempt${baselineResult.repairAttempts !== 1 ? 's' : ''}`)
      await insertEvent(db, { runId, changeId, seq: seq(), iteration: 0, eventType: 'execution.blocked', payload: { reason: finalFailureType } })

      // Create a pinned dashboard suggestion so the user can act on this without hunting through logs
      await createBaselineBlockedSuggestion(db, projectId, changeId, baselineResult.category!)
      await log('info', `Suggestion created on dashboard — go to the project dashboard to create a fix change`)

      throw Object.assign(new Error(finalFailureType), { executionBlocked: true })
    }

    const preExistingFailedTests = baselineResult.preExistingFailedTests
    // When the baseline itself had config errors (now repaired or blocked above),
    // the config error flag is no longer needed — we either fixed it or hard-blocked.
    let testabilityStatus: TestabilityStatus =
      baselineResult.status === 'clean'      ? 'full' :
      baselineResult.status === 'repaired'   ? 'full_repaired' :
      baselineResult.status === 'pre_existing' ? 'partial' : 'full'

    // ── Baseline typecheck snapshot ───────────────────────────────────────────
    // Run tsc on the clean branch (before any patches) to fingerprint errors that
    // already exist in the repo. The repair loop will only act on errors introduced
    // by this change — not on pre-existing repo issues.
    const baselineTscResult = await executor.runTypeCheck(env)
    const baselineTypeErrorSigs = new Set(
      baselineTscResult.errors.map(e => `${e.file}:${e.line}:${e.message}`)
    )
    if (baselineTypeErrorSigs.size > 0) {
      await log('verbose', `Baseline typecheck: ${baselineTypeErrorSigs.size} pre-existing error${baselineTypeErrorSigs.size !== 1 ? 's' : ''} — will be filtered from repair loop`)
      await insertEvent(db, {
        runId, changeId, seq: seq(), iteration: 0,
        eventType: 'baseline.tsc_pre_existing',
        payload: { count: baselineTypeErrorSigs.size },
      })
    }

    // Per-file type-check errors from failed iterations — fed back into the prompt on retry
    const newFileTypeErrors = new Map<string, string>()

    let pendingTasks = allTasks.filter(t => t.status === 'pending')
    let fullSuccess = false
    // Delta tracking for the final summary
    let firstIterationErrorSigs: string[] = []
    let lastIterationErrorSigs: string[] = []

    while (state.iteration < limits.maxIterations && pendingTasks.length > 0) {
      if (Date.now() - state.startedAt > limits.maxDurationMs) break
      if (state.aiCallCount >= limits.maxAiCalls) break

      state.iteration++
      await log('verbose', `── Iteration ${state.iteration} ──`)

      // Emit progress event — pct is a rough estimate based on iteration
      const pct = Math.min(Math.round((state.iteration / limits.maxIterations) * 80), 80)
      await db.from('change_requests').update({
        last_stage_started_at: new Date().toISOString(),
        expected_stage_duration_ms: 120_000, // 2 min per iteration estimate
      }).eq('id', changeId)
      emitAndRecord(db, projectId, changeId, currentAnalysisVersion, 'progress', 'analysis', {
        stage: `iteration_${state.iteration}`,
        pct,
      }).catch(err => console.warn('[dashboard] progress event failed:', err))

      await executor.resetIteration(env, state.acceptedFileWrites)
      for (const nf of state.acceptedNewFiles) {
        await executor.createFile(env, nf.path, nf.content)
      }

      const iterationFileWrites: { path: string; content: string }[] = []
      const iterationNewFiles: NewFileCreation[] = []
      // processedTaskIds: tasks that completed this iteration (used to filter pendingTasks after success)
      const processedTaskIds: string[] = []
      // patchedThisIteration: current on-disk content for files written this iteration.
      // Each task sees the most recent content from earlier tasks in the same iteration.
      const patchedThisIteration = new Map<string, string>()

      await insertEvent(db, {
        runId, changeId, seq: seq(), iteration: state.iteration,
        eventType: 'iteration.started',
        payload: { pendingTaskCount: pendingTasks.length },
      })

      for (const task of pendingTasks) {
        if (state.aiCallCount >= limits.maxAiCalls) break

        await log('verbose', `Task: ${task.description}`)

        // Claim task with run-scoped lock so a crash-restart doesn't re-process in_progress tasks
        await db.from('change_plan_tasks')
          .update({ status: 'in_progress', locked_by_run_id: runId })
          .eq('id', task.id)

        const taskFiles = task.files.filter(isPathAllowed).slice(0, TASK_FILE_CAP)

        // No files listed — nothing for the AI to implement; mark done and continue
        if (taskFiles.length === 0) {
          processedTaskIds.push(task.id)
          await db.from('change_plan_tasks').update({ status: 'done' }).eq('id', task.id)
          await log('verbose', `Done (no files)`)
          continue
        }

        // ── Select file context within token budget ────────────────────────
        const fileContexts: TaskFileContext[] = []
        let charBudget = TASK_FILE_CHAR_CAP

        for (const filePath of taskFiles) {
          // Use in-iteration written content first (idempotency anchor)
          const inMemory = patchedThisIteration.get(filePath)
          if (inMemory !== undefined) {
            const chars = Math.min(inMemory.length, charBudget)
            fileContexts.push({ path: filePath, content: inMemory.slice(0, chars), isNew: false })
            charBudget -= chars
          } else {
            try {
              const raw = await readFile(join(env.localWorkDir, filePath), 'utf8')
              const chars = Math.min(raw.length, charBudget)
              fileContexts.push({ path: filePath, content: raw.slice(0, chars), isNew: false })
              charBudget -= chars
            } catch {
              // File doesn't exist yet — treat as new
              fileContexts.push({ path: filePath, content: '', isNew: true })
            }
          }
          if (charBudget <= 0) break
        }

        const previousErrors = taskFiles
          .map(f => newFileTypeErrors.get(f))
          .filter(Boolean)
          .join('\n')

        const prompt = buildTaskImplementationPrompt(
          { description: task.description, intent: (change as { intent: string }).intent },
          fileContexts,
          previousErrors || undefined,
        )

        state.aiCallCount++
        const aiResult = await ai.complete(prompt, { maxTokens: 8192 })

        let parsed: { files?: { path: string; content: string }[]; confidence?: number } = {}
        try { parsed = parseAiJson(aiResult.content) } catch { /* leave empty */ }

        const confidence = parsed.confidence ?? 0
        const writtenPaths: string[] = []

        for (const fw of (parsed.files ?? []).filter(f => isPathAllowed(f.path)).slice(0, TASK_FILE_CAP)) {
          if (!fw.content) continue
          const result = await executor.createFile(env, fw.path, fw.content)
          if (result.success) {
            iterationFileWrites.push({ path: fw.path, content: fw.content })
            patchedThisIteration.set(fw.path, fw.content)
            writtenPaths.push(fw.path)
          }
        }

        if (writtenPaths.length === 0) {
          await log('verbose', `Task skipped — AI returned no applicable file writes (confidence ${confidence.toFixed(2)})`)
          // Leave in_progress / locked — next iteration will retry
          continue
        }

        processedTaskIds.push(task.id)
        await db.from('change_plan_tasks')
          .update({ status: 'done', locked_by_run_id: null })
          .eq('id', task.id)
        await log('verbose', `Done · wrote ${writtenPaths.join(', ')} (confidence ${confidence.toFixed(2)})`)
      }

      // ── Re-install if package.json changed ────────────────────────────────
      const pkgChanged = [...iterationFileWrites, ...iterationNewFiles].some(
        f => f.path === 'package.json'
      )
      if (pkgChanged) {
        await log('info', 'package.json changed — running npm install…')
        await executor.runInstall(env)
      }

      // ── Static validation phase ─────────────────────────────────────────
      await log('info', `Running static validation…`)
      const svStart = Date.now()
      await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'phase.static_validation.started', payload: {} })

      let typeCheck = await executor.runTypeCheck(env)
      let inlineRepairCount = 0

      // Auto-install missing packages before entering the AI repair loop.
      // "Cannot find module 'X'" errors cannot be fixed by editing TypeScript files —
      // the package simply needs to be installed. Extract unique missing package names
      // and run npm install --save-dev directly, without going through the AI.
      if (!typeCheck.passed) {
        const missingPkgs = [...new Set(
          typeCheck.errors
            .map(e => e.message.match(/Cannot find module '([^']+)' or its corresponding/)?.[1])
            .filter((m): m is string => !!m && !m.startsWith('.') && !m.startsWith('/')
        ))]
        if (missingPkgs.length > 0) {
          await log('info', `Installing missing packages: ${missingPkgs.join(', ')}`)
          await executor.runInstall(env, missingPkgs)
          // package.json and package-lock.json are now modified — include them in
          // allFilesChanged so the commit policy doesn't flag them as unexpected.
          allFilesChanged = [...new Set([...allFilesChanged, 'package.json', 'package-lock.json'])]
          typeCheck = await executor.runTypeCheck(env)
        }
      }

      // Filter out errors that existed in the repo before this change was applied.
      // Only errors introduced by this change should drive the repair loop.
      const filterNewErrors = (errors: typeof typeCheck.errors) =>
        errors.filter(e => !baselineTypeErrorSigs.has(`${e.file}:${e.line}:${e.message}`))

      let newTypeErrors = filterNewErrors(typeCheck.errors)

      if (!typeCheck.passed && newTypeErrors.length === 0) {
        await log('verbose', `Type check: all ${typeCheck.errors.length} error${typeCheck.errors.length !== 1 ? 's' : ''} are pre-existing — not introduced by this change`)
      }

      while (newTypeErrors.length > 0 && inlineRepairCount < budget.perIteration.maxInlineRepairs) {
        const errorCountBefore = newTypeErrors.length
        // Build diagnostic set from new errors only (first 20, truncated flag)
        const allDiags = newTypeErrors.map(e => ({ file: e.file, line: e.line, message: e.message, code: 'TS' }))
        const diagnostics: DiagnosticSet = {
          diagnostics: allDiags.slice(0, 20),
          totalCount: allDiags.length,
          truncated: allDiags.length > 20,
        }
        const errorPreview = allDiags.slice(0, 5).map(d => `  ${d.file}:${d.line} — ${d.message}`).join('\n')
        await log('error', `Type check failed · ${allDiags.length} error${allDiags.length !== 1 ? 's' : ''}\n${errorPreview}`)
        const attempt = await runInlineRepair(db, ai, executor, env, runId, changeId, state.iteration, diagnostics, seq, inlineRepairCount)
        repairsAttempted++
        allFilesChanged = [...new Set([...allFilesChanged, ...attempt.filesPatched])]
        inlineRepairCount++
        typeCheck = await executor.runTypeCheck(env)
        newTypeErrors = filterNewErrors(typeCheck.errors)
        // Regression guard: if the repair introduced new errors, stop immediately.
        // Continuing would compound the damage rather than converge.
        if (newTypeErrors.length > errorCountBefore) {
          await log('error', `Inline repair introduced ${newTypeErrors.length - errorCountBefore} new error${newTypeErrors.length - errorCountBefore !== 1 ? 's' : ''} (${errorCountBefore} → ${newTypeErrors.length}) — stopping repair loop`)
          break
        }
      }

      const svDurationMs = Date.now() - svStart
      if (newTypeErrors.length > 0) {
        const allDiags = newTypeErrors.map(e => ({ file: e.file, line: e.line, message: e.message, code: 'TS' }))
        const diagnosticSigs = allDiags.map(d => `${d.file}:${d.line}:${d.message.slice(0, 40)}`)
        finalFailureType = `tsc: ${allDiags.length} error${allDiags.length !== 1 ? 's' : ''}`
        const finalErrorPreview = allDiags.slice(0, 5).map(d => `  ${d.file}:${d.line} — ${d.message}`).join('\n')
        await log('error', `[iter ${state.iteration}] Type check failed · ${allDiags.length} error${allDiags.length !== 1 ? 's' : ''}\n${finalErrorPreview}`)

        await insertEvent(db, {
          runId, changeId, seq: seq(), iteration: state.iteration,
          eventType: 'phase.static_validation.failed',
          payload: {
            diagnostics: allDiags.slice(0, 20),
            totalCount: allDiags.length,
            truncated: allDiags.length > 20,
            durationMs: svDurationMs,
          },
        })

        // Budget exhausted with errors still remaining — stop before burning another outer iteration.
        if (inlineRepairCount >= budget.perIteration.maxInlineRepairs && newTypeErrors.length > 0) {
          await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'iteration.stuck', payload: { reason: 'max_attempts_reached' } })
          await log('error', `Inline repair budget exhausted (${inlineRepairCount}/${budget.perIteration.maxInlineRepairs} attempts) — ${newTypeErrors.length} error${newTypeErrors.length !== 1 ? 's' : ''} unresolved`)
          break
        }

        const prevSigs = new Set(iterationHistory[iterationHistory.length - 1]?.diagnosticSigs ?? [])
        const resolvedCount = [...prevSigs].filter(s => !diagnosticSigs.includes(s)).length
        const newCount = diagnosticSigs.filter(s => !prevSigs.has(s)).length
        if (iterationHistory.length === 0) firstIterationErrorSigs = diagnosticSigs
        lastIterationErrorSigs = diagnosticSigs
        const currRecord: IterationRecord = { iteration: state.iteration, diagnosticSigs, errorCount: allDiags.length, resolvedCount, newCount, repairedFiles: [] }
        const stuck = detectStuck(iterationHistory, currRecord, budget.perIteration)
        if (stuck.stuck) {
          await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'iteration.stuck', payload: { reason: stuck.reason } })
          await log('error', `Stuck detector fired: ${stuck.reason}`)
          break
        }
        iterationHistory.push(currRecord)
        // Record TSC errors on files written this iteration so the next iteration's prompt
        // includes them as `previousErrors` — the AI can learn from its own mistakes.
        const writtenThisIteration = new Set([
          ...iterationFileWrites.map(fw => fw.path),
          ...iterationNewFiles.map(f => f.path),
        ])
        for (const err of newTypeErrors) {
          if (writtenThisIteration.has(err.file)) {
            const prev = newFileTypeErrors.get(err.file)
            newFileTypeErrors.set(
              err.file,
              (prev ? prev + '\n' : '') + `${err.file}:${err.line} — ${err.message}`,
            )
          }
        }
        await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'iteration.completed', payload: { durationMs: Date.now() - svStart } })
        continue
      }

      await log('success', `Static validation passed${typeCheck.errors.length > 0 ? ` (${typeCheck.errors.length} pre-existing error${typeCheck.errors.length !== 1 ? 's' : ''} in repo, not introduced by this change)` : ''}`)
      await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'phase.static_validation.passed', payload: { durationMs: svDurationMs } })

      // ── Test phases ─────────────────────────────────────────────────────
      const testScope = await selectTests(db, [], (change as { risk_level: string | null }).risk_level ?? 'low')
      const totalTests = testScope.directTests.length + testScope.dependentTests.length

      let snapshotTestsPassed = 0
      let snapshotTestsFailed = 0

      await log('info', `Running ${totalTests > 0 ? totalTests + ' test file' + (totalTests !== 1 ? 's' : '') : 'all tests'}…`)
      await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'phase.unit.started', payload: {} })

      const utStart = Date.now()
      const testResult = await executor.runTests(env, testScope)
      const utDurationMs = Date.now() - utStart

      let repairPhaseCount = 0
      let testsPassed = testResult.passed
      const testRepairFiles: string[] = []

      if (!testResult.passed) {
        // Filter out failures that existed before we applied any patches
        const newFailures = testResult.failures.filter(f => !preExistingFailedTests.has(f.testName))
        const filteredResult = { ...testResult, failures: newFailures, testsFailed: newFailures.length }
        const failureDiags = newFailures.map((f, i) => ({
          file: f.testName, line: i + 1, message: f.error.slice(0, 200), code: 'TEST'
        }))
        const failureSet: DiagnosticSet = {
          diagnostics: failureDiags.slice(0, 20),
          totalCount: failureDiags.length,
          truncated: failureDiags.length > 20,
        }

        // Failure types that carry no actionable diagnostic evidence — repair cannot help
        // NO_TESTS_FOUND is no longer in this set — if the AI was supposed to create tests
        // and they still don't exist after patching, we want the failure to surface clearly
        // (not be silently swallowed) so the user can see what went wrong.
        const NO_EVIDENCE_TYPES = new Set(['INCONSISTENT_TEST_RESULT', 'PARSER_ERROR'])

        // For TEST_CONFIG_ERROR the verbose output contains the exact file + parse error —
        // synthesize a diagnostic so the repair phase can act on it (e.g. rename .js→.ts or strip TS syntax)
        if (testResult.failureType === 'TEST_CONFIG_ERROR' && failureDiags.length === 0 && testResult.raw?.stdout) {
          // Strip ANSI escape codes before parsing — vitest colours the caret line which breaks regexes
          // eslint-disable-next-line no-control-regex
          const verboseOut = testResult.raw.stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
          // Extract lines like: Cannot parse /app/path/to/file.js:
          const fileMatch = verboseOut.match(/Cannot parse ([^\n:]+):/)
          if (fileMatch) {
            const filePath = fileMatch[1]!.trim().replace(/^\/app\//, '')
            // Find the error line number from the caret context: "17: interface UserProfile {\n             ^"
            const lineMatch = verboseOut.match(/(\d+):[^\n]*\n[^\n]*\^/)
            const lineNum = lineMatch ? parseInt(lineMatch[1]!) : 1
            // Grab the one-line error description ("Expected a semicolon…")
            const errMatch = verboseOut.match(/Parse failed[^\n]*\n([^\n]+)/)
            const errMsg = errMatch ? errMatch[1]!.trim() : 'Parse error in test file'
            failureDiags.push({ file: filePath, line: lineNum, message: errMsg, code: 'PARSE' })
            failureSet.diagnostics = failureDiags.slice(0, 20)
            failureSet.totalCount = failureDiags.length
          }
        }

        // For TEST_TIMEOUT with 0 failures: tests hung before producing output (missing mocks,
        // async I/O that never resolves, etc.). Synthesize a diagnostic for each in-scope test
        // file so the repair phase can add vi.mock() and other guards.
        if (filteredResult.failureType === 'TEST_TIMEOUT' && failureDiags.length === 0) {
          const progressNote = filteredResult.raw?.progressNote
          const timeoutPrefix = progressNote
            ? `Timed out after 120s. ${progressNote}.`
            : 'Timed out after 120s.'
          const timeoutFiles = [...testScope.directTests, ...testScope.dependentTests].slice(0, 5)
          for (const tf of timeoutFiles) {
            failureDiags.push({
              file: tf,
              line: 1,
              message: `${timeoutPrefix} Likely missing vi.mock() for external I/O. Mock all async external dependencies (Supabase client, fetch, network calls, database).`,
              code: 'TIMEOUT',
            })
          }
          failureSet.diagnostics = failureDiags.slice(0, 20)
          failureSet.totalCount = failureDiags.length
        }

        const hasActionableEvidence = failureDiags.length > 0 && !NO_EVIDENCE_TYPES.has(filteredResult.failureType ?? '')

        const failureLabel = filteredResult.failureType
          ? `${filteredResult.testsFailed} failed [${filteredResult.failureType}]`
          : `${filteredResult.testsFailed} failed`

        await insertEvent(db, {
          runId, changeId, seq: seq(), iteration: state.iteration,
          eventType: 'phase.unit.failed',
          payload: {
            diagnostics: failureSet.diagnostics,
            totalCount: failureSet.totalCount,
            truncated: failureSet.truncated,
            durationMs: utDurationMs,
            failureType: filteredResult.failureType,
          },
        })

        if (!hasActionableEvidence) {
          await log('error', `Tests failed · ${failureLabel}`)
          if (filteredResult.failureType === 'INCONSISTENT_TEST_RESULT') {
            await log('error', `Inconsistent result — vitest exited non-zero but reported 0 failures. Verbose output:\n${(filteredResult.raw?.stdout ?? '').slice(0, 1000)}`)
          } else if (filteredResult.failureType === 'PARSER_ERROR') {
            await log('error', `Test runner output could not be parsed (exit ${filteredResult.raw?.exitCode ?? '?'}). Raw output:\n${(filteredResult.raw?.stdout ?? filteredResult.output).slice(0, 1000)}`)
          } else {
            await log('error', `No actionable diagnostics (${filteredResult.failureType ?? 'unknown'}) — skipping repair`)
          }
          finalFailureType = `tests: ${failureLabel}`
          await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'iteration.stuck', payload: { reason: 'no_actionable_evidence', failureType: filteredResult.failureType } })
          break
        }

        while (!testsPassed && repairPhaseCount < budget.perIteration.maxRepairPhaseAttempts) {
          await log('error', `Tests failed · ${failureLabel}`)
          const attempt = await runRepairPhase(db, ai, executor, env, runId, changeId, state.iteration, failureSet, (change as { intent: string | null }).intent ?? '', seq, repairPhaseCount, filteredResult.failureType)
          repairsAttempted++
          allFilesChanged = [...new Set([...allFilesChanged, ...attempt.filesPatched])]
          testRepairFiles.push(...attempt.filesPatched)
          repairPhaseCount++
          // Skip retest when the repair produced no patches — nothing changed, tests cannot pass
          if (attempt.filesPatched.length === 0) break
          const retest = await executor.runTests(env, testScope)
          const retestNewFailures = retest.failures.filter(f => !preExistingFailedTests.has(f.testName))
          testsPassed = retest.passed || retestNewFailures.length === 0
          if (testsPassed) break
        }

        if (!testsPassed) {
          finalFailureType = `tests: ${failureLabel}`

          // If all repair attempts produced zero patches the AI cannot generate a fix —
          // escalate to stuck immediately rather than burning more iterations.
          if (repairPhaseCount > 0 && testRepairFiles.length === 0) {
            await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'iteration.stuck', payload: { reason: 'no_diff_after_repair' } })
            await log('error', 'Stuck: repair phase produced no patches — AI cannot fix this failure')
            break
          }

          // Repair produced patches but tests still time out after all attempts — we've exhausted
          // the evidence available. Further iteration cannot converge.
          if (
            repairPhaseCount >= budget.perIteration.maxRepairPhaseAttempts &&
            testRepairFiles.length > 0 &&
            filteredResult.failureType === 'TEST_TIMEOUT'
          ) {
            await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'iteration.stuck', payload: { reason: 'timeout_no_evidence' } })
            await log('error', `Stuck: tests still timing out after ${repairPhaseCount} repair attempt${repairPhaseCount !== 1 ? 's' : ''} — no further evidence available`)
            break
          }

          // Build diagnostic signatures from filtered (new) failures only
          const testDiagSigs = newFailures.map(
            (f: { testName: string; error: string }) => `test:${f.testName}:${f.error.slice(0, 60)}`
          )
          const testPrevSigs = new Set(iterationHistory[iterationHistory.length - 1]?.diagnosticSigs ?? [])
          const testResolvedCount = [...testPrevSigs].filter(s => !testDiagSigs.includes(s)).length
          const testNewCount = testDiagSigs.filter(s => !testPrevSigs.has(s)).length
          if (iterationHistory.length === 0) firstIterationErrorSigs = testDiagSigs
          lastIterationErrorSigs = testDiagSigs
          const currRecord: IterationRecord = {
            iteration: state.iteration,
            diagnosticSigs: testDiagSigs,
            errorCount: newFailures.length,
            resolvedCount: testResolvedCount,
            newCount: testNewCount,
            repairedFiles: [...new Set(testRepairFiles)],
          }
          const stuck = detectStuck(iterationHistory, currRecord, budget.perIteration)
          if (stuck.stuck) {
            await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'iteration.stuck', payload: { reason: stuck.reason } })
            await log('error', `Stuck detector fired: ${stuck.reason}`)
            break
          }
          iterationHistory.push(currRecord)
          await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'iteration.completed', payload: { durationMs: Date.now() - utStart } })
          continue
        }
      }

      snapshotTestsPassed = testResult.testsPassed
      snapshotTestsFailed = testResult.testsFailed
      await log('success', `Tests passed`)
      await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'phase.unit.passed', payload: { durationMs: utDurationMs } })

      // ── Behavioral checks ─────────────────────────────────────────────────
      const behavioralScope: BehavioralScope = {
        patches: [],
        criticalComponentTouched: iterationFileWrites.some(fw =>
          /migration|auth|supabase/.test(fw.path)
        ),
      }
      const behavResult = await executor.runBehavioralChecks(env, behavioralScope)
      if (!behavResult.passed) {
        const anomalyMsg = behavResult.anomalies.map(a => `[${a.severity}] ${a.description}`).join('\n')
        await log('error', `Behavioral check failed\n${anomalyMsg}`)
        finalFailureType = 'behavioral: ' + behavResult.anomalies[0]?.description?.slice(0, 80)
        await writeSnapshot(db, changeId, state, 'error', false, 0, 0, anomalyMsg.slice(0, 8000))
        continue
      }

      // All checks passed for this iteration
      state.acceptedFileWrites.push(...iterationFileWrites)
      state.acceptedNewFiles.push(...iterationNewFiles)
      allFilesChanged = [...new Set([...allFilesChanged, ...iterationFileWrites.map(fw => fw.path), ...iterationNewFiles.map(f => f.path)])]

      await writeSnapshot(
        db, changeId, state, 'passed', false,
        snapshotTestsPassed, snapshotTestsFailed, null,
        allFilesChanged
      )

      await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'iteration.completed', payload: { durationMs: Date.now() - svStart } })

      pendingTasks = pendingTasks.filter(t => !processedTaskIds.includes(t.id))
      if (pendingTasks.length === 0) {
        fullSuccess = true
        break
      }

      // Check cancellation at iteration boundary
      if (await isCancellationRequested(db, runId)) {
        await log('info', 'Cancellation requested — stopping after iteration boundary')
        runStatus = 'cancelled'
        break
      }
    }

    // ── Commit policy ─────────────────────────────────────────────────────────
    const cancelled = runStatus === 'cancelled'
    let hasDiff = false
    try {
      const diff = await executor.getDiff(env!)
      hasDiff = (diff?.filesChanged?.length ?? 0) > 0
    } catch { /* treat as no diff */ }

    // Check dirty tree
    let dirtyFiles: string[] = []
    try {
      const { exec } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execAsync = promisify(exec)
      const { stdout } = await execAsync('git status --porcelain', { cwd: env!.localWorkDir })
      dirtyFiles = stdout.split('\n').filter(Boolean).map(l => l.slice(3).trim())
    } catch { /* ignore */ }

    commitOutcome = determineCommitOutcome({
      allChecksPassed: fullSuccess,
      hasDiff,
      cancelled,
      dirtyFiles,
      runFilesChanged: allFilesChanged,
      finalFailureType,
    })

    if (commitOutcome.type === 'green' || commitOutcome.type === 'wip') {
      try {
        const commitMsg = commitOutcome.type === 'green'
          ? `feat: ${(change as { title: string }).title} (${changeId.slice(0, 8)})`
          : `wip: ${(change as { title: string }).title} (${finalFailureType ?? 'checks failed'})`

        await log('info', `Committing → ${branch} [${commitOutcome.type}]`)
        const commitResult = await executor.commitAndPush(env!, branch, commitMsg)
        await db.from('change_commits').insert({
          change_id: changeId,
          branch_name: commitResult.branch,
          commit_hash: commitResult.commitHash,
        })
        await log('success', `Committed ${commitResult.commitHash.slice(0, 7)} → ${commitResult.branch}`)
        await insertEvent(db, {
          runId, changeId, seq: seq(), iteration: state.iteration,
          eventType: commitOutcome.type === 'green' ? 'commit.green' : 'commit.wip',
          payload: commitOutcome.type === 'wip' ? { reason: commitOutcome.reason, durationMs: 0 } : { durationMs: 0 },
        })
      } catch (commitErr) {
        await log('error', `Commit failed: ${(commitErr as Error).message}`)
        await insertEvent(db, { runId, changeId, seq: seq(), iteration: state.iteration, eventType: 'commit.failed', payload: { reason: (commitErr as Error).message, durationMs: 0 } })
        commitOutcome = { type: 'no_commit', reason: 'git error' }
      }
    } else {
      const skipReason = commitOutcome.type === 'no_commit' ? commitOutcome.reason : 'cancelled'
      await log('info', `Commit skipped: ${skipReason}`)
      await insertEvent(db, {
        runId, changeId, seq: seq(), iteration: state.iteration,
        eventType: 'commit.skipped',
        payload: { reason: skipReason, durationMs: 0 },
      })
    }

    // Determine final run status
    if (!cancelled) {
      if (fullSuccess) runStatus = 'success'
      else if (commitOutcome.type === 'wip') runStatus = 'wip'
      else runStatus = 'budget_exceeded'
    }

    // ── Outcome category — more nuanced than pass/fail ────────────────────────
    // partial_success: files were generated and some errors resolved, but validation still failing
    const resolvedErrors = firstIterationErrorSigs.filter(s => !lastIterationErrorSigs.includes(s))
    const unresolvedErrors = lastIterationErrorSigs
    const hadPartialProgress = allFilesChanged.length > 0 && resolvedErrors.length > 0 && unresolvedErrors.length > 0
    const outcomeCategory: OutcomeCategory =
      cancelled          ? 'cancelled'
      : fullSuccess      ? 'success'
      : hadPartialProgress ? 'partial_success'
      : 'failure'

    // ── Iteration delta table (for logs) ─────────────────────────────────────
    const deltaRows = iterationHistory.map(r =>
      `  Iter ${r.iteration}   resolved=${r.resolvedCount}   new=${r.newCount}   remaining=${r.errorCount}`
    ).join('\n')

    // ── Confidence dimensions ─────────────────────────────────────────────────
    // Classify files: test files have .test. or .spec. in the name
    const isTestFile = (f: string) => /\.test\.|\.spec\./.test(f)
    const featureFilesChanged = allFilesChanged.filter(f => !isTestFile(f))
    const unresolvedOnFeatureFiles = unresolvedErrors.filter(s => !isTestFile(s.split(':')[0] ?? ''))
    const unresolvedOnTestFiles    = unresolvedErrors.filter(s =>  isTestFile(s.split(':')[0] ?? ''))

    // Feature generation: did the agent produce feature files and are they type-clean?
    const featureGeneration: ConfidenceLabel =
      featureFilesChanged.length > 0 && unresolvedOnFeatureFiles.length === 0 ? 'high'
      : featureFilesChanged.length > 0 ? 'medium'
      : 'low'

    // Type safety: clean if no unresolved errors; medium if only test files have errors
    const typeSafety: ConfidenceLabel =
      unresolvedErrors.length === 0 ? 'high'
      : unresolvedOnFeatureFiles.length === 0 ? 'medium'  // only test-file errors remain
      : 'low'

    // Test validity: did tests pass or at least run cleanly?
    const testValidity: ConfidenceLabel =
      fullSuccess ? 'high'
      : testabilityStatus === 'partial' ? 'medium'
      : 'low'

    const confidenceCounts = [featureGeneration, typeSafety, testValidity]
    const highCount = confidenceCounts.filter(c => c === 'high').length
    const lowCount  = confidenceCounts.filter(c => c === 'low').length
    const overall: ConfidenceLabel =
      highCount >= 3 ? 'high' : lowCount >= 2 ? 'low' : 'medium'

    const confidence: ConfidenceDimensions = {
      featureGeneration, typeSafety, testValidity, overall,
    }

    const testabilityLabel =
      testabilityStatus === 'full'          ? 'full'                             :
      testabilityStatus === 'full_repaired' ? 'full (baseline was repaired)'     :
      testabilityStatus === 'partial'       ? 'partial (pre-existing failures filtered)' :
                                              'blocked (test infrastructure unresolvable)'

    await log('verbose', [
      `Feature generation:  ${featureGeneration.toUpperCase()}`,
      `Type safety:         ${typeSafety.toUpperCase()}`,
      `Test validity:       ${testValidity.toUpperCase()}  [testability: ${testabilityLabel}]`,
      `Overall confidence:  ${overall.toUpperCase()}`,
      ...(deltaRows ? [`\nIteration deltas:\n${deltaRows}`] : []),
    ].join('\n'))

    // ── Final summary log ─────────────────────────────────────────────────────
    if (fullSuccess) {
      await log('success', [
        'Execution complete — ready for review',
        `Confidence: feature generation ${featureGeneration} · type safety ${typeSafety} · test validity ${testValidity}`,
      ].join('\n'))
    } else if (outcomeCategory === 'partial_success') {
      const resolvedLines = resolvedErrors.map(s => `  ✓ ${s.split(':').slice(2).join(':').slice(0, 80)}`).join('\n')
      const unresolvedLines = unresolvedErrors.map(s => `  ✗ ${s.split(':').slice(2).join(':').slice(0, 80)}`).join('\n')
      // Surface what's clean vs broken
      const featureNote = unresolvedOnFeatureFiles.length === 0 && featureFilesChanged.length > 0
        ? 'Feature code is type-clean.'
        : unresolvedOnFeatureFiles.length > 0
          ? `Feature files still have ${unresolvedOnFeatureFiles.length} type error${unresolvedOnFeatureFiles.length !== 1 ? 's' : ''}.`
          : ''
      const testNote = unresolvedOnTestFiles.length > 0
        ? `Test scaffolding has ${unresolvedOnTestFiles.length} remaining error${unresolvedOnTestFiles.length !== 1 ? 's' : ''}.`
        : ''
      await log('error', [
        `Execution stopped after ${state.iteration} iteration${state.iteration !== 1 ? 's' : ''} — partial progress.`,
        resolvedErrors.length > 0 ? `\nResolved (${resolvedErrors.length}):\n${resolvedLines}` : '',
        unresolvedErrors.length > 0 ? `\nUnresolved (${unresolvedErrors.length}):\n${unresolvedLines}` : '',
        [featureNote, testNote].filter(Boolean).length > 0
          ? `\nAssessment: ${[featureNote, testNote].filter(Boolean).join(' ')}`
          : '',
        `\nConfidence: feature generation ${featureGeneration} · type safety ${typeSafety} · test validity ${testValidity}`,
      ].filter(Boolean).join(''))
    } else {
      // Pure failure — still report how far we got
      const featureNote = featureFilesChanged.length > 0
        ? `Generated ${featureFilesChanged.length} feature file${featureFilesChanged.length !== 1 ? 's' : ''}.`
        : 'No feature files generated.'
      await log('error', [
        `Execution failed: ${finalFailureType ?? 'budget exceeded'}`,
        `${featureNote}`,
        `Confidence: feature generation ${featureGeneration} · type safety ${typeSafety} · test validity ${testValidity}`,
      ].join('\n'))
    }

    const executionOutcome: 'success' | 'failure' = fullSuccess ? 'success' : 'failure'

    const summary: ExecutionSummary = {
      status: runStatus,
      outcomeCategory,
      iterationsUsed: state.iteration,
      repairsAttempted,
      filesChanged: allFilesChanged,
      finalFailureType,
      commitOutcome,
      durationMs: Date.now() - state.startedAt,
      testabilityStatus,
      resolvedErrors,
      unresolvedErrors,
      confidence,
    }

    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: state.iteration,
      eventType: 'execution.completed',
      payload: { summary },
    })

    clearInterval(heartbeat)
    clearSeq(runId)
    await finalizeRun(db, runId, runStatus, summary).catch(err =>
      console.error('[execution-orchestrator] finalizeRun failed:', err)
    )

    // Write stub (existing dashboard compat)
    let completionVersion: number | null = null
    try {
      completionVersion = await nextVersion(db, projectId)
      await writeStub(db, changeId, completionVersion, executionOutcome, 'completed')
    } catch (stubErr) {
      console.error('[dashboard] stub write failed — updating status anyway:', stubErr)
    }

    await db.from('change_requests')
      .update({ status: fullSuccess ? 'review' : 'failed', analysis_status: 'completed' })
      .eq('id', changeId)

    if (completionVersion === null) return

    const completedEvent: DashboardEvent = {
      type: 'completed', scope: 'analysis',
      changeId, projectId,
      analysisVersion: currentAnalysisVersion,
      version: completionVersion,
      payload: { outcome: executionOutcome },
    }
    emitDashboardEvent(projectId, completedEvent)
    recordEvent(db, projectId, completedEvent).catch(() => {})

    const filesModified = allFilesChanged
    enrichSnapshotWithRetry(db, projectId, changeId, {
      stagesCompleted: [`iteration_${state.iteration}`],
      filesModified,
      componentsAffected: [],
      durationMs: Date.now() - state.startedAt,
    }).catch(() => {})

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    const isBlocked = (err as { executionBlocked?: boolean }).executionBlocked === true
    await db.from('execution_snapshots').insert({
      change_id: changeId,
      iteration: 0,
      files_modified: [],
      tests_passed: 0,
      tests_failed: 0,
      planned_files: [],
      propagated_files: [],
      plan_divergence: false,
      partial_success: false,
      termination_reason: isBlocked ? 'blocked' : 'error',
      error_summary: errorMessage,
    })
    await db.from('change_requests').update({ status: 'failed', analysis_status: isBlocked ? 'stalled' : 'failed' }).eq('id', changeId)
    clearInterval(heartbeat)
    clearSeq(runId)
    await finalizeRun(db, runId, 'blocked', {
      status: 'blocked',
      outcomeCategory: 'blocked' as const,
      iterationsUsed: 0,
      repairsAttempted: 0,
      filesChanged: [],
      finalFailureType: errorMessage,
      commitOutcome: { type: 'no_commit', reason: 'error' },
      durationMs: 0,
      testabilityStatus: 'blocked' as const,
      resolvedErrors: [],
      unresolvedErrors: [],
      confidence: { featureGeneration: 'low', typeSafety: 'low', testValidity: 'low', overall: 'low' },
    }).catch(() => {})
    // Emit failed event if we have projectId (it may not be set if failure was before loading change)
    if (projectId) {
      try {
        const failVersion = await nextVersion(db, projectId)
        await writeStub(db, changeId, failVersion, 'failure', 'failed')
        const failEvent: DashboardEvent = {
          type: 'completed', scope: 'analysis',
          changeId, projectId,
          analysisVersion: currentAnalysisVersion,
          version: failVersion,
          payload: { outcome: 'failure' },
        }
        emitDashboardEvent(projectId, failEvent)
        recordEvent(db, projectId, failEvent).catch(() => {})
      } catch {
        // best-effort — don't mask the original error
      }
    }
    throw err
  } finally {
    if (env) await executor.cleanup(env)
  }
}
