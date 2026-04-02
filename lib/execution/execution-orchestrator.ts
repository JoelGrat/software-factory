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
} from './types'
import { DEFAULT_LIMITS } from './types'
import { extractSymbol } from './symbol-extractor'
import { validatePatch } from './patch-validator'
import { selectTests } from './test-selector'
import { hashInput, hashOutput, recordTrace } from './execution-tracer'
import { buildSymbolPatchPrompt, buildFilePatchPrompt } from './prompt-builders'

function errorSignature(output: string): string {
  return createHash('sha256').update(output.slice(0, 500)).digest('hex').slice(0, 12)
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
}

interface ExecutionState {
  iteration: number
  aiCallCount: number
  startedAt: number
  acceptedPatches: FilePatch[]
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
  testsFailed = 0
): Promise<void> {
  await db.from('execution_snapshots').insert({
    change_id: changeId,
    iteration: state.iteration,
    files_modified: [],
    tests_passed: testsPassed,
    tests_failed: testsFailed,
    planned_files: state.executionScope.plannedFiles,
    propagated_files: state.executionScope.addedViaPropagation,
    plan_divergence: planDivergence,
    partial_success: false,
    termination_reason: terminationReason,
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

  try {
    // Load change
    const { data: change } = await db
      .from('change_requests')
      .select('id, project_id, title, intent, type, risk_level')
      .eq('id', changeId)
      .single()
    if (!change) throw new Error(`Change not found: ${changeId}`)

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

    // Load tasks
    const { data: rawTasks } = await db
      .from('change_plan_tasks')
      .select('id, component_id, description, order_index, status')
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

      for (const ic of (impactComponents ?? []) as Array<{ component_id: string; system_components: { name: string; type: string } | null }>) {
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
        componentFileMap[componentId] = ((assignments ?? []) as Array<{ files: { path: string } | null }>)
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
    env = await executor.prepareEnvironment(project, branch)

    const state: ExecutionState = {
      iteration: 0,
      aiCallCount: 0,
      startedAt: Date.now(),
      acceptedPatches: [],
      executionScope: { plannedFiles, addedViaPropagation: [] },
      errorHistory: new Map(),
      limits,
    }

    let pendingTasks = sortedTasks.filter(t => t.status === 'pending')
    let fullSuccess = false

    while (state.iteration < limits.maxIterations && pendingTasks.length > 0) {
      if (Date.now() - state.startedAt > limits.maxDurationMs) break
      if (state.aiCallCount >= limits.maxAiCalls) break

      state.iteration++
      await executor.resetIteration(env, state.acceptedPatches)

      const iterationPatches: FilePatch[] = []
      const completedTaskIds: string[] = []

      for (const task of pendingTasks) {
        if (state.aiCallCount >= limits.maxAiCalls) break

        const filePaths = componentFileMap[task.component_id ?? ''] ?? []

        // No files to modify — mark done immediately
        if (filePaths.length === 0) {
          completedTaskIds.push(task.id)
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
            completedTaskIds.push(task.id)
            continue
          }

          const targetFn = functions[0]!
          const fnName = (targetFn as unknown as { getName(): string | undefined }).getName() ?? 'unknown'
          const ctx = extractSymbol(filePath, fileContent, fnName, [])
          if (!ctx) {
            completedTaskIds.push(task.id)
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
          try { parsed = JSON.parse(aiResult.content) } catch { continue }

          const newContent = parsed.newContent ?? parsed.newFileContent ?? ''
          if (!newContent) {
            completedTaskIds.push(task.id)
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

        completedTaskIds.push(task.id)
      }

      // Validate
      const typeCheck = await executor.runTypeCheck(env)
      if (!typeCheck.passed) {
        const sig = errorSignature(typeCheck.output)
        state.errorHistory.set(sig, (state.errorHistory.get(sig) ?? 0) + 1)
        if ((state.errorHistory.get(sig) ?? 0) >= limits.stagnationWindow) break
        await writeSnapshot(db, changeId, state, 'error')
        continue
      }

      const testScope: TestScope = await selectTests(db, [], (change as { risk_level: string | null }).risk_level ?? 'low')
      const testResult = await executor.runTests(env, testScope)

      if (!testResult.passed) {
        const sig = errorSignature(testResult.output)
        state.errorHistory.set(sig, (state.errorHistory.get(sig) ?? 0) + 1)
        if ((state.errorHistory.get(sig) ?? 0) >= limits.stagnationWindow) break
        await writeSnapshot(db, changeId, state, 'error', false, testResult.testsPassed, testResult.testsFailed)
        continue
      }

      // Behavioral checks
      const behavioralScope: BehavioralScope = {
        patches: iterationPatches,
        criticalComponentTouched: Object.values(componentTypeMap).some(t => ['auth', 'db'].includes(t)),
      }
      const behavResult = await executor.runBehavioralChecks(env, behavioralScope)
      if (!behavResult.passed) {
        await writeSnapshot(db, changeId, state, 'error')
        continue
      }

      // All checks passed
      state.acceptedPatches.push(...iterationPatches)
      for (const taskId of completedTaskIds) {
        await db.from('change_plan_tasks').update({ status: 'done' }).eq('id', taskId).eq('plan_id', plan.id)
      }
      await writeSnapshot(db, changeId, state, 'passed', false, testResult.testsPassed, testResult.testsFailed)

      pendingTasks = pendingTasks.filter(t => !completedTaskIds.includes(t.id))
      if (pendingTasks.length === 0) {
        fullSuccess = true
        break
      }
    }

    // Commit and push
    await executor.getDiff(env)
    const commitMsg = `feat: ${(change as { title: string }).title} (${changeId.slice(0, 8)})`
    const commitResult = await executor.commitAndPush(env, branch, commitMsg)

    await db.from('change_commits').insert({
      change_id: changeId,
      branch_name: commitResult.branch,
      commit_hash: commitResult.commitHash,
    })

    if (!fullSuccess) {
      await writeSnapshot(db, changeId, state, state.iteration >= limits.maxIterations ? 'max_iterations' : 'error')
    }

    await db.from('change_requests').update({ status: 'review' }).eq('id', changeId)

  } catch (err) {
    await db.from('change_requests').update({ status: 'failed' }).eq('id', changeId)
    throw err
  } finally {
    if (env) await executor.cleanup(env)
  }
}
