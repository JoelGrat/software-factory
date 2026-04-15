// lib/planning/spec-generator.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { ChangeSpec } from './types'

// Exported for testing
export function inferLikelyFilePaths(change: { title: string; intent: string }): string[] {
  const pathPattern = /[\w-]+\/[\w./-]+\.(?:tsx|ts|jsx|js|sql|md)/g
  const hits = change.intent.match(pathPattern) ?? []
  return [...new Set(hits)].slice(0, 10)
}

// Exported for testing
export function deriveAssumptions(change: { title: string; intent: string; type: string }): string[] {
  const assumptions: string[] = []
  const intentLower = change.intent.toLowerCase()
  if (change.type === 'feature') assumptions.push('New functionality will be additive, not breaking')
  if (intentLower.includes('migrat')) assumptions.push('Database migration required')
  if (intentLower.includes('test')) assumptions.push('Test coverage is expected')
  return assumptions
}

async function inferCandidateComponents(
  change: { title: string; intent: string },
  db: SupabaseClient,
  projectId: string
): Promise<string[]> {
  const { data: components } = await db
    .from('system_components')
    .select('name')
    .eq('project_id', projectId)
    .is('deleted_at', null)
  if (!components?.length) return []

  const searchTerms = [
    ...change.title.toLowerCase().split(/\s+/),
    ...change.intent.toLowerCase().split(/\s+/),
  ].filter(t => t.length > 2)

  return components
    .filter(c => {
      const words = c.name.replace(/([A-Z])/g, ' $1').toLowerCase().split(/\s+/)
      return searchTerms.some(term => words.includes(term))
    })
    .map(c => c.name)
    .slice(0, 10)
}

async function loadProjectContext(db: SupabaseClient, projectId: string): Promise<string> {
  const { data: project } = await db
    .from('projects')
    .select('name, description')
    .eq('id', projectId)
    .single()
  return project ? `Project: ${project.name}. ${project.description ?? ''}`.trim() : ''
}

function buildSpecPrompt(
  change: { title: string; intent: string; type: string },
  context: {
    candidateComponents: string[]
    likelyFilePaths: string[]
    assumptions: string[]
    projectContext: string
  }
): string {
  const lines = [
    'You are generating a software specification for a change request.',
    '',
    `Change: ${change.title}`,
    `Type: ${change.type}`,
    `Intent: ${change.intent}`,
  ]

  if (context.projectContext) lines.push(`\nProject context: ${context.projectContext}`)
  if (context.candidateComponents.length > 0) {
    lines.push(`\nLikely affected components:\n${context.candidateComponents.map(c => `- ${c}`).join('\n')}`)
  }
  if (context.likelyFilePaths.length > 0) {
    lines.push(`\nLikely file paths:\n${context.likelyFilePaths.map(f => `- ${f}`).join('\n')}`)
  }
  if (context.assumptions.length > 0) {
    lines.push(`\nInferred assumptions:\n${context.assumptions.map(a => `- ${a}`).join('\n')}`)
  }

  lines.push(`
Produce a specification with these fields:
- problem: what problem this change solves (1-2 sentences)
- goals: 2-5 specific, measurable goals
- architecture: how this will be implemented (2-3 sentences)
- constraints: technical or business constraints (array)
- data_model: (optional) DB schema or data structure changes
- ui_behavior: (optional) UI/UX behavior changes
- policies: (optional) business or technical rules
- out_of_scope: what is explicitly NOT included (array)
- markdown: a human-readable version as a markdown document

Be specific and concrete. Avoid vague language.

Respond with JSON.`)

  return lines.join('\n')
}

export async function generateSpec(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider
): Promise<{ spec: ChangeSpec; markdown: string }> {
  const { data: change } = await db
    .from('change_requests')
    .select('id, project_id, title, intent, type')
    .eq('id', changeId)
    .single()
  if (!change) throw new Error(`Change not found: ${changeId}`)

  const [candidateComponents, projectContext] = await Promise.all([
    inferCandidateComponents(change, db, change.project_id),
    loadProjectContext(db, change.project_id),
  ])
  const likelyFilePaths = inferLikelyFilePaths(change)
  const assumptions = deriveAssumptions(change)

  const prompt = buildSpecPrompt(change, { candidateComponents, likelyFilePaths, assumptions, projectContext })

  const result = await ai.complete(prompt, {
    responseSchema: {
      type: 'object',
      properties: {
        problem:      { type: 'string' },
        goals:        { type: 'array', items: { type: 'string' } },
        architecture: { type: 'string' },
        constraints:  { type: 'array', items: { type: 'string' } },
        data_model:   { type: 'string' },
        ui_behavior:  { type: 'string' },
        policies:     { type: 'array', items: { type: 'string' } },
        out_of_scope: { type: 'array', items: { type: 'string' } },
        markdown:     { type: 'string' },
      },
      required: ['problem', 'goals', 'architecture', 'constraints', 'out_of_scope', 'markdown'],
    },
    maxTokens: 4096,
  })

  const parsed = JSON.parse(result.content)
  const spec: ChangeSpec = {
    problem:      parsed.problem,
    goals:        parsed.goals,
    architecture: parsed.architecture,
    constraints:  parsed.constraints,
    data_model:   parsed.data_model,
    ui_behavior:  parsed.ui_behavior,
    policies:     parsed.policies,
    out_of_scope: parsed.out_of_scope,
  }
  return { spec, markdown: parsed.markdown }
}
