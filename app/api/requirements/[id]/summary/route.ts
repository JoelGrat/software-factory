import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import type { RequirementSummary } from '@/lib/supabase/types'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createServerSupabaseClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [{ data: req }, { data: latestScore }, { data: gaps }] = await Promise.all([
    db.from('requirements').select('status, blocked_reason').eq('id', id).single(),
    db.from('completeness_scores')
      .select('overall_score, completeness, nfr_score, confidence')
      .eq('requirement_id', id)
      .order('scored_at', { ascending: false })
      .limit(1)
      .single(),
    db.from('gaps').select('severity, resolved_at, merged_into').eq('requirement_id', id),
  ])

  if (!req) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const activeGaps = (gaps ?? []).filter(g => !g.resolved_at && !g.merged_into)
  const summary: RequirementSummary = {
    critical_count: activeGaps.filter(g => g.severity === 'critical').length,
    major_count: activeGaps.filter(g => g.severity === 'major').length,
    minor_count: activeGaps.filter(g => g.severity === 'minor').length,
    completeness: latestScore?.completeness ?? 0,
    confidence: latestScore?.confidence ?? 0,
    overall_score: latestScore?.overall_score ?? 0,
    status: req.status,
    blocked_reason: req.blocked_reason,
  }

  return NextResponse.json(summary)
}
