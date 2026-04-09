import type { SymbolContext } from './types'

interface PatchTask {
  description: string
  intent: string
}

const RESPONSE_SCHEMA = `
Return a JSON object with exactly these fields:
{
  "newContent": "<complete replacement code for the symbol only — not the surrounding file>",
  "confidence": <0-100 integer — your confidence this change is correct>,
  "requiresPropagation": <true if you changed the function signature (params or return type), false otherwise>,
  "reasoning": "<one sentence explanation>"
}
`.trim()

export function buildSymbolPatchPrompt(
  task: PatchTask,
  ctx: SymbolContext,
  previousError?: string
): string {
  return `You are a TypeScript code modification expert. Modify a specific symbol to implement the task below.

## Task
${task.description}

## Intent
${task.intent}

## Target Symbol
- **Name:** ${ctx.symbolName}
- **File:** ${ctx.filePath}
- **Allowed to modify:** only ${ctx.symbolName}

\`\`\`typescript
${ctx.code}
\`\`\`

## Context
- **Callers (files that use this symbol):** ${ctx.callers.join(', ') || 'none'}
- **Callees (what this symbol calls):** ${ctx.callees.join(', ') || 'none'}
- **Types used:** ${ctx.relatedTypes.join(', ') || 'none'}
${previousError ? `\n## Previous Attempt Failed\n${previousError}\nDo NOT repeat the same approach.\n` : ''}
## Output
${RESPONSE_SCHEMA}`
}

export function buildMultiSymbolPatchPrompt(
  task: PatchTask,
  contexts: SymbolContext[],
  previousError?: string
): string {
  const symbolsBlock = contexts
    .map(ctx => `### ${ctx.symbolName} (${ctx.filePath})\n\`\`\`typescript\n${ctx.code}\n\`\`\``)
    .join('\n\n')

  return `You are a TypeScript code modification expert. Modify the following symbols together as they are interdependent.

## Task
${task.description}

## Intent
${task.intent}

## Symbols to Modify
${symbolsBlock}
${previousError ? `\n## Previous Attempt Failed\n${previousError}\nDo NOT repeat the same approach.\n` : ''}
## Output
Return a JSON array, one entry per symbol:
[
  {
    "symbolName": "<name>",
    "newContent": "<replacement code>",
    "confidence": <0-100>,
    "requiresPropagation": <boolean>,
    "reasoning": "<one sentence>"
  }
]`
}

export function buildFilePatchPrompt(
  task: PatchTask,
  fileContent: string,
  filePath: string,
  previousError?: string
): string {
  return `You are a TypeScript code modification expert. Modify the file below to implement the task.

## Task
${task.description}

## Intent
${task.intent}

## File: ${filePath}
\`\`\`typescript
${fileContent}
\`\`\`
${previousError ? `\n## Previous Attempt Failed\n${previousError}\nDo NOT repeat the same approach.\n` : ''}
## Output
Return a JSON object:
{
  "newFileContent": "<complete updated file content>",
  "confidence": <0-100>,
  "requiresPropagation": <boolean>,
  "reasoning": "<one sentence>"
}`
}

export function buildNewFilePrompt(
  task: PatchTask,
  filePath: string,
  previousError?: string,
  availablePackages?: string[]
): string {
  return `You are a TypeScript code generation expert. Create a new file to implement the task below.

## Task
${task.description}

## Intent
${task.intent}

## New File Path
${filePath}
${availablePackages && availablePackages.length > 0 ? `\n## Available Packages\nOnly import from packages in this list. Do NOT import any package not listed here — it will cause a type error.\nIMPORTANT: Some packages on this list may lack TypeScript type declarations. Prefer packages that commonly ship their own types (e.g. react, zod, next). If you need a testing utility, prefer 'vitest' and '@vitest/coverage-v8' over @testing-library/* unless @testing-library/* appears in the list AND its corresponding @types package is also listed.\nList: ${availablePackages.join(', ')}\n` : ''}${previousError ? `\n## Previous Attempt Failed — Fix These Errors\n\`\`\`\n${previousError}\n\`\`\`\nDo NOT repeat the same imports or approach that caused these errors.\n` : ''}
## Output
Return a JSON object:
{
  "newFileContent": "<complete, valid TypeScript file content>",
  "confidence": <0-100 integer — your confidence this is correct>,
  "requiresPropagation": <true if this new file changes any existing public interface or re-exports a type that callers already depend on, false otherwise>,
  "reasoning": "<one sentence explanation>"
}`
}
