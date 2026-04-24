// lib/execution/execution-orchestrator.ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { CodeExecutor } from './executors/code-executor'
import type {
  ExecutionScope, ExecutionLimits,
  ExecutionEnvironment,
  NewFileCreation,
} from './types'
import { DEFAULT_LIMITS } from './types'
import { selectTests } from './test-selector'
import { makeLogger } from './execution-logger'
import { emitDashboardEvent } from '@/lib/dashboard/event-bus'
import { nextVersion } from '@/lib/dashboard/event-counter'
import { recordEvent } from '@/lib/dashboard/event-history'
import { writeStub, enrichSnapshot, markEnrichmentFailed } from '@/lib/dashboard/snapshot-writer'
import type { DashboardEvent } from '@/lib/dashboard/event-types'
import { runDashboardJobs } from '@/lib/dashboard/jobs/runner'
import { DEFAULT_BUDGET, DEFAULT_TASK_BUDGET } from './execution-types-v2'
import type { ExecutionBudget, IterationRecord, OutcomeCategory, TaskBudget } from './execution-types-v2'
import { insertEvent, clearSeq } from './event-emitter'
import { determineCommitOutcome } from './commit-policy'
import { runBaselineRepair, createBaselineBlockedSuggestion } from './baseline-repair'
import type { TestabilityStatus } from './execution-types-v2'
import { createExecutionRun, startHeartbeat, isCancellationRequested, finalizeRun } from './execution-run-manager'
import type { CommitOutcome, ExecutionSummary, ConfidenceDimensions, ConfidenceLabel } from './execution-types-v2'
import { crashRecoveryCleanup, markTaskBlocked } from './task-locker'
import { runTask } from './task-runner'
import { computeTaskRunSummary } from './execution-summary'

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

