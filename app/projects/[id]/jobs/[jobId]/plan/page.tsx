import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PlanScreen } from '@/components/agent/plan-screen'
import { PlanLoading } from '@/components/agent/plan-loading'
import type { AgentPlan } from '@/lib/supabase/types'

interface Props {
  params: Promise<{ id: string; jobId: string }>
}

export default async function PlanPage({ params }: Props) {
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

  const projectName = (job.projects as { name: string }).name

  if (job.status === 'plan_loop' || job.status === 'pending') {
    return <PlanLoading jobId={jobId} projectId={projectId} projectName={projectName} />
  }

  if (job.status === 'failed' || job.status === 'cancelled') {
    return <PlanLoading jobId={jobId} projectId={projectId} projectName={projectName} initialError={job.error ?? 'Planning failed'} />
  }

  if (job.status !== 'awaiting_plan_approval') {
    redirect(`/projects/${projectId}/jobs/${jobId}/execution`)
  }

  const { data: plan } = await db.from('agent_plans').select('*').eq('job_id', jobId).single()
  if (!plan) redirect(`/projects/${projectId}/jobs/${jobId}/execution`)

  return <PlanScreen jobId={jobId} projectId={projectId} projectName={projectName} plan={plan as AgentPlan} />
}
