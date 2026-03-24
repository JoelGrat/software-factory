import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/ai/registry'
import { parseStructuredResponse } from '@/lib/ai/provider'
import { buildEvaluateAnswerPrompt, EVALUATE_ANSWER_SCHEMA } from '@/lib/ai/prompts/evaluate-answer'
import { computeScore } from '@/lib/requirements/scorer'
import { computeStatusFromScore } from '@/lib/requirements/re-evaluator'
import type { Gap } from '@/lib/supabase/types'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  if (!body.answer || typeof body.answer !== 'string') {
    return NextResponse.json({ error: 'answer is required' }, { status: 400 })
  }
  const answer: string = body.answer

  const { data: question } = await db
    .from('questions')
    .select('*, gaps(description)')
    .eq('id', id)
    .single()
  if (!question) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const ai = getProvider()
  const gapDescription = (question.gaps as { description: string } | null)?.description ?? ''
  const prompt = buildEvaluateAnswerPrompt(gapDescription, question.question_text, answer)
  const raw = await ai.complete(prompt, { responseSchema: EVALUATE_ANSWER_SCHEMA })
  const evaluation = parseStructuredResponse<{ resolved: boolean; rationale: string }>(raw, EVALUATE_ANSWER_SCHEMA)

  const { error: questionUpdateError } = await db.from('questions').update({ answer, status: 'answered', answered_at: new Date().toISOString() }).eq('id', id)
  if (questionUpdateError) return NextResponse.json({ error: 'Failed to update question' }, { status: 500 })

  if (evaluation.resolved) {
    await db.from('gaps').update({ resolved_at: new Date().toISOString(), resolution_source: 'question_answered' }).eq('id', question.gap_id)
  }

  const [{ data: allGaps }, { data: allItems }, { data: currentReq }] = await Promise.all([
    db.from('gaps').select('*').eq('requirement_id', question.requirement_id),
    db.from('requirement_items').select('*').eq('requirement_id', question.requirement_id),
    db.from('requirements').select('status').eq('id', question.requirement_id).single(),
  ])

  const gapsForScoring = ((allGaps ?? []) as Gap[]).map(g => ({
    item_id: g.item_id, severity: g.severity, category: g.category,
    description: g.description, source: g.source, rule_id: g.rule_id,
    priority_score: g.priority_score, confidence: g.confidence, question_generated: g.question_generated,
  }))

  const score = computeScore(gapsForScoring, new Set(), allItems ?? [])
  await db.from('completeness_scores').insert({
    requirement_id: question.requirement_id,
    overall_score: score.overall_score, completeness: score.completeness,
    nfr_score: score.nfr_score, confidence: score.confidence,
    breakdown: score.breakdown, scored_at: new Date().toISOString(),
  })

  const newStatus = computeStatusFromScore(allGaps ?? [])
  if (currentReq?.status !== 'blocked') {
    await db.from('requirements').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', question.requirement_id)
  }
  await db.from('audit_log').insert({
    entity_type: 'questions', entity_id: id, action: 'updated',
    actor_id: user.id, diff: { answered: true, gap_resolved: evaluation.resolved },
  })

  return NextResponse.json({ resolved: evaluation.resolved, rationale: evaluation.rationale, new_status: newStatus })
}
