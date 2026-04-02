import { Project, Node } from 'ts-morph'
import type { BehavioralResult, BehavioralAnomaly } from './types'

function countNodes(code: string, predicate: (node: Node) => boolean): number {
  const p = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const sf = p.createSourceFile('__check__.ts', code, { overwrite: true })
  let count = 0
  sf.forEachDescendant(n => { if (predicate(n)) count++ })
  return count
}

function hasEmptyCatch(code: string): boolean {
  const p = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const sf = p.createSourceFile('__check__.ts', code, { overwrite: true })
  let found = false
  sf.forEachDescendant(n => {
    if (Node.isCatchClause(n)) {
      const block = n.getBlock()
      if (block.getStatements().length === 0) found = true
    }
  })
  return found
}

function countEarlyReturnsInBranches(code: string): number {
  const p = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const sf = p.createSourceFile('__check__.ts', code, { overwrite: true })
  let count = 0
  sf.forEachDescendant(n => {
    if (Node.isReturnStatement(n)) {
      const parent = n.getParent()
      const grandParent = parent?.getParent()
      if (grandParent && Node.isIfStatement(grandParent)) count++
    }
  })
  return count
}

export function checkBehavior(beforeCode: string, afterCode: string): BehavioralResult {
  const anomalies: BehavioralAnomaly[] = []

  const beforeIfs = countNodes(beforeCode, n => Node.isIfStatement(n))
  const afterIfs  = countNodes(afterCode,  n => Node.isIfStatement(n))
  if (afterIfs < beforeIfs) {
    anomalies.push({
      type: 'removed_conditional',
      description: `${beforeIfs - afterIfs} conditional(s) removed`,
      severity: 'error',
    })
  }

  if (!hasEmptyCatch(beforeCode) && hasEmptyCatch(afterCode)) {
    anomalies.push({
      type: 'exception_swallowing',
      description: 'Empty catch block introduced — exceptions are being silently swallowed',
      severity: 'error',
    })
  }

  const beforeEarlyReturns = countEarlyReturnsInBranches(beforeCode)
  const afterEarlyReturns  = countEarlyReturnsInBranches(afterCode)
  if (afterEarlyReturns > beforeEarlyReturns) {
    anomalies.push({
      type: 'early_return',
      description: `${afterEarlyReturns - beforeEarlyReturns} early return(s) added inside conditional branch(es)`,
      severity: 'warning',
    })
  }

  const hasError = anomalies.some(a => a.severity === 'error')
  return { passed: !hasError, anomalies }
}
