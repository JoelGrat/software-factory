import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runFullScan } from '@/lib/scanner/scanner'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db
    .from('projects')
    .select('scan_status, scan_error, scan_progress')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(project)
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db
    .from('projects')
    .select('id, repo_url')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!project.repo_url) return NextResponse.json({ error: 'No repository configured' }, { status: 400 })

  const adminDb = createAdminClient()
  await adminDb.from('projects').update({ scan_status: 'scanning', scan_error: null }).eq('id', id)

  // Fire and forget — don't await so the 202 returns immediately
  runFullScan(id, adminDb).catch(err => console.error('[scan]', err))

  return NextResponse.json({ status: 'scanning' }, { status: 202 })
}
