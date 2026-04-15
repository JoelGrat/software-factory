import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { CodeExecutor } from './executors/code-executor'
import type { ExecutionEnvironment } from './types'
import type { DiagnosticSet, RepairAttempt } from './execution-types-v2'
import { toConfidenceLabel } from './execution-types-v2'
import { isPathAllowed } from './repair-guard'
import { insertEvent } from './event-emitter'

// Strategy 0 (attempt 0): targeted patch — fix exactly the listed errors, minimal change.
function buildTargetedPatchPrompt(
  diagnostics: DiagnosticSet,
  fileContexts: Record<string, string>,
  repoPatterns: string,
): string {
  const diagLines = diagnostics.diagnostics
    .map(d => `${d.file}:${d.line} [${d.code}] ${d.message}`)
    .join('\n')

  const fileSection = Object.entries(fileContexts)
    .map(([path, content]) => `// === ${path} ===\n${content}`)
    .join('\n\n')

  return `You are fixing TypeScript/lint errors. Fix ONLY the listed errors. Do not refactor or change unrelated code.

ERRORS TO FIX:
${diagLines}

FILE CONTENTS:
${fileSection}
${repoPatterns}
RULES:
- Fix only the listed errors. Do not refactor or change unrelated code.
- When an error says a package has no exported member, look at the REPO IMPORT PATTERNS above — this codebase may wrap that package through a local module. Follow the local convention exactly.
- Do not invent imports based on training data if the repo already shows the correct pattern above.

Respond with JSON:
{
  "patches": [
    { "file": "path/to/file.ts", "newContent": "full file content after fix" }
  ],
  "confidence": 0.85,
  "rationale": "one sentence, max 140 chars"
}`
}

// Strategy 1 (attempt 1): wider context — same goal but with broader type information injected.
// Used when the targeted patch failed, suggesting the AI needs more surrounding context.
function buildWiderContextPrompt(
  diagnostics: DiagnosticSet,
  fileContexts: Record<string, string>,
  repoPatterns: string,
): string {
  const diagLines = diagnostics.diagnostics
    .map(d => `${d.file}:${d.line} [${d.code}] ${d.message}`)
    .join('\n')

  const fileSection = Object.entries(fileContexts)
    .map(([path, content]) => `// === ${path} ===\n${content}`)
    .join('\n\n')

  return `A previous repair attempt did not resolve these TypeScript errors. Try a different fix.

ERRORS TO FIX (second attempt):
${diagLines}

FILE CONTENTS:
${fileSection}
${repoPatterns}
GUIDANCE FOR THIS ATTEMPT:
- The first fix attempt failed — look more carefully at the types involved.
- For import errors: the package may be re-exported through a local wrapper. Check REPO IMPORT PATTERNS.
- For type mismatches: the type definition in the repo may differ from your training data — use \`as\` casting or adjust the shape to match what is actually imported.
- For missing properties: check whether the interface requires additional fields and add them with sensible defaults.
- Rewrite the entire affected file if incremental changes are not enough to converge.

Respond with JSON:
{
  "patches": [
    { "file": "path/to/file.ts", "newContent": "full file content after fix" }
  ],
  "confidence": 0.85,
  "rationale": "one sentence, max 140 chars"
}`
}

// Strategy 2 (attempt 2+): typed mock rewrite — abandon incremental patching.
// When two prior attempts have not converged, rewrite the file from scratch with
// explicit vi.mock() stubs for every external dependency.
function buildTypedMockRewritePrompt(
  diagnostics: DiagnosticSet,
  fileContexts: Record<string, string>,
  repoPatterns: string,
): string {
  const diagLines = diagnostics.diagnostics
    .map(d => `${d.file}:${d.line} [${d.code}] ${d.message}`)
    .join('\n')

  const fileSection = Object.entries(fileContexts)
    .map(([path, content]) => `// === ${path} ===\n${content}`)
    .join('\n\n')

  return `Two repair attempts have not converged. Take a fundamentally different approach: full typed mock rewrite.

ERRORS TO FIX (third attempt — full rewrite strategy):
${diagLines}

FILE CONTENTS:
${fileSection}
${repoPatterns}
REWRITE STRATEGY — follow exactly:
1. REWRITE the entire file. Do not incrementally patch.
2. For every external module import (Supabase, fetch, database, network clients, third-party SDKs):
   - Replace the import with \`vi.mock('module-name')\` at the top of the file.
   - Create a typed mock constant: \`const mockFn = vi.fn().mockResolvedValue(defaultValue)\`.
   - Ensure the mock satisfies the TypeScript type expected by the code under test.
3. For Supabase specifically: mock the chained builder (\`.from().select().eq()\` etc.) not just the client.
4. Keep test assertions and test logic intact — only change the dependency setup.
5. Priority: TypeScript compiles clean first, tests pass second.

Respond with JSON:
{
  "patches": [
    { "file": "path/to/file.ts", "newContent": "full file content after fix" }
  ],
  "confidence": 0.85,
  "rationale": "one sentence, max 140 chars"
}`
}

function buildInlineRepairPrompt(
  diagnostics: DiagnosticSet,
  fileContexts: Record<string, string>,
  repoPatterns: string,
  attemptNumber: number,
): string {
  if (attemptNumber >= 2) return buildTypedMockRewritePrompt(diagnostics, fileContexts, repoPatterns)
  if (attemptNumber === 1) return buildWiderContextPrompt(diagnostics, fileContexts, repoPatterns)
  return buildTargetedPatchPrompt(diagnostics, fileContexts, repoPatterns)
}

