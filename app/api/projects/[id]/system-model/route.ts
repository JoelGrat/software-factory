import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify project ownership
  const { data: project } = await db
    .from('projects')
    .select('id, scan_status')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: components } = await db
    .from('system_components')
    .select('id, name, type, status, is_anchored, scan_count, last_updated, deleted_at')
    .eq('project_id', id)
    .is('deleted_at', null)
    .order('name')

  const componentIds = (components ?? []).map(c => c.id)

  const { data: assignments } = componentIds.length > 0
    ? await db
        .from('component_assignment')
        .select('file_id, component_id, confidence, is_primary, status')
        .in('component_id', componentIds)
        .eq('is_primary', true)
    : { data: [] }

  const stable = (components ?? []).filter(c => c.status === 'stable').length
  const unstable = (components ?? []).filter(c => c.status === 'unstable').length

  return NextResponse.json({
    scan_status: project.scan_status,
    components: components ?? [],
    assignments: assignments ?? [],
    stats: {
      total: (components ?? []).length,
      stable,
      unstable,
    },
  })
}
