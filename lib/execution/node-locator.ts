// lib/execution/node-locator.ts
import { createHash } from 'node:crypto'
import { Node, SyntaxKind, FunctionDeclaration, MethodDeclaration, ClassDeclaration, InterfaceDeclaration, TypeAliasDeclaration, EnumDeclaration, VariableDeclaration } from 'ts-morph'
import type { SourceFile } from 'ts-morph'
import type { NodeLocator } from './types'

function shortHash(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 16)
}

function nodeStructureSignature(node: Node): string {
  let paramCount = 0
  let returnTypeText = ''
  const text = node.getText()
  const paramMatch = text.match(/\(([^)]*)\)/)
  const params = paramMatch?.[1]?.trim() ?? ''
  paramCount = params.length === 0 ? 0 : params.split(',').length
  const returnMatch = text.match(/\):\s*([^{]+)\s*{/)
  returnTypeText = returnMatch?.[1]?.trim() ?? ''
  return shortHash(`${paramCount}:${returnTypeText}`)
}

export function buildLocator(filePath: string, node: Node): NodeLocator {
  const startLine = node.getStartLineNumber()
  const snippet = node.getText().slice(0, 50)
  const primary = shortHash(`${filePath}:${node.getKind()}:${startLine}:${snippet}`)

  let symbolName: string | undefined
  symbolName = getNodeName(node)

  return {
    primary,
    fallbacks: {
      symbolName,
      kind: node.getKind(),
      approximatePosition: { line: startLine, toleranceLines: 5 },
      structureSignature: nodeStructureSignature(node),
    },
  }
}

export function resolveNode(sf: SourceFile, locator: NodeLocator): Node | null {
  const { primary, fallbacks } = locator

  // Strategy 1: primary hash
  const primaryMatch = findByPrimaryHash(sf, primary, fallbacks.kind)
  if (primaryMatch !== null) return primaryMatch

  // Strategy 2: symbolName match
  if (fallbacks.symbolName) {
    const byName = findByName(sf, fallbacks.symbolName, fallbacks.kind)
    if (byName === 'ambiguous') return null
    if (byName !== null) return byName
  }

  // Strategy 3: approximate position + structure signature
  const byPosition = findByPosition(sf, fallbacks)
  if (byPosition === 'ambiguous') return null
  if (byPosition !== null) return byPosition

  return null
}

function findByPrimaryHash(sf: SourceFile, primary: string, kind: number): Node | null {
  const filePath = sf.getFilePath()
  const matches: Node[] = []
  sf.forEachDescendant((node) => {
    if (node.getKind() !== kind) return
    const startLine = node.getStartLineNumber()
    const snippet = node.getText().slice(0, 50)
    const hash = shortHash(`${filePath}:${kind}:${startLine}:${snippet}`)
    if (hash === primary) matches.push(node)
  })
  if (matches.length === 1) return matches[0]!
  return null
}

function getNodeName(node: Node): string | undefined {
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) ||
      Node.isClassDeclaration(node) || Node.isInterfaceDeclaration(node) ||
      Node.isTypeAliasDeclaration(node) || Node.isEnumDeclaration(node) ||
      Node.isVariableDeclaration(node) || Node.isFunctionExpression(node) ||
      Node.isArrowFunction(node)) {
    const n = node as unknown as { getName?: () => string | undefined }
    return n.getName?.()
  }
  return undefined
}

function findByName(sf: SourceFile, name: string, kind: number): Node | 'ambiguous' | null {
  const matches: Node[] = []
  sf.forEachDescendant((node) => {
    if (node.getKind() !== kind) return
    if (getNodeName(node) === name) matches.push(node)
  })
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) return 'ambiguous'
  return null
}

function findByPosition(
  sf: SourceFile,
  fallbacks: NodeLocator['fallbacks']
): Node | 'ambiguous' | null {
  const { kind, approximatePosition: { line, toleranceLines }, structureSignature } = fallbacks
  const candidates: Node[] = []
  sf.forEachDescendant((node) => {
    if (node.getKind() !== kind) return
    const nodeLine = node.getStartLineNumber()
    if (Math.abs(nodeLine - line) <= toleranceLines) candidates.push(node)
  })
  if (candidates.length === 0) return null

  // narrow by structure signature
  const sigMatches = candidates.filter(n => nodeStructureSignature(n) === structureSignature)
  if (sigMatches.length === 1) return sigMatches[0]!
  if (sigMatches.length > 1) return 'ambiguous'

  // no sig match — fall back to position-only if unambiguous
  if (candidates.length === 1) return candidates[0]!
  return 'ambiguous'
}
