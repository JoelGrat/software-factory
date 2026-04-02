// lib/execution/types.ts
import type { ContextMode, FailureType, ExecutionStrategy } from '@/lib/supabase/types'

export type { ContextMode, FailureType, ExecutionStrategy }

// ── Node resolution ───────────────────────────────────────────────────────────

export interface NodeLocator {
  primary: string  // hash(filePath + kind + startLine + code.slice(0,50))
  fallbacks: {
    symbolName?: string
    kind: number       // ts-morph SyntaxKind
    approximatePosition: { line: number; toleranceLines: number }
    structureSignature: string  // hash(paramCount + ':' + returnTypeText)
  }
}

// ── Symbol context ────────────────────────────────────────────────────────────

export interface SymbolContext {
  symbolName: string
  filePath: string
  code: string
  locator: NodeLocator
  callers: string[]       // file paths that import this file (from component_graph_edges)
  callees: string[]       // identifiers this symbol calls, extracted from AST
  relatedTypes: string[]  // type names referenced in this symbol's signature
  complexity: number      // line count of symbol body
}

// ── Patch ─────────────────────────────────────────────────────────────────────

export interface AllowedChanges {
  symbols: string[]  // symbol names this AI call is allowed to touch
  intent: string     // task description forwarded to every AI call
}

export interface FilePatch {
  path: string
  locator: NodeLocator
  originalContent: string   // node.getText() at extraction time
  newContent: string        // replacement code for just the node
  confidence: number        // 0–100, returned by AI
  requiresPropagation: boolean
  allowedChanges: AllowedChanges
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean
  reason?: string
  stage?: 'intent' | 'semantic' | 'syntax' | 'stale'
}

// ── Execution environment ─────────────────────────────────────────────────────

export interface ExecutionEnvironment {
  containerId: string
  containerWorkDir: string  // '/app' inside container
  localWorkDir: string      // temp dir on host, mirrors container state
  branch: string
  projectId: string
  repoUrl: string
}

// ── Test scope ────────────────────────────────────────────────────────────────

export interface TestScope {
  directTests: string[]     // test files directly covering changed source files
  dependentTests: string[]  // test files for components that depend on changed components
  widened: boolean          // true when risk_level forced wider scope
}

// ── Executor results ──────────────────────────────────────────────────────────

export interface PatchResult {
  success: boolean
  error?: string
}

export interface TypeCheckError {
  file: string
  line: number
  message: string
}

export interface TypeCheckResult {
  passed: boolean
  errors: TypeCheckError[]
  output: string
}

export interface TestFailure {
  testName: string
  error: string
}

export interface TestResult {
  passed: boolean
  failures: TestFailure[]
  output: string
  testsRun: number
  testsPassed: number
  testsFailed: number
}

export interface BehavioralAnomaly {
  type: 'removed_conditional' | 'early_return' | 'exception_swallowing' | 'contract_change'
  description: string
  severity: 'warning' | 'error'
}

export interface BehavioralResult {
  passed: boolean
  anomalies: BehavioralAnomaly[]
}

export interface BehavioralScope {
  patches: FilePatch[]
  criticalComponentTouched: boolean
}

export interface DiffSummary {
  filesChanged: string[]
  additions: number
  deletions: number
  rawDiff: string
}

export interface CommitResult {
  commitHash: string
  branch: string
}

// ── Limits ────────────────────────────────────────────────────────────────────

export interface ExecutionLimits {
  maxIterations: number
  maxAiCalls: number
  maxDurationMs: number
  maxCost: number
  maxAffectedFiles: number
  maxPropagationQueueSize: number
  confidenceThreshold: number
  symbolComplexityLowThreshold: number
  symbolComplexityHighThreshold: number
  propagationFactor: number
  stagnationWindow: number
}

export const DEFAULT_LIMITS: ExecutionLimits = {
  maxIterations: 10,
  maxAiCalls: 50,
  maxDurationMs: 600_000,
  maxCost: Infinity,
  maxAffectedFiles: 20,
  maxPropagationQueueSize: 15,
  confidenceThreshold: 60,
  symbolComplexityLowThreshold: 30,
  symbolComplexityHighThreshold: 80,
  propagationFactor: 1.5,
  stagnationWindow: 3,
}

// ── Execution scope ───────────────────────────────────────────────────────────

export interface ExecutionScope {
  plannedFiles: string[]
  addedViaPropagation: string[]
}

// ── Execution trace (DB row shape) ────────────────────────────────────────────

export interface ExecutionTraceRow {
  changeId: string
  iteration: number
  taskId: string
  contextMode: ContextMode
  inputHash: string
  outputHash: string | null
  strategyUsed: ExecutionStrategy
  failureType: FailureType | null
  confidence: number | null
}

// ── Propagation queue item ────────────────────────────────────────────────────

export interface PropagationItem {
  filePath: string
  symbolName: string
  reason: string  // e.g. 'signature_change_in AuthService.getUser'
}
