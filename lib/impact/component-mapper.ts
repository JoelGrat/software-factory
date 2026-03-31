import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { MappedComponent, ComponentMapResult } from './types'

function splitCamelCase(str: string): string[] {
  return str
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

export async function mapComponents(
  changeId: string,
  change: { title: string; intent: string; tags: string[] },
  db: SupabaseClient,
  ai: AIProvider
): Promise<ComponentMapResult> {
  // 1. Get project_id for this change
  const { data: changeRow } = await db
    .from('change_requests')
    .select('project_id')
    .eq('id', changeId)
    .single()

  const projectId = changeRow?.project_id
  if (!projectId) return { seedFileIds: [], components: [], aiUsed: false }

  // 2. Fetch all components for project
  const { data: components } = await db
    .from('system_components')
    .select('id, name, type')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('name' as any)

  if (!components?.length) return { seedFileIds: [], components: [], aiUsed: false }

  // 3. Keyword match: title words + tags → component names
  const searchTerms = [
    ...change.title.toLowerCase().split(/\s+/),
    ...change.intent.toLowerCase().split(/\s+/),
    ...change.tags.map(t => t.toLowerCase()),
  ].filter(t => t.length > 2)

  const mappedComponents: MappedComponent[] = []
  const matchedIds = new Set<string>()

  for (const comp of components) {
    const componentWords = splitCamelCase(comp.name)
    const hits = searchTerms.filter(term => componentWords.includes(term))
    if (hits.length > 0) {
      matchedIds.add(comp.id)
      mappedComponents.push({
        componentId: comp.id,
        name: comp.name,
        type: comp.type,
        confidence: Math.min(50 + hits.length * 15, 90),
        matchReason: `keyword: ${hits.join(', ')}`,
      })
    }
  }

  // 4. AI mapping for components not caught by keyword match
  let aiUsed = false
  try {
    const componentList = components.map(c => c.name).join('\n')
    const result = await ai.complete(
      `Given this software change, identify which system components are likely affected.\n\nChange title: ${change.title}\nIntent: ${change.intent}\n\nAvailable components:\n${componentList}\n\nRespond with JSON: {"affected": ["ComponentName1"]}`,
      {
        responseSchema: {
          type: 'object',
          properties: { affected: { type: 'array', items: { type: 'string' } } },
          required: ['affected'],
        },
        maxTokens: 500,
      }
    )
    const parsed = JSON.parse(result.content)
    for (const name of parsed.affected ?? []) {
      const comp = components.find(c => c.name === name)
      if (comp && !matchedIds.has(comp.id)) {
        matchedIds.add(comp.id)
        mappedComponents.push({
          componentId: comp.id,
          name: comp.name,
          type: comp.type,
          confidence: 70,
          matchReason: 'ai_mapping',
        })
        aiUsed = true
      }
    }
  } catch {
    // AI errors are non-fatal
  }

  // 5. Fetch file IDs for all matched components to use as seeds
  if (matchedIds.size === 0) return { seedFileIds: [], components: mappedComponents, aiUsed }
  const { data: assignments } = await db
    .from('component_assignment')
    .select('file_id, component_id')
    .in('component_id', Array.from(matchedIds))

  const seedFileIds = [...new Set(
    (assignments ?? []).map(a => a.file_id).filter(Boolean)
  )].slice(0, 30)

  return { seedFileIds, components: mappedComponents, aiUsed }
}
