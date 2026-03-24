import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { computeScore } from '@/lib/requirements/scorer'
import { computeStatusFromScore } from '@/lib/requirements/re-evaluator'
import type { TaskStatus } from '@/lib/supabase/types'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createServerSupabaseClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  if (!body.status || typeof body.status !== 'string') {
    return NextResponse.json({ error: 'status is required' }, { status: 400 })
  }
  const newStatus: TaskStatus = body.status

  const { data: task } = await db.from('investigation_tasks').select('*').eq('id', id).single()
  if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { error: taskUpdateError } = await db.from('investigation_tasks').update({ status: newStatus }).eq('id', id)
  if (taskUpdateError) return NextResponse.json({ error: 'Failed to update task' }, { status: 500 })

  if (newStatus === 'resolved' && task.linked_gap_id) {
    await db.from('gaps').update({ resolved_at: new Date().toISOString(), resolution_source: 'task_resolved' }).eq('id', task.linked_gap_id)
  }

  const [{ data: allGaps }, { data: allItems }, { data: currentReq }] = await Promise.all([
    db.from('gaps').select('*').eq('requirement_id', task.requirement_id),
    db.from('requirement_items').select('*').eq('requirement_id', task.requirement_id),
    db.from('requirements').select('status').eq('id', task.requirement_id).single(),
  ])

  const gapsForScoring = (allGaps ?? []).map(g => ({
    item_id: g.item_id, severity: g.severity, category: g.category,
    description: g.description, source: g.source, rule_id: g.rule_id,
    priority_score: g.priority_score, confidence: g.confidence, question_generated: g.question_generated,
  }))

  const score = computeScore(gapsForScoring, new Set(), allItems ?? [])
  await db.from('completeness_scores').insert({
    requirement_id: task.requirement_id,
    overall_score: score.overall_score, completeness: score.completeness,
    nfr_score: score.nfr_score, confidence: score.confidence,
    breakdown: score.breakdown, scored_at: new Date().toISOString(),
  })

  const newReqStatus = computeStatusFromScore(allGaps ?? [])
  if (currentReq?.status !== 'blocked') {
    await db.from('requirements').update({ status: newReqStatus, updated_at: new Date().toISOString() }).eq('id', task.requirement_id)
  }
  await db.from('audit_log').insert({
    entity_type: 'investigation_tasks', entity_id: id, action: 'updated',
    actor_id: user.id, diff: { status: newStatus, gap_resolved: newStatus === 'resolved' && !!task.linked_gap_id },
  })

  return NextResponse.json({ status: newStatus, new_requirement_status: newReqStatus })
}
