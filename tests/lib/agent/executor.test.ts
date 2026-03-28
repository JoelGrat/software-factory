import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LocalExecutor } from '@/lib/agent/executor'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmpDir: string
let executor: LocalExecutor

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-executor-test-'))
  executor = new LocalExecutor()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('getFileTree', () => {
  it('returns relative file paths', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'export {}')
    fs.mkdirSync(path.join(tmpDir, 'src'))
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export {}')
    const tree = await executor.getFileTree(tmpDir)
    expect(tree).toContain('index.ts')
    expect(tree).toContain(path.join('src', 'app.ts'))
  })

  it('excludes node_modules and .git', async () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules'))
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.js'), '')
    fs.mkdirSync(path.join(tmpDir, '.git'))
    fs.writeFileSync(path.join(tmpDir, '.git', 'config'), '')
    const tree = await executor.getFileTree(tmpDir)
    expect(tree.some(f => f.includes('node_modules'))).toBe(false)
    expect(tree.some(f => f.includes('.git'))).toBe(false)
  })
})

describe('readFile', () => {
  it('returns file content', async () => {
    fs.writeFileSync(path.join(tmpDir, 'hello.ts'), 'const x = 1')
    const content = await executor.readFile(tmpDir, 'hello.ts')
    expect(content).toBe('const x = 1')
  })

  it('throws if file does not exist', async () => {
    await expect(executor.readFile(tmpDir, 'missing.ts')).rejects.toThrow()
  })
})

describe('writeFiles', () => {
  it('creates new files and parent directories', async () => {
    await executor.writeFiles(tmpDir, [
      { path: 'src/components/Button.tsx', content: 'export {}', operation: 'create' },
    ])
    const content = fs.readFileSync(path.join(tmpDir, 'src', 'components', 'Button.tsx'), 'utf-8')
    expect(content).toBe('export {}')
  })

  it('overwrites existing files on modify', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'old')
    await executor.writeFiles(tmpDir, [
      { path: 'file.ts', content: 'new', operation: 'modify' },
    ])
    expect(fs.readFileSync(path.join(tmpDir, 'file.ts'), 'utf-8')).toBe('new')
  })
})

describe('detectTestCommand', () => {
  it('reads test script from package.json', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } })
    )
    const cmd = await executor.detectTestCommand(tmpDir)
    expect(cmd).toBe('vitest run')
  })

  it('throws if no test script found', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: {} }))
    await expect(executor.detectTestCommand(tmpDir)).rejects.toThrow('No test script')
  })
})
