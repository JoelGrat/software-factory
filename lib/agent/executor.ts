import fs from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
// TODO: replaced in Plan 2/3/4 — old types removed in migration 006
/* eslint-disable @typescript-eslint/no-explicit-any */
// import type { FileChange, TestResult } from '@/lib/supabase/types' // removed in migration 006

const execAsync = promisify(exec)

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'coverage', '.worktrees', 'out', '.turbo',
])

export interface IExecutor {
  getFileTree(projectPath: string): Promise<string[]>
  readFile(projectPath: string, filePath: string): Promise<string>
  readFiles(projectPath: string, filePaths: string[]): Promise<Record<string, string>>
  writeFiles(projectPath: string, changes: any[]): Promise<void>
  runTests(projectPath: string): Promise<any>
  detectTestCommand(projectPath: string): Promise<string>
  createBranch(projectPath: string, branchName: string): Promise<void>
  getGitDiff(projectPath: string): Promise<string>
}

export class LocalExecutor implements IExecutor {
  async getFileTree(projectPath: string): Promise<string[]> {
    const results: string[] = []
    const walk = (dir: string, rel: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name), path.join(rel, entry.name))
        } else {
          results.push(path.join(rel, entry.name))
        }
      }
    }
    walk(projectPath, '')
    return results
  }

  async readFile(projectPath: string, filePath: string): Promise<string> {
    return fs.readFileSync(path.join(projectPath, filePath), 'utf-8')
  }

  async readFiles(projectPath: string, filePaths: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {}
    for (const fp of filePaths) {
      try { result[fp] = await this.readFile(projectPath, fp) } catch { /* skip missing */ }
    }
    return result
  }

  async writeFiles(projectPath: string, changes: any[]): Promise<void> {
    for (const change of changes) {
      const abs = path.join(projectPath, change.path)
      if (change.operation === 'delete') {
        if (fs.existsSync(abs)) fs.unlinkSync(abs)
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, change.content, 'utf-8')
      }
    }
  }

  async detectTestCommand(projectPath: string): Promise<string> {
    const pkgPath = path.join(projectPath, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const cmd = pkg?.scripts?.test
    if (!cmd) throw new Error('No test script found in package.json scripts.test')
    return cmd
  }

  async runTests(projectPath: string): Promise<any> {
    const cmd = await this.detectTestCommand(projectPath)
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd: projectPath, timeout: 120_000 })
      const raw = stdout + stderr
      return this.parseTestOutput(raw, true)
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string }
      const raw = (e.stdout ?? '') + (e.stderr ?? '')
      return this.parseTestOutput(raw, false)
    }
  }

  private parseTestOutput(raw: string, success: boolean): any {
    const passedMatch = raw.match(/(\d+)\s+passed/)
    const failedMatch = raw.match(/(\d+)\s+failed/)
    const passed = passedMatch ? parseInt(passedMatch[1]) : 0
    const failed = failedMatch ? parseInt(failedMatch[1]) : 0

    const errorLines = raw.split('\n').filter(l =>
      l.includes('FAIL') || l.includes('Error:') || l.includes('✗') || l.includes('× ')
    )

    return { success, passed, failed, errors: errorLines.slice(0, 20), raw_output: raw.slice(0, 4000) }
  }

  async createBranch(projectPath: string, branchName: string): Promise<void> {
    // Validate branch name: only allow alphanumerics, hyphens, underscores, forward slashes
    if (!/^[a-zA-Z0-9/_-]+$/.test(branchName)) {
      throw new Error(`Invalid branch name: ${branchName}`)
    }
    await execAsync(`git checkout -b "${branchName}"`, { cwd: projectPath })
  }

  async getGitDiff(projectPath: string): Promise<string> {
    try {
      const { stdout } = await execAsync('git diff HEAD', { cwd: projectPath })
      return stdout
    } catch {
      return ''
    }
  }
}
