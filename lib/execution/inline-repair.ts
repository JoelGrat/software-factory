import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { CodeExecutor } from './executors/code-executor'
import type { ExecutionEnvironment } from './types'
import type { DiagnosticSet, RepairAttempt } from './execution-types-v2'
import { toConfidenceLabel } from './execution-types-v2'
import { isPathAllowed } from './repair-guard'
import { insertEvent } from './event-emitter'

function buildInlineRepairPrompt(diagnostics: DiagnosticSet, fileContexts: Record<string, string>): string {
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

RULES:
- Fix only the listed errors. Do not refactor or change unrelated code.
- Missing module errors are handled automatically by the system before this prompt runs — do not try to fix them by changing imports or tsconfig.

Respond with JSON:
{
  "patches": [
    { "file": "path/to/file.ts", "newContent": "full file content after fix" }
  ],
  "confidence": 0.85,
  "rationale": "one sentence, max 140 chars"
}`
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

  const prompt = buildInlineRepairPrompt(diagnostics, fileContexts)
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
