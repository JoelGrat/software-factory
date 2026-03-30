import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { computeScore } from '@/lib/requirements/scorer'
import { computeStatusFromScore } from '@/lib/requirements/re-evaluator'
import { validateDecision } from '@/lib/requirements/validate-decision'
import { extractGapPattern } from '@/lib/requirements/knowledge/pattern-extractor'
import { extractResolutionPattern } from '@/lib/requirements/knowledge/resolution-extractor'
// TODO: replaced in Plan 2/3/4 — old types removed in migration 006
/* eslint-disable @typescript-eslint/no-explicit-any */
// import type { Gap, DecisionLog } from '@/lib/supabase/types' // removed in migration 006

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const validationError = validateDecision(body)
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })

  const { data: gap } = await db.from('gaps').select('*').eq('id', body.gap_id).single()
  if (!gap) return NextResponse.json({ error: 'Gap not found' }, { status: 404 })

  // Insert decision log entry
  const { data: decision, error: decisionError } = await db
    .from('decision_log')
    .insert({
      requirement_id: id,
      related_gap_id: body.gap_id,
      related_question_id: body.question_id ?? null,
      decision: body.decision.trim(),
      rationale: body.rationale.trim(),
      decided_by: user.id,
    })
    .select('id, requirement_id, related_gap_id, related_question_id, decision, rationale, decided_by, created_at')
    .single()

  if (decisionError || !decision) return NextResponse.json({ error: 'Failed to record decision' }, { status: 500 })

  // Resolve the gap
  await db.from('gaps').update({
    resolved_at: new Date().toISOString(),
    resolution_source: 'decision_recorded',
  }).eq('id', body.gap_id)

  // Recalculate score and status
  const [{ data: allGaps }, { data: allItems }, { data: currentReq }] = await Promise.all([
    db.from('gaps').select('*').eq('requirement_id', id),
    db.from('requirement_items').select('*').eq('requirement_id', id),
    db.from('requirements').select('status, project_id').eq('id', id).single(),
  ])

  const gapsForScoring = ((allGaps ?? []) as any[]).map((g: any) => ({
    item_id: g.item_id, severity: g.severity, category: g.category,
    description: g.description, source: g.source, rule_id: g.rule_id,
    priority_score: g.priority_score, confidence: g.confidence,
    validated: g.validated, question_generated: g.question_generated,
  }))

  const score = computeScore(gapsForScoring, new Set(), allItems ?? [])
  await db.from('completeness_scores').insert({
    requirement_id: id,
    blocking_count: score.blocking_count, high_risk_count: score.high_risk_count,
    coverage_pct: score.coverage_pct, internal_score: score.internal_score,
    nfr_score: score.nfr_score, breakdown: score.breakdown, scored_at: new Date().toISOString(),
  })

  const newStatus = computeStatusFromScore(allGaps ?? [])
  if (currentReq?.status !== 'blocked') {
    await db.from('requirements').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', id)
  }

  await db.from('audit_log').insert({
    entity_type: 'decision_log', entity_id: decision.id,
    action: 'created', actor_id: user.id,
    diff: { gap_id: body.gap_id, decision_id: decision.id },
  })

  // Async knowledge extraction — fire-and-forget, correct signatures
  const projectId = currentReq?.project_id ?? null
  void extractGapPattern(gap as any, projectId, db)
  void extractResolutionPattern(gap as any, decision as any, projectId, db)

  return NextResponse.json({ decision_id: decision.id, new_status: newStatus }, { status: 201 })
}
