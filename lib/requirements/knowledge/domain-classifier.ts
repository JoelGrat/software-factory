import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import { buildClassifyDomainPrompt, CLASSIFY_DOMAIN_SCHEMA } from '@/lib/ai/prompts/classify-domain'

export async function classifyAndSeedDomain(
  projectId: string,
  rawInput: string,
  db: SupabaseClient,
  ai: AIProvider
): Promise<void> {
  try {
    const prompt = buildClassifyDomainPrompt(rawInput)
    const result = await ai.complete(prompt, { responseSchema: CLASSIFY_DOMAIN_SCHEMA })
    const { domain, confidence } = JSON.parse(result.content) as { domain: string; confidence: number }

    if (confidence < 50) return // not confident enough to seed a template

    // Check if a template already exists for this project+domain
    const { data: existing } = await db
      .from('domain_templates')
      .select('id')
      .eq('project_id', projectId)
      .eq('domain', domain)
      .limit(1)

    if (!existing || existing.length === 0) {
      await db.from('domain_templates').insert({
        project_id: projectId,
        domain,
        name: `${domain} baseline`,
        requirement_areas: { functional: [], nfr: ['security', 'performance', 'auditability'] },
      })
    }
  } catch {
    // Async enrichment — never throw, never block the pipeline
  }
}
