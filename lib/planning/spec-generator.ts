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
  const { data: components, error } = await db
    .from('system_components')
    .select('name')
    .eq('project_id', projectId)
    .is('deleted_at', null)
  if (error) console.warn(`inferCandidateComponents: failed to load components for project ${projectId}:`, error.message)
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
  const { data: project, error } = await db
    .from('projects')
    .select('name')
    .eq('id', projectId)
    .single()
  if (error) console.warn(`loadProjectContext: failed to load project ${projectId}:`, error.message)
  return project ? `Project: ${project.name}` : ''
}

function stripCodeFence(s: string): string {
  const trimmed = s.trim()
  const m = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/)
  return m ? m[1] : trimmed
}

async function generateCanonicalSpec(
  change: { title: string; intent: string; type: string },
  context: {
    candidateComponents: string[]
    likelyFilePaths: string[]
    assumptions: string[]
    projectContext: string
  },
  ai: AIProvider
): Promise<{ spec: ChangeSpec; markdown: string }> {
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

  const prompt = lines.join('\n')
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any
  try {
    parsed = JSON.parse(stripCodeFence(result.content))
  } catch {
    throw new Error(`Spec generation produced non-JSON response: ${result.content.slice(0, 200)}`)
  }
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

export async function generateSpec(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider,
  onSubstep?: (status: string) => Promise<void>
): Promise<{ spec: ChangeSpec; markdown: string }> {
  const { data: change } = await db
    .from('change_requests')
    .select('id, project_id, title, intent, type')
    .eq('id', changeId)
    .single()
  if (!change) throw new Error(`Change not found: ${changeId}`)

  await onSubstep?.('spec_loading_context')
  const projectContext = await loadProjectContext(db, change.project_id)

  await onSubstep?.('spec_inferring_components')
  const candidateComponents = await inferCandidateComponents(change, db, change.project_id)

  await onSubstep?.('spec_inferring_files')
  const likelyFilePaths = inferLikelyFilePaths(change)
  const assumptions = deriveAssumptions(change)

  await onSubstep?.('spec_generating_canonical')
  return generateCanonicalSpec(change, { candidateComponents, likelyFilePaths, assumptions, projectContext }, ai)
}
