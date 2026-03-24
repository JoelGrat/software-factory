import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/ai/registry'
import { runPipeline } from '@/lib/requirements/pipeline'
import { classifyAndSeedDomain } from '@/lib/requirements/knowledge/domain-classifier'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createServerSupabaseClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: req } = await db.from('requirements').select('raw_input').eq('id', id).single()
  if (!req) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const ai = getProvider()
  const result = await runPipeline(id, req.raw_input, user.id, db, ai)

  if (result.success) {
    const { data: project } = await db.from('requirements').select('project_id').eq('id', params.id).single()
    if (project?.project_id) {
      void classifyAndSeedDomain(project.project_id, req.raw_input, db, ai)
    }
  }

  return NextResponse.json(result, { status: result.success ? 200 : 422 })
}
