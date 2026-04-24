// app/projects/[id]/changes/[changeId]/execution/page.tsx
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ExecutionView from './execution-view'

export default async function ExecutionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; changeId: string }>
  searchParams: Promise<{ autoStart?: string }>
}) {
  const [{ id, changeId }, sp] = await Promise.all([params, searchParams])
  const autoStart = sp.autoStart === '1'
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: change } = await db
    .from('change_requests')
    .select('id, title, status, risk_level, review_feedback, projects!inner(id, name, owner_id)')
    .eq('id', changeId)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) redirect(`/projects/${id}`)

  const proj = change.projects as unknown as { id: string; name: string }

  return <ExecutionView change={change} project={proj} autoStart={autoStart} />
}
