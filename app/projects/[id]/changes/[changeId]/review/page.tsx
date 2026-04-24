// app/projects/[id]/changes/[changeId]/review/page.tsx
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ReviewView from './review-view'

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string; changeId: string }>
}) {
  const { id, changeId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: project } = await db
    .from('projects')
    .select('id, name, repo_url')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) redirect('/projects')

  const { data: change } = await db
    .from('change_requests')
    .select('id, title, intent, type, risk_level, status, review_feedback')
    .eq('id', changeId)
    .eq('project_id', id)
    .single()

  if (!change) redirect(`/projects/${id}`)

  const proj = project

  const { data: commit } = await db
    .from('change_commits')
    .select('id, branch_name, commit_hash, created_at')
    .eq('change_id', changeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: latestPlan } = await db
    .from('change_plans')
    .select('id')
    .eq('change_id', changeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: tasks } = latestPlan
    ? await db
        .from('change_plan_tasks')
        .select('id, description, status, order_index, system_components(name, type)')
        .eq('plan_id', latestPlan.id)
        .order('order_index', { ascending: true })
    : { data: [] }

  // Read execution stats from the latest execution run summary
  const { data: latestRun } = await db
    .from('execution_runs')
    .select('id, summary')
    .eq('change_id', changeId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const summary = latestRun?.summary as {
    filesChanged?: string[]
    iterationsUsed?: number
    taskRunSummary?: { completedTasks?: string[]; totalTasks?: number }
  } | null

  const filesModified = summary?.filesChanged ?? []
  const iterationCount = summary?.iterationsUsed ?? 0

  // Derive test counts from validation events in the latest run
  const { data: validationEvents } = latestRun
    ? await db
        .from('execution_events')
        .select('event_type')
        .eq('run_id', latestRun.id)
        .in('event_type', ['task.validation_passed', 'task.validation_failed'])
    : { data: [] }

  const testsPassed = (validationEvents ?? []).filter(e => e.event_type === 'task.validation_passed').length
  const testsFailed = (validationEvents ?? []).filter(e => e.event_type === 'task.validation_failed').length

  return (
    <ReviewView
      change={{ ...change, project_id: id }}
      project={proj}
      commit={commit ?? null}
      tasks={(tasks ?? []) as any[]}
      filesModified={filesModified}
      testsPassed={testsPassed}
      testsFailed={testsFailed}
      iterationCount={iterationCount}
    />
  )
}
