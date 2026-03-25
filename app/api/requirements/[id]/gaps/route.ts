import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildGapsWithDetails } from '@/lib/requirements/gaps-with-details'
import type { Gap, Question, InvestigationTask } from '@/lib/supabase/types'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [{ data: gaps }, { data: questions }, { data: tasks }] = await Promise.all([
    db.from('gaps').select('*').eq('requirement_id', id),
    db.from('questions').select('*').eq('requirement_id', id),
    db.from('investigation_tasks').select('*').eq('requirement_id', id),
  ])

  const result = buildGapsWithDetails(
    (gaps ?? []) as Gap[],
    (questions ?? []) as Question[],
    (tasks ?? []) as InvestigationTask[]
  )

  return NextResponse.json(result)
}
