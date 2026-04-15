// lib/planning/detailed-plan-generator.ts
import type { AIProvider } from '@/lib/ai/provider'
import type { ChangeSpec, DetailedPlan } from './types'
import { validatePlanOutput } from './plan-validator'

export class PlanQualityGateError extends Error {
  constructor(public readonly diagnostics: { summary: string; issues: string[]; truncated: boolean }) {
    super(`Plan quality gate failed after retry: ${diagnostics.summary}`)
    this.name = 'PlanQualityGateError'
  }
}

function buildDetailedPlanPrompt(
  change: { title: string; intent: string },
  spec: ChangeSpec,
  plannerVersion: number,
  gateFailures?: string[]
): string {
  const lines = [
    'You are generating a machine-executable implementation plan for a software change.',
    '',
    `Change: ${change.title}`,
    `Intent: ${change.intent}`,
    '',
    'Specification:',
    `Problem: ${spec.problem}`,
    `Goals:\n${spec.goals.map(g => `- ${g}`).join('\n')}`,
    `Architecture: ${spec.architecture}`,
    `Constraints:\n${spec.constraints.map(c => `- ${c}`).join('\n')}`,
  ]

  if (spec.out_of_scope.length > 0) {
    lines.push(`Out of scope:\n${spec.out_of_scope.map(s => `- ${s}`).join('\n')}`)
  }

  if (gateFailures?.length) {
    lines.push('', 'The previous attempt failed these quality gates — fix ALL of them:')
    lines.push(...gateFailures.map(f => `- ${f}`))
  }

  lines.push(`
Rules — every task MUST have:
1. At least one substep
2. At least one file in files[] OR a substep with command or target
3. At least one validation check
4. A non-empty expected_result
5. depends_on references that exist within this plan

Task types: backend, frontend, database, testing, infra, api, refactor
Substep actions: write_file, modify_file, run_command, verify_schema, run_test, insert_row
Validation types:
  { "type": "command", "command": "npm test", "success_contains": "passed" }
  { "type": "file_exists", "target": "lib/foo.ts" }
  { "type": "schema", "table": "foo", "expected_columns": ["id", "name"] }
  { "type": "test_pass", "pattern": "foo.test" }

Respond with JSON:
{
  "schema_version": 1,
  "planner_version": ${plannerVersion},
  "goal": "...",
  "phases": [
    {
      "id": "phase_1",
      "title": "...",
      "depends_on": [],
      "tasks": [
        {
          "id": "task_1",
          "title": "...",
          "description": "...",
          "type": "database",
          "files": ["supabase/migrations/025_foo.sql"],
          "depends_on": [],
          "substeps": [
            { "id": "step_1", "action": "write_file", "target": "supabase/migrations/025_foo.sql" },
            { "id": "step_2", "action": "run_command", "command": "supabase db push", "expected": ["Done"] }
          ],
          "validation": [{ "type": "command", "command": "supabase db push", "success_contains": "Done" }],
          "expected_result": "Migration applied successfully"
        }
      ]
    }
  ]
}`)

  return lines.join('\n')
}

export async function generateDetailedPlan(
  change: { title: string; intent: string },
  spec: ChangeSpec,
  plannerVersion: number,
  ai: AIProvider
): Promise<DetailedPlan> {
  // First attempt
  const prompt = buildDetailedPlanPrompt(change, spec, plannerVersion)
  const result = await ai.complete(prompt, { maxTokens: 8192 })

  let plan: DetailedPlan
  try {
    plan = JSON.parse(result.content)
  } catch {
    throw new Error(`Plan generation produced non-JSON response: ${result.content.slice(0, 200)}`)
  }

  const validation = validatePlanOutput(plan)
  if (validation.passed) return plan

  // One retry with gate failures included
  const retryPrompt = buildDetailedPlanPrompt(change, spec, plannerVersion, validation.diagnostics.issues)
  const retryResult = await ai.complete(retryPrompt, { maxTokens: 8192 })

  let retryPlan: DetailedPlan
  try {
    retryPlan = JSON.parse(retryResult.content)
  } catch {
    throw new Error(`Plan generation retry produced non-JSON response: ${retryResult.content.slice(0, 200)}`)
  }

  const retryValidation = validatePlanOutput(retryPlan)
  if (!retryValidation.passed) {
    throw new PlanQualityGateError(retryValidation.diagnostics)
  }

  return retryPlan
}
