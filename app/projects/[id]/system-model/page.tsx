import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { SystemModelBrowser } from './system-model-browser'

export default async function SystemModelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: project } = await db
    .from('projects')
    .select('id, name, scan_status, scan_error, scan_progress')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) redirect('/projects')

  const { data: rawComponents } = await db
    .from('system_components')
    .select('id, name, type, status, is_anchored, scan_count, last_updated')
    .eq('project_id', id)
    .is('deleted_at', null)
    .order('name')

  const compIds = (rawComponents ?? []).map(c => c.id)

  const [{ data: assignments }, { data: dependencies }] = compIds.length > 0
    ? await Promise.all([
        db.from('component_assignment')
          .select('component_id, confidence, files!file_id(path)')
          .in('component_id', compIds)
          .eq('is_primary', true),
        db.from('component_dependencies')
          .select('from_id, to_id')
          .in('from_id', compIds),
      ])
    : [{ data: [] }, { data: [] }]

  // Per-component: confidence avg + top 3 file paths
  const confAccum: Record<string, { total: number; n: number }> = {}
  const filePaths: Record<string, string[]> = {}

  for (const a of (assignments ?? [])) {
    if (!confAccum[a.component_id]) confAccum[a.component_id] = { total: 0, n: 0 }
    confAccum[a.component_id].total += a.confidence
    confAccum[a.component_id].n++

    const path = (a.files as any)?.path as string | undefined
    if (path) {
      if (!filePaths[a.component_id]) filePaths[a.component_id] = []
      if (filePaths[a.component_id].length < 3) filePaths[a.component_id].push(path)
    }
  }

  const components = (rawComponents ?? []).map(c => {
    const conf = confAccum[c.id]
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      status: c.status,
      is_anchored: c.is_anchored,
      scan_count: c.scan_count,
      last_updated: c.last_updated,
      fileCount: confAccum[c.id]?.n ?? 0,
      confidence: conf ? Math.round(conf.total / conf.n) : 50,
      topFiles: filePaths[c.id] ?? [],
    }
  })

  const avgConfidence = components.length > 0
    ? Math.round(components.reduce((s, c) => s + c.confidence, 0) / components.length)
    : 0
  const stats = {
    componentCount: components.length,
    edgeCount: (dependencies ?? []).length,
    avgConfidence,
    lowConfidenceCount: components.filter(c => c.confidence < 60).length,
    unstableCount: components.filter(c => c.status === 'unstable').length,
  }

  return (
    <SystemModelBrowser
      project={project as any}
      components={components}
      dependencies={dependencies ?? []}
      stats={stats}
    />
  )
}
