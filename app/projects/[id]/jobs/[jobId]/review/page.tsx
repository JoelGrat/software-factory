import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { LocalExecutor } from '@/lib/agent/executor'
import { ReviewScreen } from '@/components/agent/review-screen'
import type { Job } from '@/lib/supabase/types'

interface Props {
  params: Promise<{ id: string; jobId: string }>
}

export default async function ReviewPage({ params }: Props) {
  const { id: projectId, jobId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: job } = await db
    .from('jobs')
    .select('*, projects!inner(owner_id, target_path)')
    .eq('id', jobId)
    .single()

  if (!job || (job.projects as { owner_id: string }).owner_id !== user.id) redirect('/projects')
  if (job.status !== 'awaiting_review' && job.status !== 'done') redirect(`/projects/${projectId}/jobs/${jobId}/execution`)

  const targetPath = (job.projects as { target_path?: string }).target_path ?? null
  let diff = ''
  if (targetPath) {
    try {
      const executor = new LocalExecutor()
      diff = await executor.getGitDiff(targetPath)
    } catch { /* diff unavailable */ }
  }

  // Get last test result from logs
  const { data: logs } = await db
    .from('job_logs')
    .select('message')
    .eq('job_id', jobId)
    .eq('level', 'success')
    .order('created_at', { ascending: false })
    .limit(1)

  // Parse passed count from success log if available
  const lastSuccessMsg = logs?.[0]?.message ?? ''
  const passedMatch = lastSuccessMsg.match(/(\d+)\s+test/)
  const testResult = passedMatch
    ? { success: true, passed: parseInt(passedMatch[1]), failed: 0, errors: [], raw_output: '' }
    : null

  return (
    <ReviewScreen
      jobId={jobId}
      projectId={projectId}
      job={job as Job}
      diff={diff}
      testResult={testResult}
    />
  )
}
