// app/projects/[id]/changes/[changeId]/execution/page.tsx
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ExecutionView from './execution-view'

export default async function ExecutionPage({
  params,
}: {
  params: Promise<{ id: string; changeId: string }>
}) {
  const { id, changeId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: change } = await db
    .from('change_requests')
    .select('id, title, status, risk_level, projects!inner(id, name, owner_id)')
    .eq('id', changeId)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) redirect(`/projects/${id}`)

  const proj = change.projects as unknown as { id: string; name: string }

  return <ExecutionView change={change} project={proj} />
}
