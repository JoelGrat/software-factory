// lib/execution/symbol-extractor.ts
import { Project, Node } from 'ts-morph'
import type { SymbolContext } from './types'
import { buildLocator } from './node-locator'

export function extractSymbol(
  filePath: string,
  sourceCode: string,
  symbolName: string,
  callerFilePaths: string[]
): SymbolContext | null {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const sf = project.createSourceFile(filePath, sourceCode, { overwrite: true })

  // Find named function or arrow function variable
  let targetNode: Node | null = null
  sf.forEachDescendant((node) => {
    if (targetNode) return
    if (
      (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) &&
      (node as unknown as { getName(): string | undefined }).getName() === symbolName
    ) {
      targetNode = node
    }
    // handle: export const foo = () => ...
    if (Node.isVariableDeclaration(node) && node.getName() === symbolName) {
      const init = node.getInitializer()
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        targetNode = node
      }
    }
  })

  if (!targetNode) return null

  const code = (targetNode as Node).getText()
  const locator = buildLocator(filePath, targetNode as Node)

  // Extract callees: identifiers that are called (CallExpression callee names)
  const callees: string[] = []
  ;(targetNode as Node).forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      const expr = node.getExpression()
      if (Node.isIdentifier(expr)) {
        const name = expr.getText()
        if (name !== symbolName && !callees.includes(name)) callees.push(name)
      } else if (Node.isPropertyAccessExpression(expr)) {
        const name = expr.getName()
        if (!callees.includes(name)) callees.push(name)
      }
    }
  })

  // Extract related types from type annotations in signature
  const relatedTypes: string[] = []
  ;(targetNode as Node).forEachDescendant((node) => {
    if (Node.isTypeReference(node)) {
      const name = node.getTypeName().getText()
      if (!relatedTypes.includes(name)) relatedTypes.push(name)
    }
  })

  const complexity = code.split('\n').length

  return {
    symbolName,
    filePath,
    code,
    locator,
    callers: callerFilePaths,
    callees,
    relatedTypes,
    complexity,
  }
}
