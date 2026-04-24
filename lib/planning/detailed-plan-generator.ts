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

function stripCodeFence(s: string): string {
  const trimmed = s.trim()
  const m = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/)
  return m ? m[1] : trimmed
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
Project layout (Next.js App Router — use these paths EXACTLY):
  app/                  → pages and API routes (e.g. app/projects/[id]/page.tsx, app/api/foo/route.ts)
  components/           → shared React components
  lib/                  → business logic, utilities, Supabase clients
  tests/                → Vitest tests (mirror lib/ structure, e.g. tests/lib/foo.test.ts)
  styles/               → CSS / Tailwind
  supabase/migrations/  → numbered SQL migrations (append-only)

CRITICAL path rules for files[]:
- Every path in files[] MUST start with one of: app/, components/, lib/, tests/, styles/, supabase/migrations/
- NEVER use src/, pages/, router/, or any other prefix — this project has NO src/ directory
- Use Next.js App Router conventions: app/path/to/page.tsx (NOT pages/path/to/page.tsx)
- Test files go in tests/, not alongside source files

Rules — every task MUST have:
1. At least one substep
2. At least one file in files[] — files[] must be non-empty with real paths following the rules above
3. At least one validation check
4. A non-empty expected_result
5. depends_on references that exist within this plan
6. A playbook object with commit, implementation_notes, commands, expected_outputs, code_snippets, temporary_failures_allowed, and rollback
7. database/backend/refactor tasks MUST include at least one code_snippet with real content

Task types: backend, frontend, database, testing, infra, api, refactor
Substep actions: write_file, modify_file, run_command, verify_schema, run_test, insert_row
Validation types:
  { "type": "command", "command": "npm test", "success_contains": "passed" }
  { "type": "file_exists", "target": "lib/foo.ts" }
  { "type": "schema", "table": "foo", "expected_columns": ["id", "name"] }
  { "type": "test_pass", "pattern": "foo.test" }

Respond with JSON:
{
  "schema_version": 2,
  "planner_version": ${plannerVersion},
  "goal": "...",
  "branch_name": "sf/<8-char-id-prefix>-<short-slug>",
  "summary": {
    "architecture": "2-3 sentence description of the implementation approach",
    "tech_stack": ["Next.js", "Supabase", "TypeScript"],
    "spec_ref": ""
  },
  "file_map": {
    "create": ["list of new files"],
    "rewrite": ["list of files being substantially changed"],
    "delete": ["list of files being removed"]
  },
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
          "type": "frontend",
          "files": ["app/projects/[id]/docs/page.tsx", "components/docs/EmptyState.tsx"],
          "depends_on": [],
          "substeps": [
            { "id": "step_1", "action": "write_file", "target": "app/projects/[id]/docs/page.tsx" },
            { "id": "step_2", "action": "write_file", "target": "components/docs/EmptyState.tsx" }
          ],
          "validation": [{ "type": "file_exists", "target": "app/projects/[id]/docs/page.tsx" }],
          "expected_result": "DocsPage renders with empty state",
          "playbook": {
            "implementation_notes": ["Use Next.js App Router page.tsx convention", "Import from @/components/ using the @ alias"],
            "commands": ["npm run build"],
            "expected_outputs": ["Compiled successfully"],
            "code_snippets": [
              {
                "file": "app/projects/[id]/docs/page.tsx",
                "language": "tsx",
                "purpose": "Docs page",
                "content": "export default function DocsPage() { return <div>Docs</div> }"
              }
            ],
            "temporary_failures_allowed": [],
            "commit": "feat: add docs page",
            "rollback": []
          }
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
  ai: AIProvider,
  onSubstep?: (status: string) => Promise<void>
): Promise<DetailedPlan> {
  // First attempt
  await onSubstep?.('plan_creating_phases')
  const prompt = buildDetailedPlanPrompt(change, spec, plannerVersion)
  const result = await ai.complete(prompt, { maxTokens: 16000 })

  let plan: DetailedPlan
  try {
    plan = JSON.parse(stripCodeFence(result.content))
  } catch {
    const truncated = result.outputTokens >= 15900
    throw new Error(`Plan generation produced non-JSON response${truncated ? ' (response truncated — plan too large)' : ''}: ${result.content.slice(0, 200)}`)
  }

  await onSubstep?.('plan_validating')
  const validation = validatePlanOutput(plan)
  if (validation.passed) {
    await onSubstep?.('plan_finalizing')
    return plan
  }

  // One retry with gate failures included
  await onSubstep?.('plan_creating_phases')
  const retryPrompt = buildDetailedPlanPrompt(change, spec, plannerVersion, validation.diagnostics.issues)
  const retryResult = await ai.complete(retryPrompt, { maxTokens: 16000 })

  let retryPlan: DetailedPlan
  try {
    retryPlan = JSON.parse(stripCodeFence(retryResult.content))
  } catch {
    const truncated = retryResult.outputTokens >= 15900
    throw new Error(`Plan generation retry produced non-JSON response${truncated ? ' (response truncated — plan too large)' : ''}: ${retryResult.content.slice(0, 200)}`)
  }

  await onSubstep?.('plan_validating')
  const retryValidation = validatePlanOutput(retryPlan)
  if (!retryValidation.passed) {
    throw new PlanQualityGateError(retryValidation.diagnostics)
  }

  await onSubstep?.('plan_finalizing')
  return retryPlan
}
