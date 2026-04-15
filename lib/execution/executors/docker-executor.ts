// lib/execution/executors/docker-executor.ts
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { Project } from 'ts-morph'
import type { CodeExecutor } from './code-executor'
import type {
  ExecutionEnvironment, ExecLogger, FilePatch, PatchResult, TypeCheckResult,
  TestResult, TestFailureType, TestRawOutput, BehavioralResult, BehavioralScope, DiffSummary,
  CommitResult, TestScope,
} from '../types'

const noop: ExecLogger = async () => {}
import { resolveNode } from '../node-locator'
import { checkBehavior } from '../behavioral-guardrail'

const exec = promisify(execCb)

async function dockerExec(containerId: string, command: string): Promise<{ stdout: string; stderr: string }> {
  return exec(`docker exec ${containerId} sh -c "${command.replace(/"/g, '\\"')}"`)
}

async function dockerCpToLocal(containerId: string, containerWorkDir: string, localWorkDir: string): Promise<void> {
  // Move node_modules aside temporarily — Windows can't create the symlinks in .bin/
  await dockerExec(containerId, `mv ${containerWorkDir}/node_modules /tmp/_nm 2>/dev/null || true`)
  try {
    await exec(`docker cp ${containerId}:${containerWorkDir}/. ${localWorkDir}/`)
  } finally {
    await dockerExec(containerId, `mv /tmp/_nm ${containerWorkDir}/node_modules 2>/dev/null || true`)
  }
}

export class DockerExecutor implements CodeExecutor {
  private readonly image: string

  constructor(image = 'node:20-slim') {
    this.image = image
  }

  async prepareEnvironment(
    project: { repoUrl: string; repoToken: string | null; id: string },
    branch: string,
    log: ExecLogger = noop,
  ): Promise<ExecutionEnvironment> {
    if (!project.repoUrl) throw new Error('No repository URL configured for this project')
    if (!project.repoToken) throw new Error('No access token configured for this project')

    const localWorkDir = await mkdtemp(join(tmpdir(), `sf-exec-${project.id}-`))

    await log('docker', `docker run -d --rm ${this.image} tail -f /dev/null`)
    const { stdout } = await exec(`docker run -d --rm ${this.image} tail -f /dev/null`)
    const containerId = stdout.trim()
    const containerWorkDir = '/app'

    try {
      await log('docker', `apt-get install git ca-certificates`)
      await dockerExec(containerId, `DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y git ca-certificates --no-install-recommends -qq 2>&1`)
    } catch (err) {
      throw new Error(`Failed to install git in container: ${(err as Error).message}`)
    }

    const authedUrl = project.repoUrl.replace('https://', `https://oauth2:${project.repoToken}@`)

    await log('docker', `git clone --depth 1 ${project.repoUrl} /app`)
    await dockerExec(containerId, `git clone --depth 1 ${authedUrl} ${containerWorkDir}`)
    await log('docker', `git checkout ${branch}`)
    await dockerExec(containerId, `cd ${containerWorkDir} && (git fetch --depth 1 origin ${branch} 2>/dev/null && git checkout ${branch}) || git checkout -b ${branch}`)
    await log('docker', `npm install`)
    await dockerExec(containerId, `cd ${containerWorkDir} && npm install --silent`)
    await log('docker', `docker cp → local`)
    await dockerCpToLocal(containerId, containerWorkDir, localWorkDir)

    return { containerId, containerWorkDir, localWorkDir, branch, projectId: project.id, repoUrl: project.repoUrl, log }
  }

