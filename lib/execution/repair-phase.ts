import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { CodeExecutor } from './executors/code-executor'
import type { ExecutionEnvironment } from './types'
import type { DiagnosticSet, RepairAttempt } from './execution-types-v2'
import { toConfidenceLabel } from './execution-types-v2'
import { isPathAllowed } from './repair-guard'
import { insertEvent } from './event-emitter'

function buildRepairPhasePrompt(
  failures: DiagnosticSet,
  changeIntent: string,
  fileContexts: Record<string, string>,
): string {
  const failureLines = failures.diagnostics
    .map(d => `${d.file}:${d.line} — ${d.message}`)
    .join('\n')

  const fileSection = Object.entries(fileContexts)
    .map(([path, content]) => `// === ${path} ===\n${content}`)
    .join('\n\n')

  return `You are fixing test failures in a TypeScript/Next.js codebase.
Change intent: ${changeIntent}

FAILURES:
${failureLines}
${failures.truncated ? `(${failures.totalCount} total failures — showing first ${failures.diagnostics.length})` : ''}

FILE CONTENTS:
${fileSection}

Analyze the root cause. Fix the underlying issue — not just the symptom. Do not change unrelated code.

Respond with JSON:
{
  "patches": [
    { "file": "path/to/file.ts", "newContent": "full file content after fix" }
  ],
  "confidence": 0.72,
  "rationale": "one sentence root cause and fix summary, max 140 chars"
}`
}

export async function runRepairPhase(
  db: SupabaseClient,
  ai: AIProvider,
  executor: CodeExecutor,
  env: ExecutionEnvironment,
  runId: string,
  changeId: string,
  iteration: number,
  failures: DiagnosticSet,
  changeIntent: string,
  seq: () => number,
): Promise<RepairAttempt> {
  const startMs = Date.now()

  await insertEvent(db, {
    runId, changeId, seq: seq(), iteration,
    eventType: 'repair.phase.started',
    payload: {},
  })

  const affectedFiles = [...new Set(failures.diagnostics.map(d => d.file))]
    .filter(isPathAllowed)
    .slice(0, 8)

  const fileContexts: Record<string, string> = {}
  for (const filePath of affectedFiles) {
    try {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      fileContexts[filePath] = await readFile(join(env.localWorkDir, filePath), 'utf8')
    } catch { /* skip */ }
  }

  const prompt = buildRepairPhasePrompt(failures, changeIntent, fileContexts)
  const aiResult = await ai.complete(prompt, { maxTokens: 8192 })

  let parsed: { patches?: { file: string; newContent: string }[]; confidence?: number; rationale?: string } = {}
  try {
    const stripped = aiResult.content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim()
    parsed = JSON.parse(stripped)
  } catch { /* leave empty */ }

  const patches = (parsed.patches ?? []).filter(p => isPathAllowed(p.file))
  const filesPatched: string[] = []

  for (const patch of patches.slice(0, 8)) {
    const result = await executor.createFile(env, patch.file, patch.newContent)
    if (result.success) filesPatched.push(patch.file)
  }

  const confidenceScore = parsed.confidence ?? 0
  const rationale = parsed.rationale
    ? parsed.rationale.slice(0, 140)
    : filesPatched.length > 0
      ? `Patched ${filesPatched.map(f => f.split('/').pop()).join(', ')} — AI response unparseable`
      : 'No viable fix identified'
  const durationMs = Date.now() - startMs

  const attempt: RepairAttempt = {
    phase: 'repair_phase',
    filesPatched,
    diagnosticsTargeted: failures.diagnostics.map(d => `${d.file}:${d.line}`),
    confidenceScore,
    confidenceLabel: toConfidenceLabel(confidenceScore),
    rationale,
  }

  await insertEvent(db, {
    runId, changeId, seq: seq(), iteration,
    eventType: filesPatched.length > 0 ? 'repair.phase.succeeded' : 'repair.phase.failed',
    payload: { attempt, durationMs },
  })

  return attempt
}