// Search the repo for files that already successfully import from the same packages
// referenced in the failing diagnostics. The first few matches become reference
// examples in the repair prompt so the AI follows local conventions.
async function findRepoImportPatterns(
  localWorkDir: string,
  diagnostics: DiagnosticSet,
  brokenFiles: string[],
): Promise<string> {
  // Extract package names from import-related errors only
  const importPkgs = [...new Set(
    diagnostics.diagnostics
      .map(d => {
        const m = d.message.match(/Module ['"]([^'"]+)['"] has no exported member/)
          ?? d.message.match(/Cannot find module ['"]([^'"]+)['"] or its corresponding/)
          ?? d.message.match(/has no default export.*['"]([^'"]+)['"]/)
        return m?.[1] ?? null
      })
      .filter((p): p is string => p !== null && !p.startsWith('.')),
  )]

  if (importPkgs.length === 0) return ''

  const { readFile, readdir } = await import('node:fs/promises')
  const { join } = await import('node:path')

  const contextParts: string[] = []
  const seen = new Set<string>()

  async function scanDir(relDir: string, depth: number): Promise<void> {
    if (depth > 3 || seen.size >= 4) return
    let entries
    try { entries = await readdir(join(localWorkDir, relDir), { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (seen.size >= 4) break
      const relPath = `${relDir}/${entry.name}`
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        await scanDir(relPath, depth + 1)
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !brokenFiles.includes(relPath)) {
        let content: string
        try { content = await readFile(join(localWorkDir, relPath), 'utf8') } catch { continue }
        const hasMatch = importPkgs.some(pkg =>
          content.includes(`from '${pkg}'`) || content.includes(`from "${pkg}"`)
        )
        if (hasMatch) {
          // Show just the first 25 lines — the import block is all we need
          const preview = content.split('\n').slice(0, 25).join('\n')
          contextParts.push(`// === ${relPath} ===\n${preview}`)
          seen.add(relPath)
        }
      }
    }
  }

  for (const dir of ['lib', 'app', 'components']) {
    await scanDir(dir, 0)
    if (seen.size >= 4) break
  }

  if (contextParts.length === 0) return ''

  return `\nREPO IMPORT PATTERNS (files that already successfully import from the same packages — follow these conventions exactly):\n${contextParts.join('\n\n')}\n`
}

export async function runInlineRepair(
  db: SupabaseClient,
  ai: AIProvider,
  executor: CodeExecutor,
  env: ExecutionEnvironment,
  runId: string,
  changeId: string,
  iteration: number,
  diagnostics: DiagnosticSet,
  seq: () => number,
  /** 0-based attempt index within this iteration — drives escalating prompt strategy */
  attemptNumber = 0,
): Promise<RepairAttempt> {
  const startMs = Date.now()

  await insertEvent(db, {
    runId, changeId, seq: seq(), iteration,
    eventType: 'repair.inline.started',
    payload: {},
  })

  // Gather file contents for affected files (allowed only, max 3)
  const affectedFiles = [...new Set(diagnostics.diagnostics.map(d => d.file))]
    .filter(isPathAllowed)
    .slice(0, 3)

  const fileContexts: Record<string, string> = {}
  for (const filePath of affectedFiles) {
    try {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      fileContexts[filePath] = await readFile(join(env.localWorkDir, filePath), 'utf8')
    } catch { /* skip unreadable files */ }
  }

  // Search the repo for files that already use the same packages — gives the AI
  // concrete local conventions to follow instead of relying on training-data guesses.
  const repoPatterns = await findRepoImportPatterns(env.localWorkDir, diagnostics, affectedFiles)

  const prompt = buildInlineRepairPrompt(diagnostics, fileContexts, repoPatterns, attemptNumber)
  const aiResult = await ai.complete(prompt, { maxTokens: 4096 })

  let parsed: { patches?: { file: string; newContent: string }[]; confidence?: number; rationale?: string } = {}
  try {
    const stripped = aiResult.content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim()
    parsed = JSON.parse(stripped)
  } catch { /* leave parsed empty */ }

  const patches = (parsed.patches ?? []).filter(p => isPathAllowed(p.file))
  const filesPatched: string[] = []

  for (const patch of patches.slice(0, 3)) {
    const result = await executor.createFile(env, patch.file, patch.newContent)
    if (result.success) filesPatched.push(patch.file)
  }

  const confidenceScore = (parsed.confidence ?? 0.5)
  const rationale = (parsed.rationale ?? 'inline repair applied').slice(0, 140)
  const durationMs = Date.now() - startMs

  const attempt: RepairAttempt = {
    phase: 'inline',
    filesPatched,
    diagnosticsTargeted: diagnostics.diagnostics.map(d => `${d.file}:${d.line}:${d.code}`),
    confidenceScore,
    confidenceLabel: toConfidenceLabel(confidenceScore),
    rationale,
  }

  await insertEvent(db, {
    runId, changeId, seq: seq(), iteration,
    eventType: filesPatched.length > 0 ? 'repair.inline.succeeded' : 'repair.inline.failed',
    payload: { attempt, durationMs },
  })

  return attempt
}
