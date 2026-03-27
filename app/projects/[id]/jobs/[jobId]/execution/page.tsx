import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ExecutionScreen } from '@/components/agent/execution-screen'
import type { Job, LogEntry } from '@/lib/supabase/types'

interface Props {
  params: Promise<{ id: string; jobId: string }>
}

export default async function ExecutionPage({ params }: Props) {
  const { id: projectId, jobId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: job } = await db
    .from('jobs')
    .select('*, projects!inner(owner_id, name)')
    .eq('id', jobId)
    .single()

  if (!job || (job.projects as { owner_id: string }).owner_id !== user.id) redirect('/projects')

  if (job.status === 'awaiting_plan_approval') redirect(`/projects/${projectId}/jobs/${jobId}/plan`)
  if (job.status === 'awaiting_review' || job.status === 'done') redirect(`/projects/${projectId}/jobs/${jobId}/review`)

  const { data: logs } = await db
    .from('job_logs')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: true })

  const projectName = (job.projects as { name: string }).name
  return (
    <ExecutionScreen
      jobId={jobId}
      projectId={projectId}
      projectName={projectName}
      initialJob={job as Job}
      initialLogs={(logs ?? []) as LogEntry[]}
    />
  )
}
