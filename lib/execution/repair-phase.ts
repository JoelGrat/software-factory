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

// Timeout-specific repair: tests hung because async I/O was never mocked.
// Attempt 0 — targeted mock surgery: identify and mock the specific hanging calls.
// Attempt 1 — full mock rewrite: replace every external dependency unconditionally.
function buildTimeoutRepairPrompt(
  failures: DiagnosticSet,
  changeIntent: string,
  fileContexts: Record<string, string>,
  attemptNumber: number,
): string {
  const fileSection = Object.entries(fileContexts)
    .map(([path, content]) => `// === ${path} ===\n${content}`)
    .join('\n\n')

  const testFiles = Object.keys(fileContexts)
    .filter(p => /\.test\.|\.spec\./.test(p))
    .join(', ')

  if (attemptNumber === 0) {
    return `Tests are hanging (process-level timeout) in: ${testFiles || 'the test files below'}.
Change intent: ${changeIntent}

ROOT CAUSE: The test process never exits because one or more async operations — Supabase queries,
fetch calls, network clients, database connections — run without being mocked. They wait for a
real network that does not exist in the test container.

FILE CONTENTS:
${fileSection}

REPAIR INSTRUCTIONS:
1. Identify every import that touches external I/O: Supabase client, fetch, HTTP clients, database.
2. Add \`vi.mock('module-path')\` at the top of each test file for each such import.
3. For the Supabase client (lib/supabase/server or lib/supabase/client), mock the full builder chain:
   \`\`\`ts
   vi.mock('@/lib/supabase/server', () => ({
     createClient: vi.fn(() => ({
       from: vi.fn(() => ({
         select: vi.fn().mockReturnThis(),
         insert: vi.fn().mockReturnThis(),
         update: vi.fn().mockReturnThis(),
         delete: vi.fn().mockReturnThis(),
         upsert: vi.fn().mockReturnThis(),
         eq: vi.fn().mockReturnThis(),
         single: vi.fn().mockResolvedValue({ data: null, error: null }),
         maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
       })),
       auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }) },
     })),
   }))
   \`\`\`
4. For fetch, mock globally: \`global.fetch = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) })\`
5. Do NOT change test assertions or the code under test.

Respond with JSON:
{
  "patches": [
    { "file": "path/to/file.ts", "newContent": "full file content after fix" }
  ],
  "confidence": 0.72,
  "rationale": "one sentence describing what was mocked, max 140 chars"
}`
  }

  // Attempt 1+: first targeted pass did not fix the timeout. Full mock rewrite.
  return `A targeted mock fix did not resolve the test timeout in: ${testFiles || 'the test files below'}.
Change intent: ${changeIntent}

STRATEGY: Full mock rewrite. Do not attempt incremental patching.

FILE CONTENTS:
${fileSection}

FULL REWRITE INSTRUCTIONS:
1. Rewrite EVERY test file completely.
2. At the very top (before any imports are used), mock ALL external modules:
   - \`vi.mock('@/lib/supabase/server', ...)\` — full builder chain (select, insert, update, delete, upsert, eq, single, maybeSingle, auth.getUser)
   - \`vi.mock('@/lib/supabase/client', ...)\` — same
   - \`vi.mock('@/lib/ai/registry', () => ({ getProvider: vi.fn(() => ({ complete: vi.fn().mockResolvedValue({ content: '{}' }) })) }))\`
   - Any other \`@/lib/\` module that makes network calls
   - \`global.fetch\` if used
3. Use \`beforeEach(() => { vi.clearAllMocks() })\` to reset between tests.
4. Ensure every mock returns a sensible default that satisfies TypeScript types.
5. Keep all test assertions and describe/it structure intact.
6. Priority: test process exits cleanly within 10 seconds.

Respond with JSON:
{
  "patches": [
    { "file": "path/to/file.ts", "newContent": "full file content after fix" }
  ],
  "confidence": 0.72,
  "rationale": "one sentence describing the full mock rewrite, max 140 chars"
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
  /** 0-based attempt index — drives escalating prompt strategy */
  attemptNumber = 0,
  /** Failure type from the test runner — selects specialized prompt when 'TEST_TIMEOUT' */
  failureType?: string,
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

  const prompt = failureType === 'TEST_TIMEOUT'
    ? buildTimeoutRepairPrompt(failures, changeIntent, fileContexts, attemptNumber)
    : buildRepairPhasePrompt(failures, changeIntent, fileContexts)
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
