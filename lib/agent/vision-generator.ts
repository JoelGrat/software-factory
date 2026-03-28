// lib/agent/vision-generator.ts
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { buildVisionPrompt, VISION_SYSTEM_PROMPT } from '@/lib/agent/prompts/vision'
import type { ProjectVision, RequirementItem } from '@/lib/supabase/types'

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

type ItemRow = Pick<RequirementItem, 'type' | 'title' | 'description' | 'priority'>

function parseItem(line: string): ItemRow | null {
  try {
    const obj = JSON.parse(line.trim())
    if (
      typeof obj.type === 'string' &&
      typeof obj.title === 'string' &&
      typeof obj.description === 'string' &&
      typeof obj.priority === 'string'
    ) {
      return obj as ItemRow
    }
  } catch { /* incomplete or invalid line */ }
  return null
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
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    await log(db, projectId, 'generating', 'Generating requirements...')

    // Stream the response — insert each item the moment its line is complete
    const stream = anthropic.messages.stream({
      model: process.env.CLAUDE_MODEL ?? 'claude-opus-4-6',
      max_tokens: 4096,
      temperature: 0,
      system: VISION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    })

    let buffer = ''
    let insertedCount = 0

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        buffer += event.delta.text

        // Each complete line may be a full JSON item
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? '' // last element is the incomplete current line

        for (const line of lines) {
          if (!line.trim()) continue
          const item = parseItem(line)
          if (!item) continue

          await db.from('requirement_items').insert({
            requirement_id: requirementId,
            type:           item.type,
            title:          item.title,
            description:    item.description,
            priority:       item.priority,
            source_text:    null,
            nfr_category:   null,
          })
          insertedCount++
          await log(db, projectId, 'generating', `[${insertedCount}] ${item.title}`)
        }
      }
    }

    // Flush any remaining buffer (last line with no trailing newline)
    if (buffer.trim()) {
      const item = parseItem(buffer)
      if (item) {
        await db.from('requirement_items').insert({
          requirement_id: requirementId,
          type:           item.type,
          title:          item.title,
          description:    item.description,
          priority:       item.priority,
          source_text:    null,
          nfr_category:   null,
        })
        insertedCount++
      }
    }

    if (insertedCount === 0) throw new Error('AI returned no requirement items')

    // Update raw_input summary
    const { data: allItems } = await db
      .from('requirement_items')
      .select('type, title, description')
      .eq('requirement_id', requirementId)

    if (allItems) {
      const summary = allItems
        .map(i => `[${i.type.toUpperCase()}] ${i.title}: ${i.description}`)
        .join('\n')
      await db.from('requirements')
        .update({ raw_input: summary, status: 'draft' })
        .eq('id', requirementId)
    }

    await log(db, projectId, 'system', `Done — ${insertedCount} requirements generated.`, 'success')

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
