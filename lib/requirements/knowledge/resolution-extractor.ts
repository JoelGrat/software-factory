import type { SupabaseClient } from '@supabase/supabase-js'
import type { Gap, DecisionLog } from '@/lib/supabase/types'

/**
 * When a decision is recorded, distil it into a resolution_pattern linked to the gap_pattern.
 * Fire-and-forget — never throws.
 */
export async function extractResolutionPattern(
  gap: Gap,
  decision: DecisionLog,
  projectId: string | null,
  db: SupabaseClient
): Promise<void> {
  try {
    // Find the matching gap_pattern
    const { data: patterns } = await db
      .from('gap_patterns')
      .select('id')
      .eq('category', gap.category)
      .eq('severity', gap.severity)
      .eq('description_template', gap.description)
      .or(projectId ? `project_id.eq.${projectId},project_id.is.null` : 'project_id.is.null')
      .limit(1)

    if (!patterns || patterns.length === 0) return

    await db.from('resolution_patterns').insert({
      gap_pattern_id: patterns[0].id,
      project_id: projectId,
      resolution_summary: decision.rationale,
      source_decision_id: decision.id,
      use_count: 0,
    })
  } catch {
    // async enrichment — never throw
  }
}
