// lib/execution/execution-orchestrator.ts
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Project } from 'ts-morph'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { CodeExecutor } from './executors/code-executor'
import type {
  FilePatch, SymbolContext, ExecutionScope, ExecutionLimits,
  ContextMode, TestScope, BehavioralScope, ExecutionEnvironment,
  NewFileCreation,
} from './types'
import { DEFAULT_LIMITS } from './types'
import { extractSymbol } from './symbol-extractor'
import { validatePatch } from './patch-validator'
import { selectTests } from './test-selector'
import { hashInput, hashOutput, recordTrace } from './execution-tracer'
import { buildSymbolPatchPrompt, buildFilePatchPrompt, buildNewFilePrompt } from './prompt-builders'
import { makeLogger } from './execution-logger'
import { emitDashboardEvent } from '@/lib/dashboard/event-bus'
import { nextVersion } from '@/lib/dashboard/event-counter'
import { recordEvent } from '@/lib/dashboard/event-history'
import { writeStub, enrichSnapshot, markEnrichmentFailed } from '@/lib/dashboard/snapshot-writer'
import type { DashboardEvent } from '@/lib/dashboard/event-types'
import { runDashboardJobs } from '@/lib/dashboard/jobs/runner'

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

function errorSignature(output: string): string {
  return createHash('sha256').update(output.slice(0, 500)).digest('hex').slice(0, 12)
}

function parseAiJson(content: string): Record<string, unknown> {
  // Strip markdown code fences that Claude often wraps JSON in
  const stripped = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim()
  return JSON.parse(stripped)
}

function chooseContextMode(ctx: SymbolContext, limits: ExecutionLimits): ContextMode {
  if (ctx.complexity > limits.symbolComplexityHighThreshold) return 'file'
  if (ctx.complexity < limits.symbolComplexityLowThreshold) return 'symbol'
  return 'multi-symbol'
}

const COMPONENT_DEPTH: Record<string, number> = {
  ui: 0, component: 1, module: 2, api: 3, service: 4, auth: 5, repository: 6, db: 7,
}

interface PlanTask {
  id: string
  component_id: string | null
  description: string
  order_index: number
  status: string
  new_file_path: string | null
}

