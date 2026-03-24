import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { validateStatusTransition, checkReadyForDevGate } from '@/lib/requirements/status-validator'
import type { RequirementStatus } from '@/lib/supabase/types'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createServerSupabaseClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  if (!body.status || typeof body.status !== 'string') {
    return NextResponse.json({ error: 'status is required' }, { status: 400 })
  }
  const newStatus: RequirementStatus = body.status
  const blockedReason: string | null = body.blocked_reason ?? null

  const { data: current } = await db.from('requirements').select('status').eq('id', id).single()
  if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (!validateStatusTransition(current.status as RequirementStatus, newStatus)) {
    return NextResponse.json(
      { error: `Cannot transition from ${current.status} to ${newStatus}` },
      { status: 409 }
    )
  }

  if (newStatus === 'ready_for_dev') {
    const { data: gaps } = await db
      .from('gaps')
      .select('severity, resolved_at, merged_into')
      .eq('requirement_id', id)
    const gate = checkReadyForDevGate(gaps ?? [])
    if (gate.blocked) {
      return NextResponse.json({ error: `Cannot mark ready_for_dev: ${gate.reason}` }, { status: 409 })
    }
  }

  const { error: updateError } = await db.from('requirements').update({
    status: newStatus,
    blocked_reason: newStatus === 'blocked' ? blockedReason : null,
    updated_at: new Date().toISOString(),
  }).eq('id', id)
  if (updateError) return NextResponse.json({ error: 'Failed to update status' }, { status: 500 })

  await db.from('audit_log').insert({
    entity_type: 'requirements',
    entity_id: id,
    action: 'updated',
    actor_id: user.id,
    diff: { status: { from: current.status, to: newStatus } },
  })

  return NextResponse.json({ status: newStatus })
}
