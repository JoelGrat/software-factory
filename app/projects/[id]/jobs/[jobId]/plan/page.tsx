import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PlanScreen } from '@/components/agent/plan-screen'
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
    .select('*, projects!inner(owner_id)')
    .eq('id', jobId)
    .single()

  if (!job || (job.projects as { owner_id: string }).owner_id !== user.id) redirect('/projects')
  if (job.status !== 'awaiting_plan_approval') redirect(`/projects/${projectId}/jobs/${jobId}/execution`)

  const { data: plan } = await db.from('agent_plans').select('*').eq('job_id', jobId).single()
  if (!plan) redirect(`/projects/${projectId}/jobs/${jobId}/execution`)

  return <PlanScreen jobId={jobId} projectId={projectId} plan={plan as AgentPlan} />
}
