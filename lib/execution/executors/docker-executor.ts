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
  TestResult, BehavioralResult, BehavioralScope, DiffSummary,
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
    const cmd = filter
      ? `cd ${env.containerWorkDir} && npx vitest run ${filter} --reporter=json 2>&1`
      : `cd ${env.containerWorkDir} && npx vitest run --reporter=json 2>&1`

    await env.log('docker', filter ? `npx vitest run ${filter}` : `npx vitest run`)
    try {
      const { stdout } = await dockerExec(env.containerId, cmd)
      return parseVitestJson(stdout)
    } catch (err) {
      const output = (err as { stdout?: string }).stdout ?? String(err)
      return parseVitestJson(output)
    }
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

function parseVitestJson(output: string): TestResult {
  try {
    const jsonStart = output.indexOf('{')
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
    return { passed: numFailedTests === 0, failures, output, testsRun: numTotalTests, testsPassed: numPassedTests, testsFailed: numFailedTests }
  } catch {
    const passed = !output.includes('FAIL') && !output.includes('failed')
    return { passed, failures: [], output, testsRun: 0, testsPassed: 0, testsFailed: 0 }
  }
}
