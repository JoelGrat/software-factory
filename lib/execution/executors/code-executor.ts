// lib/execution/executors/code-executor.ts
import type {
  ExecutionEnvironment,
  FilePatch,
  PatchResult,
  TypeCheckResult,
  TestResult,
  BehavioralResult,
  BehavioralScope,
  DiffSummary,
  CommitResult,
  TestScope,
} from '../types'

export interface CodeExecutor {
  /** Spin up isolated environment, clone repo, install deps, create branch */
  prepareEnvironment(project: { repoUrl: string; repoToken: string | null; id: string }, branch: string): Promise<ExecutionEnvironment>

  /** Apply a patch by AST-replacing the target node in localWorkDir, then syncing to container */
  applyPatch(env: ExecutionEnvironment, patch: FilePatch): Promise<PatchResult>

  /** Run `tsc --noEmit` inside the container */
  runTypeCheck(env: ExecutionEnvironment): Promise<TypeCheckResult>

  /** Run scoped or full test suite inside the container */
  runTests(env: ExecutionEnvironment, scope: TestScope): Promise<TestResult>

  /** Run behavioral heuristic checks on patched files */
  runBehavioralChecks(env: ExecutionEnvironment, scope: BehavioralScope): Promise<BehavioralResult>

  /** Get git diff from the container */
  getDiff(env: ExecutionEnvironment): Promise<DiffSummary>

  /** git add -A && git commit && git push inside the container */
  commitAndPush(env: ExecutionEnvironment, branch: string, message: string): Promise<CommitResult>

  /** git reset --hard HEAD then re-apply acceptedPatches — call at start of each iteration */
  resetIteration(env: ExecutionEnvironment, acceptedPatches: FilePatch[]): Promise<void>

  /** Stop container and clean up local temp dir */
  cleanup(env: ExecutionEnvironment): Promise<void>
}

// ── MockCodeExecutor (for unit tests) ─────────────────────────────────────────

export class MockCodeExecutor implements CodeExecutor {
  public calls: string[] = []

  // Override these in tests to simulate failures
  typeCheckResult: TypeCheckResult = { passed: true, errors: [], output: '' }
  testResult: TestResult = { passed: true, failures: [], output: '', testsRun: 1, testsPassed: 1, testsFailed: 0 }
  behavioralResult: BehavioralResult = { passed: true, anomalies: [] }
  patchResult: PatchResult = { success: true }

  async prepareEnvironment(): Promise<ExecutionEnvironment> {
    this.calls.push('prepareEnvironment')
    return {
      containerId: 'mock-container',
      containerWorkDir: '/app',
      localWorkDir: '/tmp/mock',
      branch: 'sf/test-branch',
      projectId: 'proj-1',
      repoUrl: 'https://github.com/test/repo',
    }
  }

  async applyPatch(_env: ExecutionEnvironment, _patch: FilePatch): Promise<PatchResult> {
    this.calls.push('applyPatch')
    return this.patchResult
  }

  async runTypeCheck(_env: ExecutionEnvironment): Promise<TypeCheckResult> {
    this.calls.push('runTypeCheck')
    return this.typeCheckResult
  }

  async runTests(_env: ExecutionEnvironment, _scope: TestScope): Promise<TestResult> {
    this.calls.push('runTests')
    return this.testResult
  }

  async runBehavioralChecks(_env: ExecutionEnvironment, _scope: BehavioralScope): Promise<BehavioralResult> {
    this.calls.push('runBehavioralChecks')
    return this.behavioralResult
  }

  async getDiff(_env: ExecutionEnvironment): Promise<DiffSummary> {
    this.calls.push('getDiff')
    return { filesChanged: ['src/user.ts'], additions: 5, deletions: 2, rawDiff: '+added\n-removed' }
  }

  async commitAndPush(_env: ExecutionEnvironment, branch: string): Promise<CommitResult> {
    this.calls.push('commitAndPush')
    return { commitHash: 'abc123', branch }
  }

  async resetIteration(_env: ExecutionEnvironment): Promise<void> {
    this.calls.push('resetIteration')
  }

  async cleanup(_env: ExecutionEnvironment): Promise<void> {
    this.calls.push('cleanup')
  }
}
