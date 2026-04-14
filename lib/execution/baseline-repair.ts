// lib/execution/baseline-repair.ts
//
// Runs a baseline test pass before any patches are applied. When tests fail
// for infrastructure reasons (parse errors, missing deps, bad config) it
// attempts repair so the agent starts from a testable state.
//
// Returns a typed status that drives orchestrator behaviour:
//   clean               — tests pass, proceed normally
//   repaired            — baseline was broken, we fixed it, proceed normally
//   pre_existing        — assertion failures only; record them for filtering
//   blocked             — infrastructure broken, cannot repair, halt execution

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { CodeExecutor } from './executors/code-executor'
import type { ExecutionEnvironment, TestScope, ExecLogger, TestResult } from './types'
import type { DiagnosticSet } from './execution-types-v2'
import { runRepairPhase } from './repair-phase'
import { insertEvent } from './event-emitter'

export type BaselineStatus =
  | 'clean'
  | 'repaired'
  | 'pre_existing'
  | 'blocked'

export type BaselineFailureCategory =
  | 'pre_existing_assertions'   // tests fail but infrastructure is fine
  | 'missing_dependency'        // cannot resolve import / module not found
  | 'syntax_error'              // TypeScript syntax in a .js file, etc.
  | 'bad_config'                // vitest config, transform failure
  | 'no_tests'                  // no test files found
  | 'flaky'                     // inconsistent / cannot reproduce
  | 'unknown'

