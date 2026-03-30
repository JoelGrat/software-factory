import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
// TODO: replaced in Plan 2/3/4 — old types removed in migration 006
/* eslint-disable @typescript-eslint/no-explicit-any */
// import type { RequirementSummary } from '@/lib/supabase/types' // removed in migration 006

interface GapRow { severity: string; resolved_at: string | null; merged_into: string | null; validated: boolean | null }

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [{ data: req }, { data: latestScore }, { data: gaps }] = await Promise.all([
    db.from('requirements').select('status, blocked_reason').eq('id', id).single(),
    db.from('completeness_scores')
      .select('blocking_count, high_risk_count, coverage_pct, internal_score, complexity_score, risk_flags')
      .eq('requirement_id', id)
      .order('scored_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from('gaps').select('severity, resolved_at, merged_into, validated').eq('requirement_id', id),
  ])

  if (!req) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const activeGaps = ((gaps ?? []) as GapRow[]).filter(g => !g.resolved_at && !g.merged_into)
  const summary: any = {
    blocking_count: latestScore?.blocking_count ?? activeGaps.filter(g => g.severity === 'critical').length,
    high_risk_count: latestScore?.high_risk_count ?? activeGaps.filter(g => g.severity === 'major').length,
    coverage_pct: latestScore?.coverage_pct ?? 0,
    unvalidated_count: activeGaps.filter(g => g.validated === false).length,
    internal_score: latestScore?.internal_score ?? 0,
    complexity_score: latestScore?.complexity_score ?? 0,
    risk_flags: (latestScore?.risk_flags as string[]) ?? [],
    status: req.status,
    blocked_reason: req.blocked_reason,
  }

  return NextResponse.json(summary)
}
