import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/ai/registry'
import { runPipeline } from '@/lib/requirements/pipeline'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createServerSupabaseClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: req } = await db.from('requirements').select('raw_input').eq('id', id).single()
  if (!req) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const ai = getProvider()
  const result = await runPipeline(id, req.raw_input, user.id, db, ai)
  return NextResponse.json(result, { status: result.success ? 200 : 422 })
}
