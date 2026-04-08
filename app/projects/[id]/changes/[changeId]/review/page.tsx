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

  const { data: change } = await db
    .from('change_requests')
    .select('id, title, intent, type, risk_level, status, projects!inner(id, name, owner_id, repo_url)')
    .eq('id', changeId)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) redirect(`/projects/${id}`)

  const proj = change.projects as unknown as { id: string; name: string; repo_url: string | null }

  const { data: snapshots } = await db
    .from('execution_snapshots')
    .select('id, iteration, files_modified, tests_passed, tests_failed, termination_reason, planned_files')
    .eq('change_id', changeId)
    .order('iteration', { ascending: true })

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

  const passedSnapshot = [...(snapshots ?? [])].reverse().find(s => s.termination_reason === 'passed')
  const allFiles = [...new Set((snapshots ?? []).flatMap(s => s.files_modified ?? []))]

  return (
    <ReviewView
      change={{ ...change, project_id: id }}
      project={proj}
      commit={commit ?? null}
      tasks={(tasks ?? []) as any[]}
      filesModified={allFiles}
      testsPassed={passedSnapshot?.tests_passed ?? 0}
      testsFailed={passedSnapshot?.tests_failed ?? 0}
      iterationCount={snapshots?.length ?? 0}
    />
  )
}
