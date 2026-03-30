import type { SupabaseClient } from '@supabase/supabase-js'
// TODO: replaced in Plan 2/3/4 — old types removed in migration 006
/* eslint-disable @typescript-eslint/no-explicit-any */
// import type { Gap } from '@/lib/supabase/types' // removed in migration 006

/**
 * When a gap is resolved, record its category/severity as a gap_pattern.
 * Increments occurrence_count if an identical pattern exists; creates one otherwise.
 * Fire-and-forget — never throws.
 */
export async function extractGapPattern(
  gap: any,
  projectId: string | null,
  db: SupabaseClient
): Promise<void> {
  try {
    const { data: existing } = await db
      .from('gap_patterns')
      .select('id, occurrence_count')
      .eq('category', gap.category)
      .eq('severity', gap.severity)
      .eq('description_template', gap.description)
      .or(projectId ? `project_id.eq.${projectId},project_id.is.null` : 'project_id.is.null')
      .limit(1)

    if (existing && existing.length > 0) {
      await db.from('gap_patterns').update({
        occurrence_count: existing[0].occurrence_count + 1,
        last_seen_at: new Date().toISOString(),
      }).eq('id', existing[0].id)
    } else {
      await db.from('gap_patterns').insert({
        project_id: projectId,
        category: gap.category,
        severity: gap.severity,
        description_template: gap.description,
        occurrence_count: 1,
        last_seen_at: new Date().toISOString(),
      })
    }
  } catch {
    // async enrichment — never throw
  }
}
