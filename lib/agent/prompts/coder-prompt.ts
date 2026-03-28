import type { ParsedItem } from '@/lib/requirements/parser'
import type { AgentPlan } from '@/lib/supabase/types'

export const CODER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          operation: { type: 'string', enum: ['create', 'modify', 'delete'] },
        },
        required: ['path', 'content', 'operation'],
      },
    },
  },
  required: ['changes'],
}

export function buildCoderPrompt(
  requirements: ParsedItem[],
  plan: Omit<AgentPlan, 'id' | 'job_id' | 'created_at'>,
  previousErrors: string[],
  currentFileContents: Record<string, string>
): string {
  const errorsSection = previousErrors.length > 0
    ? `\n\n--- PREVIOUS TEST FAILURES (fix these) ---\n${previousErrors.join('\n')}\n--- END ---`
    : ''

  const filesSection = Object.entries(currentFileContents).length > 0
    ? `\n\n--- CURRENT FILE CONTENTS ---\n${Object.entries(currentFileContents).map(([fp, c]) => `=== ${fp} ===\n${c.slice(0, 3000)}`).join('\n\n')}\n--- END ---`
    : ''

  return `You are a senior software engineer. Implement the plan below to satisfy the requirements.

Rules:
- Output FULL file content for every file you create or modify. Never output diffs or partial files.
- For every file you create or modify, ALSO write or update its test file.
- Follow the existing code style visible in current file contents.
- changes: array of file changes. Each change has path (relative), content (full file text), operation (create|modify|delete).

Return ONLY valid JSON. No commentary.

--- REQUIREMENTS ---
${requirements.map(r => `[${r.priority.toUpperCase()}] ${r.title}: ${r.description}`).join('\n')}
--- END ---

--- PLAN ---
Tasks:
${plan.tasks.map(t => `${t.id}: ${t.title}\n  ${t.description}\n  Files: ${t.files.join(', ')}`).join('\n')}

Test approach: ${plan.test_approach}
--- END ---${errorsSection}${filesSection}`
}