export async function runExecution(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider,
  executor: CodeExecutor,
  limits: ExecutionLimits = DEFAULT_LIMITS,
  budget: ExecutionBudget = DEFAULT_BUDGET,
  taskBudget: TaskBudget = DEFAULT_TASK_BUDGET,
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
      .select('id, project_id, title, intent, type, risk_level, review_feedback')
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

    // Load tasks — ordered by plan's order_index
    const { data: rawTasks } = await db
      .from('change_plan_tasks')
      .select('id, description, order_index, status, files, dependencies')
      .eq('plan_id', plan.id)
      .order('order_index', { ascending: true })
    const allTasks = (rawTasks ?? []).map(t => ({
      id: t.id as string,
      description: t.description as string,
      order_index: t.order_index as number,
      status: t.status as string,
      files: (t.files ?? []) as string[],
      dependencies: (t.dependencies ?? []) as string[],
    }))

    // Crash recovery: release zombie tasks from dead processes
    await crashRecoveryCleanup(db)

    const plannedFiles = [...new Set(allTasks.flatMap(t => t.files))]
    const branch = (plan as { branch_name?: string }).branch_name ?? `sf/${changeId.slice(0, 8)}-exec`

    const startedAt = Date.now()
    let aiCallCount = 0
    const acceptedFileWrites: { path: string; content: string }[] = []
    const acceptedNewFiles: NewFileCreation[] = []
    const executionScope: ExecutionScope = { plannedFiles, addedViaPropagation: [] }
    let fullSuccess = false
    const firstIterationErrorSigs: string[] = []
    const lastIterationErrorSigs: string[] = []

    const log = makeLogger(db, changeId, runId, () => 0, seq)

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

    // Read package.json for context (best-effort)
    let availablePackages: string[] = []
    try {
      const pkgRaw = await readFile(join(env.localWorkDir, 'package.json'), 'utf8')
      const pkg = JSON.parse(pkgRaw)
      availablePackages = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    } catch { /* best-effort */ }

    // ── Baseline checks (unchanged) ───────────────────────────────────────────
    const baselineTestScope = await selectTests(db, [], (change as { risk_level: string | null }).risk_level ?? 'low')
    const baselineResult = await runBaselineRepair(db, ai, executor, env, runId, changeId, baselineTestScope, log, seq)

    if (baselineResult.status === 'blocked') {
      finalFailureType = `baseline: test infrastructure unresolvable [${baselineResult.category}]`
      await log('error', `Execution blocked — test infrastructure cannot be made testable after ${baselineResult.repairAttempts} repair attempt${baselineResult.repairAttempts !== 1 ? 's' : ''}`)
      await insertEvent(db, { runId, changeId, seq: seq(), iteration: 0, eventType: 'execution.blocked', payload: { reason: finalFailureType } })
      await createBaselineBlockedSuggestion(db, projectId, changeId, baselineResult.category!)
      await log('info', `Suggestion created on dashboard — go to the project dashboard to create a fix change`)
      throw Object.assign(new Error(finalFailureType), { executionBlocked: true })
    }

    const preExistingFailedTests = baselineResult.preExistingFailedTests
    let testabilityStatus: TestabilityStatus =
      baselineResult.status === 'clean'        ? 'full' :
      baselineResult.status === 'repaired'     ? 'full_repaired' :
      baselineResult.status === 'pre_existing' ? 'partial' : 'full'

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

    // ── Task loop ─────────────────────────────────────────────────────────────
    await log('info', `Execution started — ${allTasks.length} task(s)`)

    const doneById = new Map<string, boolean>()  // taskId → success

    for (const task of allTasks) {
      // Skip already-terminal tasks (from a previous partial run)
      if (task.status === 'done') { doneById.set(task.id, true); continue }
      if (['blocked', 'skipped', 'cancelled'].includes(task.status)) continue
      if (task.status === 'failed') continue  // re-run only if retriggered

      // Dependency check: block if any dependency is not done
      const failedDep = task.dependencies.find(depId => {
        const depTask = allTasks.find(t => t.id === depId)
        return !depTask || (!doneById.get(depId) && depTask.status !== 'done')
      })
      if (failedDep) {
        await markTaskBlocked(db, task.id, failedDep)
        await insertEvent(db, {
          runId, changeId, seq: seq(), iteration: task.order_index,
          eventType: 'task.blocked',
          payload: { taskId: task.id, blockedByTaskId: failedDep },
        })
        await log('info', `Task ${task.order_index + 1} blocked — dependency ${failedDep} not done`)
        continue
      }

      // Check cancellation at task boundary
      if (await isCancellationRequested(db, runId)) {
        runStatus = 'cancelled'
        break
      }

      // Re-apply accepted patches to restore clean branch state before this task
      await executor.resetIteration(env, acceptedFileWrites)
      for (const nf of acceptedNewFiles) {
        await executor.createFile(env, nf.path, nf.content)
      }

      await log('verbose', `Task ${task.order_index + 1}/${allTasks.length}: ${task.description}`)

      const result = await runTask(task, env, db, ai, executor, {
        runId,
        changeId,
        changeIntent: (change as { intent: string }).intent,
        reviewFeedback: (change as { review_feedback?: string | null }).review_feedback,
        taskIndex: task.order_index,
        baselineTypeErrorSigs,
        preExistingFailedTests,
        budget: taskBudget,
        seq,
      })

      aiCallCount++

      if (result.success) {
        doneById.set(task.id, true)
        // Read final disk content so subsequent tasks and the commit see it
        for (const path of result.filesWritten) {
          try {
            const content = await readFile(join(env.localWorkDir, path), 'utf8')
            const existing = acceptedFileWrites.findIndex(fw => fw.path === path)
            if (existing >= 0) {
              acceptedFileWrites[existing]!.content = content
            } else {
              acceptedFileWrites.push({ path, content })
            }
          } catch { /* file not readable — skip tracking */ }
        }
        acceptedNewFiles.push(...result.newFiles)
        allFilesChanged = [...new Set([...allFilesChanged, ...result.filesWritten])]
        await log('success', `Task ${task.order_index + 1} done`)
      } else {
        await log('error', `Task ${task.order_index + 1} failed`)
        finalFailureType = `task_${task.order_index + 1}: ${task.description.slice(0, 60)}`
      }

      // Duration limit
      if (Date.now() - startedAt > limits.maxDurationMs) break
    }

    // Reload task statuses for summary (DB is source of truth)
    const { data: finalTaskRows } = await db
      .from('change_plan_tasks')
      .select('id, status')
      .eq('plan_id', plan.id)
    const taskSummary = computeTaskRunSummary(finalTaskRows ?? [], Date.now() - startedAt)
    fullSuccess = taskSummary.finalStatus === 'success'

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
          runId, changeId, seq: seq(), iteration: 0,
          eventType: commitOutcome.type === 'green' ? 'commit.green' : 'commit.wip',
          payload: commitOutcome.type === 'wip' ? { reason: commitOutcome.reason, durationMs: 0 } : { durationMs: 0 },
        })
      } catch (commitErr) {
        await log('error', `Commit failed: ${(commitErr as Error).message}`)
        await insertEvent(db, { runId, changeId, seq: seq(), iteration: 0, eventType: 'commit.failed', payload: { reason: (commitErr as Error).message, durationMs: 0 } })
        commitOutcome = { type: 'no_commit', reason: 'git error' }
      }
    } else {
      const skipReason = commitOutcome.type === 'no_commit' ? commitOutcome.reason : 'cancelled'
      await log('info', `Commit skipped: ${skipReason}`)
      await insertEvent(db, {
        runId, changeId, seq: seq(), iteration: 0,
        eventType: 'commit.skipped',
        payload: { reason: skipReason, durationMs: 0 },
      })
    }

    // Determine final run status from task summary
    if (!cancelled) {
      if (taskSummary.finalStatus === 'success') runStatus = 'success'
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
        `Execution stopped after ${allTasks.length} task${allTasks.length !== 1 ? 's' : ''} — partial progress.`,
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
      iterationsUsed: allTasks.length,
      repairsAttempted: 0,
      filesChanged: allFilesChanged,
      finalFailureType,
      commitOutcome,
      durationMs: Date.now() - startedAt,
      testabilityStatus,
      resolvedErrors,
      unresolvedErrors,
      confidence,
      taskRunSummary: taskSummary,
    }

    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: 0,
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
      stagesCompleted: [`iteration_${allTasks.length}`],
      filesModified,
      componentsAffected: [],
      durationMs: Date.now() - startedAt,
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
      durationMs: typeof startedAt !== 'undefined' ? Date.now() - startedAt : 0,
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