interface ExecutionState {
  iteration: number
  aiCallCount: number
  startedAt: number
  acceptedPatches: FilePatch[]
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
  limits: ExecutionLimits = DEFAULT_LIMITS
): Promise<void> {
  await db.from('change_requests').update({ status: 'executing' }).eq('id', changeId)

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

    // Load tasks
    const { data: rawTasks } = await db
      .from('change_plan_tasks')
      .select('id, component_id, description, order_index, status, new_file_path')
      .eq('plan_id', plan.id)
      .order('order_index', { ascending: true })
    const allTasks: PlanTask[] = rawTasks ?? []

    // Load impacted components for ordering
    const componentTypeMap: Record<string, string> = {}
    const componentFileMap: Record<string, string[]> = {}

    const { data: impact } = await db
      .from('change_impacts')
      .select('id')
      .eq('change_id', changeId)
      .maybeSingle()

    if (impact) {
      const { data: impactComponents } = await db
        .from('change_impact_components')
        .select('component_id, system_components(name, type)')
        .eq('impact_id', impact.id)
        .order('impact_weight', { ascending: false })
        .limit(20)

      for (const ic of (impactComponents ?? []) as unknown as Array<{ component_id: string; system_components: { name: string; type: string } | null }>) {
        if (ic.system_components) {
          componentTypeMap[ic.component_id] = ic.system_components.type
        }
      }

      for (const componentId of Object.keys(componentTypeMap)) {
        const { data: assignments } = await db
          .from('component_assignment')
          .select('file_id, files(path)')
          .eq('component_id', componentId)
          .eq('is_primary', true)
        componentFileMap[componentId] = ((assignments ?? []) as unknown as Array<{ files: { path: string } | null }>)
          .map(a => a.files?.path)
          .filter(Boolean) as string[]
      }
    }

    const plannedFiles = Object.values(componentFileMap).flat()

    // Sort tasks leaf-first
    const sortedTasks = [...allTasks].sort((a, b) => {
      const depthA = COMPONENT_DEPTH[componentTypeMap[a.component_id ?? ''] ?? ''] ?? 3
      const depthB = COMPONENT_DEPTH[componentTypeMap[b.component_id ?? ''] ?? ''] ?? 3
      return depthA - depthB
    })

    const branch = (plan as { branch_name?: string }).branch_name ?? `sf/${changeId.slice(0, 8)}-exec`

    const state: ExecutionState = {
      iteration: 0,
      aiCallCount: 0,
      startedAt: Date.now(),
      acceptedPatches: [],
      acceptedNewFiles: [],
      executionScope: { plannedFiles, addedViaPropagation: [] },
      errorHistory: new Map(),
      limits,
    }

    const log = makeLogger(db, changeId, () => state.iteration)

    await log('info', `Cloning ${(project as any).repo_url} into container…`)
    env = await executor.prepareEnvironment(
      { id: project.id, repoUrl: (project as any).repo_url ?? '', repoToken: (project as any).repo_token ?? null },
      branch,
      log,
    )
    await log('success', `Environment ready · branch ${branch}`)

    // Read package.json once so new-file prompts know what imports are available
    let availablePackages: string[] = []
    try {
      const pkgRaw = await readFile(join(env.localWorkDir, 'package.json'), 'utf8')
      const pkg = JSON.parse(pkgRaw)
      availablePackages = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    } catch { /* best-effort */ }

    // Per-file type-check errors from failed iterations — fed back into the prompt on retry
    const newFileTypeErrors = new Map<string, string>()

    let pendingTasks = sortedTasks.filter(t => t.status === 'pending')
    let fullSuccess = false

    while (state.iteration < limits.maxIterations && pendingTasks.length > 0) {
      if (Date.now() - state.startedAt > limits.maxDurationMs) break
      if (state.aiCallCount >= limits.maxAiCalls) break

      state.iteration++
      await log('info', `── Iteration ${state.iteration} ──`)

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

      await executor.resetIteration(env, state.acceptedPatches)
      for (const nf of state.acceptedNewFiles) {
        await executor.createFile(env, nf.path, nf.content)
      }

      const iterationPatches: FilePatch[] = []
      const iterationNewFiles: NewFileCreation[] = []
      // processedTaskIds: tasks touched this iteration (used to filter pendingTasks after success)
      const processedTaskIds: string[] = []

      for (const task of pendingTasks) {
        if (state.aiCallCount >= limits.maxAiCalls) break

        await log('info', `Task: ${task.description}`)
        const filePaths = componentFileMap[task.component_id ?? ''] ?? []

        // No files to modify — mark done immediately (or create new file if specified)
        if (filePaths.length === 0) {
          if (task.new_file_path && state.aiCallCount < limits.maxAiCalls) {
            const prompt = buildNewFilePrompt(
              { description: task.description, intent: (change as { intent: string }).intent },
              task.new_file_path,
              newFileTypeErrors.get(task.new_file_path),
              availablePackages
            )
            state.aiCallCount++
            const aiResult = await ai.complete(prompt, { maxTokens: 4096 })
            let parsed: { newFileContent?: string; confidence?: number } = {}
            try { parsed = parseAiJson(aiResult.content) } catch { /* skip */ }
            const newContent = parsed.newFileContent ?? ''
            const confidence = parsed.confidence ?? 0
            if (newContent && confidence >= limits.confidenceThreshold) {
              const result = await executor.createFile(env, task.new_file_path, newContent)
              if (result.success) {
                iterationNewFiles.push({ path: task.new_file_path, content: newContent })
                await log('success', `Created ${task.new_file_path}`)
              } else {
                await log('error', `Failed to create ${task.new_file_path}: ${result.error}`)
              }
            }
            const created = iterationNewFiles.some(f => f.path === task.new_file_path)
            if (!created) {
              await log('error', `Done (new file not created — low confidence or AI error)`)
              continue  // leave task pending so the next iteration retries it
            }
          }
          processedTaskIds.push(task.id)
          await db.from('change_plan_tasks').update({ status: 'done' }).eq('id', task.id).eq('plan_id', plan.id)
          await log('success', `Done`)
          continue
        }

        // Process each file in the component
        for (const filePath of filePaths) {
          const localFilePath = join(env.localWorkDir, filePath)
          let fileContent: string
          try {
            fileContent = await readFile(localFilePath, 'utf8')
          } catch {
            continue
          }

          // Extract first function as target (heuristic)
          const tsProject = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
          const sf = tsProject.createSourceFile(filePath, fileContent, { overwrite: true })
          const functions = sf.getFunctions()
          if (functions.length === 0) {
            continue
          }

          const targetFn = functions[0]!
          const fnName = (targetFn as unknown as { getName(): string | undefined }).getName() ?? 'unknown'
          const ctx = extractSymbol(filePath, fileContent, fnName, [])
          if (!ctx) {
            continue
          }

          const contextMode = chooseContextMode(ctx, limits)
          const inputHash = hashInput(ctx, task.description)

          // Build prompt
          const prompt = contextMode === 'file'
            ? buildFilePatchPrompt({ description: task.description, intent: (change as { intent: string }).intent }, fileContent, filePath)
            : buildSymbolPatchPrompt({ description: task.description, intent: (change as { intent: string }).intent }, ctx)

          state.aiCallCount++
          const aiResult = await ai.complete(prompt, { maxTokens: 4096 })

          let parsed: { newContent?: string; newFileContent?: string; confidence?: number; requiresPropagation?: boolean } = {}
          try { parsed = parseAiJson(aiResult.content) } catch { continue }

          const newContent = parsed.newContent ?? parsed.newFileContent ?? ''
          if (!newContent) {
            continue
          }

          const confidence = parsed.confidence ?? 0
          if (confidence < limits.confidenceThreshold) continue

          const patch: FilePatch = {
            path: filePath,
            locator: ctx.locator,
            originalContent: ctx.code,
            newContent,
            confidence,
            requiresPropagation: parsed.requiresPropagation ?? false,
            allowedChanges: { symbols: [ctx.symbolName], intent: task.description },
          }

          // Validate
          const validateProject = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
          const validateSf = validateProject.createSourceFile(filePath, fileContent, { overwrite: true })
          const validation = validatePatch(validateSf, patch)
          if (!validation.valid) {
            await recordTrace(db, {
              changeId, iteration: state.iteration, taskId: task.id,
              contextMode, inputHash, outputHash: null,
              strategyUsed: 'initial', failureType: 'syntax', confidence,
            })
            continue
          }

          const patchResult = await executor.applyPatch(env, patch)
          if (!patchResult.success) continue

          await recordTrace(db, {
            changeId, iteration: state.iteration, taskId: task.id,
            contextMode, inputHash, outputHash: hashOutput(patch),
            strategyUsed: 'initial', failureType: null, confidence,
          })

          iterationPatches.push(patch)
        }

        processedTaskIds.push(task.id)
        // Mark done immediately so the UI shows live task-by-task progress.
        // pendingTasks is tracked in-memory, so failed iterations still retry these tasks.
        await db.from('change_plan_tasks').update({ status: 'done' }).eq('id', task.id).eq('plan_id', plan.id)
        await log('success', `Done`)
      }

      // Validate
      await log('info', `Running type check…`)
      const typeCheck = await executor.runTypeCheck(env)
      if (!typeCheck.passed) {
        const errCount = typeCheck.errors.length
        await log('error', `Type check failed · ${errCount} error${errCount !== 1 ? 's' : ''}`)
        // Index type-check errors by new file path so the next prompt attempt can fix them.
        // Only update errors for files we attempted this iteration; leave others intact so
        // errors from earlier failed iterations persist across low-confidence retry loops.
        for (const nf of iterationNewFiles) {
          const relevant = typeCheck.output.split('\n').filter(l => l.includes(nf.path)).join('\n')
          if (relevant) newFileTypeErrors.set(nf.path, relevant)
          else newFileTypeErrors.delete(nf.path)
        }
        const sig = errorSignature(typeCheck.output)
        state.errorHistory.set(sig, (state.errorHistory.get(sig) ?? 0) + 1)
        if ((state.errorHistory.get(sig) ?? 0) >= limits.stagnationWindow) break
        await writeSnapshot(db, changeId, state, 'error', false, 0, 0, typeCheck.output.slice(0, 8000))
        continue
      }
      await log('success', `Type check passed`)

      const testScope: TestScope = await selectTests(db, [], (change as { risk_level: string | null }).risk_level ?? 'low')
      const totalTests = testScope.directTests.length + testScope.dependentTests.length
      await log('info', `Running ${totalTests > 0 ? totalTests + ' test file' + (totalTests !== 1 ? 's' : '') : 'all tests'}…`)
      const testResult = await executor.runTests(env, testScope)

      if (!testResult.passed) {
        await log('error', `Tests failed · ${testResult.testsFailed} failed, ${testResult.testsPassed} passed`)
        const sig = errorSignature(testResult.output)
        state.errorHistory.set(sig, (state.errorHistory.get(sig) ?? 0) + 1)
        if ((state.errorHistory.get(sig) ?? 0) >= limits.stagnationWindow) break
        const testErrorSummary = testResult.failures.length > 0
          ? testResult.failures.map(f => `FAIL: ${f.testName}\n${f.error}`).join('\n\n---\n\n')
          : testResult.output.slice(0, 8000)
        await writeSnapshot(db, changeId, state, 'error', false, testResult.testsPassed, testResult.testsFailed, testErrorSummary.slice(0, 8000))
        continue
      }
      await log('success', `Tests passed · ${testResult.testsPassed} passed`)

      // Behavioral checks
      const behavioralScope: BehavioralScope = {
        patches: iterationPatches,
        criticalComponentTouched: Object.values(componentTypeMap).some(t => ['auth', 'db'].includes(t)),
      }
      const behavResult = await executor.runBehavioralChecks(env, behavioralScope)
      if (!behavResult.passed) {
        const anomalyMsg = behavResult.anomalies.map(a => `[${a.severity}] ${a.description}`).join('\n')
        await log('error', `Behavioral check failed\n${anomalyMsg}`)
        await writeSnapshot(db, changeId, state, 'error', false, 0, 0, anomalyMsg.slice(0, 8000))
        continue
      }

      // All checks passed
      state.acceptedPatches.push(...iterationPatches)
      state.acceptedNewFiles.push(...iterationNewFiles)
      await writeSnapshot(
        db, changeId, state, 'passed', false,
        testResult.testsPassed, testResult.testsFailed, null,
        [...new Set([
          ...iterationPatches.map(p => p.path),
          ...iterationNewFiles.map(f => f.path),
        ])]
      )

      pendingTasks = pendingTasks.filter(t => !processedTaskIds.includes(t.id))
      if (pendingTasks.length === 0) {
        fullSuccess = true
        break
      }
    }

    // Commit and push
    await log('info', `Committing and pushing to ${branch}…`)
    await executor.getDiff(env)
    const commitMsg = `feat: ${(change as { title: string }).title} (${changeId.slice(0, 8)})`
    const commitResult = await executor.commitAndPush(env, branch, commitMsg)

    await db.from('change_commits').insert({
      change_id: changeId,
      branch_name: commitResult.branch,
      commit_hash: commitResult.commitHash,
    })
    await log('success', `Committed ${commitResult.commitHash.slice(0, 7)} → ${commitResult.branch}`)

    if (!fullSuccess) {
      await writeSnapshot(db, changeId, state, state.iteration >= limits.maxIterations ? 'max_iterations' : 'error')
    }

    await log(fullSuccess ? 'success' : 'error', fullSuccess ? 'Execution complete — ready for review' : 'Execution finished with errors')

    const executionOutcome: 'success' | 'failure' = fullSuccess ? 'success' : 'failure'

    // Step 1: Write stub (canonical completion signal)
    let completionVersion: number
    try {
      completionVersion = await nextVersion(db, projectId)
      // analysis_status 'completed' means the orchestrator ran to its conclusion (even if execution_outcome is 'failure').
      // 'failed' in analysis_status is reserved for exception-path termination (crash, stub write failure, etc.)
      await writeStub(db, changeId, completionVersion, executionOutcome, 'completed')
    } catch (stubErr) {
      console.error('[dashboard] stub write failed — not marking as completed:', stubErr)
      return // keep analysis_status = 'running', caller should retry
    }

    // Step 2: Mark change as completed
    await db
      .from('change_requests')
      .update({
        status: fullSuccess ? 'review' : 'failed',
        analysis_status: 'completed',
      })
      .eq('id', changeId)

    // Step 3: Emit completed event
    const completedEvent: DashboardEvent = {
      type: 'completed', scope: 'analysis',
      changeId, projectId,
      analysisVersion: currentAnalysisVersion,
      version: completionVersion,
      payload: { outcome: executionOutcome },
    }
    emitDashboardEvent(projectId, completedEvent)
    recordEvent(db, projectId, completedEvent).catch(() => {})

    // Step 4: Enrich snapshot in background
    const filesModified = state.acceptedPatches.map(p => p.path)
    enrichSnapshotWithRetry(db, projectId, changeId, {
      stagesCompleted: [`iteration_${state.iteration}`],
      filesModified,
      componentsAffected: Object.keys(componentTypeMap),
      durationMs: Date.now() - state.startedAt,
    }).catch(() => {})

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
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
      termination_reason: 'error',
      error_summary: errorMessage,
    })
    await db.from('change_requests').update({ status: 'failed', analysis_status: 'failed' }).eq('id', changeId)
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