  async applyPatch(env: ExecutionEnvironment, patch: FilePatch): Promise<PatchResult> {
    const localPath = join(env.localWorkDir, patch.path)

    try {
      const currentContent = await readFile(localPath, 'utf8')

      const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
      const sf = project.createSourceFile(patch.path, currentContent, { overwrite: true })
      const node = resolveNode(sf, patch.locator)
      if (!node) return { success: false, error: 'Node not found by locator' }

      node.replaceWithText(patch.newContent)
      const updatedContent = sf.getFullText()

      await writeFile(localPath, updatedContent, 'utf8')

      const containerPath = `${env.containerWorkDir}/${patch.path}`
      const containerDir = containerPath.substring(0, containerPath.lastIndexOf('/'))
      await dockerExec(env.containerId, `mkdir -p ${containerDir}`)
      await exec(`docker cp ${localPath} ${env.containerId}:${containerPath}`)

      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  async createFile(env: ExecutionEnvironment, path: string, content: string): Promise<PatchResult> {
    const localPath = join(env.localWorkDir, path)
    try {
      await mkdir(dirname(localPath), { recursive: true })
      await writeFile(localPath, content, 'utf8')
      const containerPath = `${env.containerWorkDir}/${path}`
      const containerDir = containerPath.substring(0, containerPath.lastIndexOf('/'))
      await dockerExec(env.containerId, `mkdir -p ${containerDir}`)
      await exec(`docker cp ${localPath} ${env.containerId}:${containerPath}`)
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  async runInstall(env: ExecutionEnvironment, packages?: string[]): Promise<void> {
    if (packages && packages.length > 0) {
      const pkgList = packages.join(' ')
      await env.log('docker', `npm install --save-dev ${pkgList}`)
      await dockerExec(env.containerId, `cd ${env.containerWorkDir} && npm install --save-dev ${pkgList} --silent 2>&1`)
    } else {
      await env.log('docker', `npm install`)
      await dockerExec(env.containerId, `cd ${env.containerWorkDir} && npm install --silent 2>&1`)
    }
  }

  async runTypeCheck(env: ExecutionEnvironment): Promise<TypeCheckResult> {
    await env.log('docker', `npx tsc --noEmit`)
    try {
      const { stdout, stderr } = await dockerExec(env.containerId, `cd ${env.containerWorkDir} && npx tsc --noEmit 2>&1`)
      const output = stdout + stderr
      const errors = output
        .split('\n')
        .filter(line => /error TS\d+:/.test(line))
        .map(line => {
          const m = line.match(/^(.+)\((\d+),\d+\): error TS\d+: (.+)$/)
          return m ? { file: m[1]!, line: parseInt(m[2]!), message: m[3]! } : null
        })
        .filter(Boolean) as TypeCheckResult['errors']
      return { passed: errors.length === 0, errors, output }
    } catch (err) {
      const output = (err as { stdout?: string; stderr?: string }).stdout ?? String(err)
      const errors = output.split('\n').filter(l => /error TS/.test(l))
        .map(line => {
          const m = line.match(/^(.+)\((\d+),\d+\): error TS\d+: (.+)$/)
          return m ? { file: m[1]!, line: parseInt(m[2]!), message: m[3]! } : null
        }).filter(Boolean) as TypeCheckResult['errors']
      return { passed: false, errors, output }
    }
  }

  async runTests(env: ExecutionEnvironment, scope: TestScope): Promise<TestResult> {
    const allTests = [...scope.directTests, ...scope.dependentTests]
    const filter = allTests.length > 0 ? allTests.join(' ') : ''
    const baseArgs = filter ? `run ${filter}` : `run`
    // --testTimeout=10000: fail individual hanging tests after 10s instead of blocking forever.
    // timeout 120: kill the entire vitest process if it never exits (e.g. module-load hang).
    const cmd = `cd ${env.containerWorkDir} && timeout 120 npx vitest ${baseArgs} --reporter=json --testTimeout=10000 2>&1; echo "__EXIT:$?"`

    await env.log('docker', filter ? `npx vitest run ${filter}` : `npx vitest run`)

    const tStart = Date.now()
    let rawStdout = ''
    try {
      const { stdout } = await dockerExec(env.containerId, cmd)
      rawStdout = stdout
    } catch (err) {
      rawStdout = (err as { stdout?: string }).stdout ?? String(err)
    }

    const durationMs = Date.now() - tStart

    // Extract exit code appended by the shell
    const exitMatch = rawStdout.match(/__EXIT:(\d+)\s*$/)
    const exitCode = exitMatch ? parseInt(exitMatch[1]!) : -1
    const stdout = exitMatch ? rawStdout.slice(0, exitMatch.index) : rawStdout

    const raw: TestRawOutput = {
      command: `npx vitest ${baseArgs} --reporter=json`,
      exitCode,
      stdout,
      durationMs,
    }

    const result = parseVitestJson(stdout, raw)

    // Contradiction: exit code says failure but parsed result shows zero failures and no diagnostics
    // → INCONSISTENT_TEST_RESULT → retry with verbose reporter to capture real output
    if (!result.passed && result.testsFailed === 0 && result.failures.length === 0 && exitCode !== 0) {
      await env.log('verbose', `Inconsistent test result (exit=${exitCode}, failures=0) — retrying with verbose reporter`)
      const verboseCmd = `cd ${env.containerWorkDir} && timeout 120 npx vitest ${baseArgs} --reporter=verbose --testTimeout=10000 2>&1; echo "__EXIT:$?"`
      let verboseOut = ''
      try {
        const { stdout: vs } = await dockerExec(env.containerId, verboseCmd)
        verboseOut = vs
      } catch (err) {
        verboseOut = (err as { stdout?: string }).stdout ?? String(err)
      }
      const verboseExitMatch = verboseOut.match(/__EXIT:(\d+)\s*$/)
      const verboseExitCode = verboseExitMatch ? parseInt(verboseExitMatch[1]!) : exitCode
      const verboseStdout = verboseExitMatch ? verboseOut.slice(0, verboseExitMatch.index) : verboseOut
      const verboseRaw: TestRawOutput = {
        command: `npx vitest ${baseArgs} --reporter=verbose`,
        exitCode: verboseExitCode,
        stdout: verboseStdout,
        durationMs: Date.now() - tStart,
        // On process-level timeout (exit 124), capture how far tests got before the hang
        progressNote: verboseExitCode === 124 ? parseTestProgress(verboseStdout) : undefined,
      }
      // Re-classify using the verbose output — we now have real diagnostic text
      const verboseFailureType = classifyFromVerboseOutput(verboseStdout, verboseExitCode)
      return {
        passed: false,
        failures: [],
        output: verboseStdout,
        testsRun: 0,
        testsPassed: 0,
        testsFailed: 0,
        failureType: verboseFailureType,
        raw: verboseRaw,
      }
    }

    return result
  }

  async runBehavioralChecks(env: ExecutionEnvironment, scope: BehavioralScope): Promise<BehavioralResult> {
    if (!scope.criticalComponentTouched) return { passed: true, anomalies: [] }

    const allAnomalies = []
    for (const patch of scope.patches) {
      const result = checkBehavior(patch.originalContent, patch.newContent)
      allAnomalies.push(...result.anomalies)
    }
    const hasError = allAnomalies.some(a => a.severity === 'error')
    return { passed: !hasError, anomalies: allAnomalies }
  }

  async getDiff(env: ExecutionEnvironment): Promise<DiffSummary> {
    const { stdout } = await dockerExec(env.containerId, `cd ${env.containerWorkDir} && git diff HEAD --stat 2>&1 && echo '---RAW---' && git diff HEAD 2>&1`)
    const parts = stdout.split('---RAW---')
    const statPart = parts[0] ?? ''
    const rawDiff = parts[1] ?? ''
    const filesChanged = statPart.match(/^\s+\S+/gm)?.map(f => f.trim()) ?? []
    const addMatch = statPart.match(/(\d+) insertion/)
    const delMatch = statPart.match(/(\d+) deletion/)
    return {
      filesChanged,
      additions: addMatch ? parseInt(addMatch[1]!) : 0,
      deletions: delMatch ? parseInt(delMatch[1]!) : 0,
      rawDiff,
    }
  }

  async commitAndPush(env: ExecutionEnvironment, branch: string, message: string): Promise<CommitResult> {
    await dockerExec(env.containerId, `cd ${env.containerWorkDir} && git config user.email "sf@softwarefactory.ai"`)
    await dockerExec(env.containerId, `cd ${env.containerWorkDir} && git config user.name "Software Factory"`)
    const { stdout: statusOut } = await dockerExec(env.containerId, `cd ${env.containerWorkDir} && git status --porcelain`)
    const { stdout: headHash } = await dockerExec(env.containerId, `cd ${env.containerWorkDir} && git rev-parse HEAD`)
    if (!statusOut.trim()) {
      await env.log('docker', `git status: nothing to commit`)
      return { commitHash: headHash.trim(), branch }
    }
    await env.log('docker', `git add -A && git commit && git push origin ${branch}`)
    await dockerExec(env.containerId, `cd ${env.containerWorkDir} && git add -A && git commit -m "${message.replace(/"/g, '\\"')}"`)
    await dockerExec(env.containerId, `cd ${env.containerWorkDir} && git push --force-with-lease origin ${branch}`)
    const { stdout } = await dockerExec(env.containerId, `cd ${env.containerWorkDir} && git rev-parse HEAD`)
    return { commitHash: stdout.trim(), branch }
  }

  async resetIteration(env: ExecutionEnvironment, acceptedPatches: FilePatch[]): Promise<void> {
    await dockerExec(env.containerId, `cd ${env.containerWorkDir} && git reset --hard HEAD`)
    await dockerCpToLocal(env.containerId, env.containerWorkDir, env.localWorkDir)
    for (const patch of acceptedPatches) {
      await this.applyPatch(env, patch)
    }
  }

  async cleanup(env: ExecutionEnvironment): Promise<void> {
    try {
      await exec(`docker stop ${env.containerId}`)
    } catch { /* container may already be gone */ }
    try {
      await rm(env.localWorkDir, { recursive: true, force: true })
    } catch { /* best effort */ }
  }
}

/**
 * Parse verbose vitest output to produce a human-readable progress note.
 * Used to enrich TEST_TIMEOUT diagnostics: "42/118 tests completed. Last active: auth.test.ts"
 */
function parseTestProgress(output: string): string {
  // Count completed tests: lines starting with " ✓" or " ×" (passed/failed individual tests)
  const completedMatches = output.match(/^\s+[✓×✔✗x]\s+/gm)
  const completed = completedMatches?.length ?? 0

  // Count total discovered tests: vitest prints "Test Files  N passed" or "Tests  N passed | N failed | N todo"
  // Also look for "collected N tests" in the run preamble
  let total = 0
  const collectedMatch = output.match(/collected\s+(\d+)\s+test/i)
  if (collectedMatch) {
    total = parseInt(collectedMatch[1]!)
  } else {
    // Sum up "X passed", "X failed", "X skipped" from summary line
    const passedM = output.match(/(\d+)\s+passed/i)
    const failedM = output.match(/(\d+)\s+failed/i)
    const skippedM = output.match(/(\d+)\s+skipped/i)
    total = (passedM ? parseInt(passedM[1]!) : 0)
          + (failedM ? parseInt(failedM[1]!) : 0)
          + (skippedM ? parseInt(skippedM[1]!) : 0)
  }

  // Find the last test file being run: lines like " RUNS  src/..."  or "✓ src/..." with a file path
  let lastFile: string | null = null
  const fileLineRe = /(?:RUNS?|✓|×|✔|✗|FAIL|PASS)\s+([\w./\-]+\.test\.[jt]sx?)/g
  let m: RegExpExecArray | null
  while ((m = fileLineRe.exec(output)) !== null) {
    lastFile = m[1]!
  }
  // Fallback: last line containing a .test. path
  if (!lastFile) {
    const pathMatches = [...output.matchAll(/([\w./\-]+\.test\.[jt]sx?)/g)]
    if (pathMatches.length > 0) lastFile = pathMatches[pathMatches.length - 1]![1]!
  }
  // Strip leading path noise (keep last 2 segments)
  if (lastFile) {
    const parts = lastFile.split('/')
    lastFile = parts.slice(-2).join('/')
  }

  const parts: string[] = []
  if (completed > 0 || total > 0) {
    parts.push(total > 0 ? `${completed}/${total} tests completed` : `${completed} tests completed`)
  }
  if (lastFile) parts.push(`Last active: ${lastFile}`)
  return parts.length > 0 ? parts.join('. ') : 'No test output captured before timeout'
}

// Classify failure type from verbose/plain-text vitest output (after JSON parse fails or inconsistency retry)
function classifyFromVerboseOutput(output: string, exitCode: number): TestFailureType {
  if (exitCode === 124 || /timed? ?out/i.test(output)) return 'TEST_TIMEOUT'

  if (
    /cannot parse/i.test(output) ||
    /parse failed/i.test(output) ||
    /expected a semicolon/i.test(output) ||
    /unexpected token/i.test(output)
  ) return 'TEST_CONFIG_ERROR'

  if (
    /cannot find module/i.test(output) ||
    /failed to resolve import/i.test(output) ||
    /transform failed/i.test(output) ||
    /error\[plugin\]/i.test(output)
  ) return 'TEST_CONFIG_ERROR'

  if (
    /no test files found/i.test(output) ||
    /no tests ran/i.test(output)
  ) return 'NO_TESTS_FOUND'

  if (/failed suites/i.test(output) || /failed to run/i.test(output)) return 'TEST_CONFIG_ERROR'

  return 'INCONSISTENT_TEST_RESULT'
}

function classifyTestFailureType(failures: TestResult['failures'], output: string, exitCode: number): TestFailureType {
  if (exitCode === 124 || /timed? ?out/i.test(output)) return 'TEST_TIMEOUT'

  // Config / setup errors — no tests collected
  if (
    /no test files found/i.test(output) ||
    /0 tests/i.test(output) ||
    /no tests ran/i.test(output)
  ) return 'NO_TESTS_FOUND'

  if (
    /error: cannot find module/i.test(output) ||
    /failed to resolve import/i.test(output) ||
    /transform failed/i.test(output) ||
    /error\[plugin\]/i.test(output) ||
    /vitest could not resolve/i.test(output)
  ) return 'TEST_CONFIG_ERROR'

  if (failures.length === 0) return 'UNKNOWN_NONZERO_EXIT'

  // Classify based on failure messages
  const errorMessages = failures.map(f => f.error).join('\n')

  if (
    /uncaught (reference|type|syntax|range)error/i.test(errorMessages) ||
    /cannot read propert/i.test(errorMessages) ||
    /is not a function/i.test(errorMessages) ||
    /cannot access.*before initialization/i.test(errorMessages)
  ) return 'TEST_RUNTIME_ERROR'

  // Default: actual assertion failures
  return 'TEST_ASSERTION_FAILURE'
}

function parseVitestJson(output: string, raw?: TestRawOutput): TestResult {
  const exitCode = raw?.exitCode ?? -1

  try {
    // vitest --reporter=json emits the JSON object as a line starting with '{'.
    // Use /^{/m so we don't false-match on inline objects in vite warning messages
    // (e.g. "The following esbuild options were set: `{ jsx: 'automatic' }`").
    const jsonStart = output.search(/^\{/m)
    if (jsonStart === -1) throw new Error('No JSON found')
    const json = JSON.parse(output.slice(jsonStart))
    const numTotalTests = json.numTotalTests ?? 0
    const numFailedTests = json.numFailedTests ?? 0
    const numPassedTests = json.numPassedTests ?? 0
    const failures: TestResult['failures'] = []
    for (const suite of json.testResults ?? []) {
      for (const result of suite.assertionResults ?? []) {
        if (result.status === 'failed') {
          failures.push({ testName: result.fullName ?? result.title, error: result.failureMessages?.join('\n') ?? '' })
        }
      }
    }
    const passed = numFailedTests === 0 && (exitCode === 0 || exitCode === -1)
    const failureType = passed ? undefined : classifyTestFailureType(failures, output, exitCode)
    return { passed, failures, output, testsRun: numTotalTests, testsPassed: numPassedTests, testsFailed: numFailedTests, failureType, raw }
  } catch {
    // JSON parse failed — determine if it's a config error or unknown.
    // Trust exit code first: exit 0 means vitest considers everything passed.
    const lowerOut = output.toLowerCase()
    const failed = exitCode > 0 || (exitCode === -1 && (lowerOut.includes('fail') || lowerOut.includes('error')))
    const passed = !failed

    let failureType: TestFailureType | undefined
    if (!passed) {
      if (lowerOut.includes('no test files') || lowerOut.includes('no tests')) {
        failureType = 'NO_TESTS_FOUND'
      } else if (
        lowerOut.includes('cannot find module') ||
        lowerOut.includes('transform failed') ||
        lowerOut.includes('failed to resolve')
      ) {
        failureType = 'TEST_CONFIG_ERROR'
      } else {
        failureType = 'PARSER_ERROR'
      }
    }

    return { passed, failures: [], output, testsRun: 0, testsPassed: 0, testsFailed: 0, failureType, raw }
  }
}
