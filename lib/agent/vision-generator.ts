// lib/agent/vision-generator.ts
import { createClient } from '@supabase/supabase-js'
import { getProvider } from '@/lib/ai/registry'
import { buildVisionPrompt } from '@/lib/agent/prompts/vision'
import type { ProjectVision, RequirementItem } from '@/lib/supabase/types'
import { repairAndParse } from '@/lib/ai/repair'

// Uses service-role client (server-side only, never sent to browser)
function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

async function log(
  db: ReturnType<typeof getServiceClient>,
  projectId: string,
  phase: 'parsing' | 'generating' | 'system',
  message: string,
  level: 'info' | 'warn' | 'error' | 'success' = 'info'
) {
  try {
    await db.from('vision_logs').insert({ project_id: projectId, phase, level, message })
  } catch { /* logging must never abort generation */ }
}

export async function generateVisionRequirements(
  projectId: string,
  vision: ProjectVision,
  requirementId: string
): Promise<void> {
  const db = getServiceClient()

  try {
    await log(db, projectId, 'system', 'Starting requirement generation...')
    await log(db, projectId, 'parsing', 'Parsing your vision...')

    const prompt = buildVisionPrompt(vision)
    const provider = getProvider()

    await log(db, projectId, 'generating', 'Generating requirements with AI...')

    const result = await provider.complete(prompt, {
      temperature: 0,
      maxTokens: 4096,
    })

    // Attempt JSON repair+parse for robustness
    const parsed = repairAndParse(result.content)
    if (!parsed) {
      throw new Error('AI returned invalid JSON that could not be repaired')
    }

    const items = parsed as Array<Pick<RequirementItem, 'type' | 'title' | 'description' | 'priority'>>

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('AI returned no requirement items')
    }

    await log(db, projectId, 'generating', `Inserting ${items.length} requirements...`)

    // Insert one by one so Realtime fires per item
    for (const item of items) {
      await db.from('requirement_items').insert({
        requirement_id: requirementId,
        type:           item.type,
        title:          item.title,
        description:    item.description,
        priority:       item.priority,
        source_text:    null,
        nfr_category:   null,
      })
    }

    // Update raw_input with a formatted summary
    const summary = items
      .map(i => `[${i.type.toUpperCase()}] ${i.title}: ${i.description}`)
      .join('\n')
    await db.from('requirements')
      .update({ raw_input: summary, status: 'draft' })
      .eq('id', requirementId)

    await log(db, projectId, 'system', `Done — ${items.length} requirements generated.`, 'success')

    await db.from('project_visions')
      .update({ status: 'done', error: null, updated_at: new Date().toISOString() })
      .eq('project_id', projectId)

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    await log(db, projectId, 'system', `Generation failed: ${message}`, 'error')
    await db.from('project_visions')
      .update({ status: 'failed', error: message, updated_at: new Date().toISOString() })
      .eq('project_id', projectId)
  }
}