export interface BaselineResult {
  status: BaselineStatus
  category: BaselineFailureCategory | null
  preExistingFailedTests: Set<string>
  repairAttempts: number
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const STRIP_ANSI = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')

function classifyCategory(result: TestResult): BaselineFailureCategory {
  if (result.failures.length > 0) return 'pre_existing_assertions'

  const ft = result.failureType
  if (!ft) return 'unknown'
  if (ft === 'NO_TESTS_FOUND') return 'no_tests'
  if (ft === 'INCONSISTENT_TEST_RESULT') return 'flaky'
  if (ft === 'TEST_CONFIG_ERROR') {
    const out = STRIP_ANSI(result.raw?.stdout ?? result.output)
    if (/cannot find module|failed to resolve import/i.test(out)) return 'missing_dependency'
    if (/cannot parse|parse failed|expected a semicolon|unexpected token/i.test(out)) return 'syntax_error'
    if (/transform failed|error\[plugin\]/i.test(out)) return 'bad_config'
    return 'bad_config'
  }
  return 'unknown'
}

function extractDiagnosticSet(result: TestResult): DiagnosticSet | null {
  const out = STRIP_ANSI(result.raw?.stdout ?? result.output)

  // Parse error in a specific file
  const fileMatch = out.match(/Cannot parse ([^\n:]+):/)
  if (fileMatch) {
    const filePath = fileMatch[1]!.trim().replace(/^\/app\//, '')
    const lineMatch = out.match(/(\d+):[^\n]*\n[^\n]*\^/)
    const lineNum = lineMatch ? parseInt(lineMatch[1]!) : 1
    const errMatch = out.match(/Parse failed[^\n]*\n([^\n]+)/)
    const errMsg = errMatch ? errMatch[1]!.trim() : 'Parse error in test file'
    return {
      diagnostics: [{ file: filePath, line: lineNum, message: errMsg, code: 'PARSE' }],
      totalCount: 1,
      truncated: false,
    }
  }

  // Missing module / unresolved import
  const missingMatch = out.match(/Cannot find module ['"]([^'"]+)['"]|Failed to resolve import ['"]([^'"]+)['"]\s+from\s+['"]([^'"]+)['"]/)
  if (missingMatch) {
    const module = missingMatch[1] ?? missingMatch[2] ?? 'unknown'
    const fromFile = missingMatch[3]?.replace(/^\/app\//, '') ?? 'unknown'
    return {
      diagnostics: [{ file: fromFile, line: 1, message: `Cannot resolve module: ${module}`, code: 'IMPORT' }],
      totalCount: 1,
      truncated: false,
    }
  }

  // Transform failure — report the first file mentioned
  const transformMatch = out.match(/transform failed[^\n]*\n?[^\n]*['"]([^'"]+)['"]/i)
  if (transformMatch) {
    const filePath = transformMatch[1]!.replace(/^\/app\//, '')
    return {
      diagnostics: [{ file: filePath, line: 1, message: 'Transform failed — check vite/vitest config or file extension', code: 'TRANSFORM' }],
      totalCount: 1,
      truncated: false,
    }
  }

  return null
}

// ── Main export ────────────────────────────────────────────────────────────────

const MAX_BASELINE_REPAIR_ATTEMPTS = 2

export async function runBaselineRepair(
  db: SupabaseClient,
  ai: AIProvider,
  executor: CodeExecutor,
  env: ExecutionEnvironment,
  runId: string,
  changeId: string,
  testScope: TestScope,
  log: ExecLogger,
  seq: () => number,
): Promise<BaselineResult> {
  await log('verbose', 'Baseline test run — detecting pre-existing failures')
  await insertEvent(db, { runId, changeId, seq: seq(), iteration: 0, eventType: 'baseline.started', payload: {} })

  let result = await executor.runTests(env, testScope)

  // ── Clean baseline ─────────────────────────────────────────────────────────
  if (result.passed) {
    await log('verbose', 'Baseline: all tests pass')
    await insertEvent(db, { runId, changeId, seq: seq(), iteration: 0, eventType: 'baseline.clean', payload: {} })
    return { status: 'clean', category: null, preExistingFailedTests: new Set(), repairAttempts: 0 }
  }

  const category = classifyCategory(result)

  // ── Pre-existing assertion failures ───────────────────────────────────────
  // Infrastructure works; specific tests were already failing.
  // Record them and proceed — they will be filtered out of the repair loop.
  if (category === 'pre_existing_assertions') {
    const names = new Set(result.failures.map(f => f.testName))
    await log('verbose', `Baseline: ${names.size} pre-existing test failure${names.size !== 1 ? 's' : ''} recorded — will be excluded from repair`)
    await insertEvent(db, { runId, changeId, seq: seq(), iteration: 0, eventType: 'baseline.pre_existing', payload: { count: names.size } })
    return { status: 'pre_existing', category, preExistingFailedTests: names, repairAttempts: 0 }
  }

  // ── Infrastructure failure — attempt repair ────────────────────────────────
  await log('error', `Baseline test infrastructure broken [${category}] — diagnosing and attempting repair`)

  let repairAttempts = 0

  for (let attempt = 1; attempt <= MAX_BASELINE_REPAIR_ATTEMPTS; attempt++) {
    repairAttempts = attempt

    const diagnostic = extractDiagnosticSet(result)
    if (!diagnostic) {
      await log('error', `Baseline: cannot extract diagnostic for repair — no specific file identified`)
      break
    }

    await log('info', `Baseline repair attempt ${attempt}/${MAX_BASELINE_REPAIR_ATTEMPTS} — targeting ${diagnostic.diagnostics[0]?.file}`)
    await insertEvent(db, { runId, changeId, seq: seq(), iteration: 0, eventType: 'baseline.repair.started', payload: { attempt, category } })

    const repairResult = await runRepairPhase(
      db, ai, executor, env,
      runId, changeId,
      0,
      diagnostic,
      `Fix baseline test infrastructure: ${category} in ${diagnostic.diagnostics[0]?.file}`,
      seq,
    )

    if (repairResult.filesPatched.length === 0) {
      await log('error', `Baseline repair attempt ${attempt}: AI produced no patches — ${repairResult.rationale}`)
      break
    }

    await log('verbose', `Baseline repair attempt ${attempt}: patched ${repairResult.filesPatched.join(', ')}`)

    // Re-run baseline
    result = await executor.runTests(env, testScope)

    if (result.passed) {
      await log('success', `Baseline repaired after ${attempt} attempt${attempt !== 1 ? 's' : ''} — test infrastructure fixed`)
      await insertEvent(db, { runId, changeId, seq: seq(), iteration: 0, eventType: 'baseline.repaired', payload: { attempts: attempt, filesFixed: repairResult.filesPatched } })
      return { status: 'repaired', category, preExistingFailedTests: new Set(), repairAttempts: attempt }
    }

    const newCategory = classifyCategory(result)

    // After fixing config, if only assertion failures remain, treat as pre-existing
    if (newCategory === 'pre_existing_assertions') {
      const names = new Set(result.failures.map(f => f.testName))
      await log('success', `Baseline config fixed — ${names.size} pre-existing assertion failure${names.size !== 1 ? 's' : ''} remain (unrelated to this change)`)
      await insertEvent(db, { runId, changeId, seq: seq(), iteration: 0, eventType: 'baseline.repaired', payload: { attempts: attempt, filesFixed: repairResult.filesPatched, preExistingCount: names.size } })
      return { status: 'pre_existing', category: 'pre_existing_assertions', preExistingFailedTests: names, repairAttempts: attempt }
    }

    await log('verbose', `Baseline still broken [${newCategory}] after repair attempt ${attempt}`)
  }

  // ── Unresolvable ──────────────────────────────────────────────────────────
  await log('error', `Baseline unresolvable after ${repairAttempts} repair attempt${repairAttempts !== 1 ? 's' : ''} — test infrastructure cannot be fixed`)
  await insertEvent(db, { runId, changeId, seq: seq(), iteration: 0, eventType: 'baseline.blocked', payload: { category, attempts: repairAttempts } })
  return { status: 'blocked', category, preExistingFailedTests: new Set(), repairAttempts }
}
