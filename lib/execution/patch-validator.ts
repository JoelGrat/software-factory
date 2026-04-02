import { Project, Node } from 'ts-morph'
import type { SourceFile } from 'ts-morph'
import type { FilePatch, ValidationResult } from './types'
import { resolveNode } from './node-locator'

export function validatePatch(sf: SourceFile, patch: FilePatch): ValidationResult {
  // Stage 1: intent enforcement — locator must point to a symbol in allowedChanges
  const node = resolveNode(sf, patch.locator)
  if (!node) {
    return { valid: false, stage: 'stale', reason: 'Node not found by locator' }
  }

  // Get symbol name from node (works around missing Node.isNamedNode in some ts-morph versions)
  let symbolName: string | undefined
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) || Node.isClassDeclaration(node)) {
    symbolName = (node as unknown as { getName(): string | undefined }).getName()
  } else if (Node.isVariableDeclaration(node)) {
    symbolName = node.getName()
  }

  if (symbolName && !patch.allowedChanges.symbols.includes(symbolName)) {
    return {
      valid: false,
      stage: 'intent',
      reason: `Locator resolved to '${symbolName}' which is not in allowedChanges.symbols: [${patch.allowedChanges.symbols.join(', ')}]`,
    }
  }

  // Stage 2: semantic scope — newContent should not introduce additional top-level declarations
  const topLevelCount = (code: string) =>
    (code.match(/^(?:export\s+)?(?:function|class|const|let|var)\s+/gm) ?? []).length
  if (topLevelCount(patch.newContent) > topLevelCount(patch.originalContent) + 1) {
    return {
      valid: false,
      stage: 'semantic',
      reason: 'Patch introduces more top-level declarations than expected',
    }
  }

  // Stage 3: AST syntax — parse newContent in isolation
  const tempProject = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const tempSf = tempProject.createSourceFile('__temp__.ts', patch.newContent, { overwrite: true })
  const diagnostics = tempSf.getPreEmitDiagnostics()
  const syntaxErrors = diagnostics.filter(d => d.getCategory() === 1 /* error */)
  if (syntaxErrors.length > 0) {
    return {
      valid: false,
      stage: 'syntax',
      reason: syntaxErrors[0]!.getMessageText().toString(),
    }
  }

  // Stage 4: stale-node check
  if (node.getText() !== patch.originalContent) {
    return {
      valid: false,
      stage: 'stale',
      reason: 'Node text has changed since patch was generated — re-fetch required',
    }
  }

  return { valid: true }
}
