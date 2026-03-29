import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { IExecutor } from '@/lib/agent/executor'
import type { ParsedItem } from '@/lib/requirements/parser'
import type { AgentPlan } from '@/lib/supabase/types'
import { runPlannerAgent } from '@/lib/agent/agents/planner.agent'
import { runCoderAgent } from '@/lib/agent/agents/coder.agent'
import { logProgress } from '@/lib/agent/progress'

const MAX_CODING_ITERATIONS = 10

export async function runJob(
  jobId: string,
  phase: 'planning' | 'coding',
  db: SupabaseClient,
  ai: AIProvider,
  executor: IExecutor
): Promise<void> {
  if (phase === 'planning') {
    await runPlanningPhase(jobId, db, ai, executor)
  } else {
    await runCodingPhase(jobId, db, ai, executor)
  }
}

async function runPlanningPhase(jobId: string, db: SupabaseClient, ai: AIProvider, executor: IExecutor) {
  try {
    await db.from('jobs').update({ status: 'plan_loop' }).eq('id', jobId)
    await logProgress(db, jobId, 'planning', 'Planning started — reading project structure...', 'info')

    const { project, items } = await loadJobContext(jobId, db)

    await logProgress(db, jobId, 'planning', 'File tree loaded — generating implementation plan...', 'info')

    const planPath = project.setup_mode === 'imported' ? (project.target_path ?? null) : null
    const plan = await runPlannerAgent(items, planPath, executor, ai)

    await db.from('agent_plans').insert({
      job_id: jobId,
      tasks: plan.tasks,
      files_to_create: plan.files_to_create,
      files_to_modify: plan.files_to_modify,
      test_approach: plan.test_approach,
      branch_name: plan.branch_name,
      spec_markdown: plan.spec_markdown ?? null,
    })

    await db.from('jobs').update({ status: 'awaiting_plan_approval', branch_name: plan.branch_name }).eq('id', jobId)
    await logProgress(db, jobId, 'planning', `Plan ready — ${plan.tasks.length} tasks, ${plan.files_to_create.length + plan.files_to_modify.length} files`, 'success')
  } catch (err) {
    const msg = String(err)
    await db.from('jobs').update({ status: 'failed', error: msg, completed_at: new Date().toISOString() }).eq('id', jobId)
    await logProgress(db, jobId, 'planning', `Planning failed: ${msg}`, 'error')
  }
}

async function runCodingPhase(jobId: string, db: SupabaseClient, ai: AIProvider, executor: IExecutor) {
  try {
    await db.from('jobs').update({ status: 'coding' }).eq('id', jobId)
    await logProgress(db, jobId, 'coding', 'Coding started...', 'info')

    const { project, items } = await loadJobContext(jobId, db)

    if (!project.target_path) throw new Error('Project target_path not configured. Set it in project settings.')

    const { data: planRow } = await db.from('agent_plans').select('*').eq('job_id', jobId).single()
    if (!planRow) throw new Error('No plan found for job')

    const plan: Omit<AgentPlan, 'id' | 'job_id' | 'created_at'> = {
      tasks: planRow.tasks,
      files_to_create: planRow.files_to_create,
      files_to_modify: planRow.files_to_modify,
      test_approach: planRow.test_approach,
      branch_name: planRow.branch_name,
      spec_markdown: planRow.spec_markdown ?? null,
    }

    // Write SPEC.md to the project directory
    if (plan.spec_markdown) {
      await executor.writeFiles(project.target_path, [{ path: 'SPEC.md', content: plan.spec_markdown, operation: 'create' }])
      await logProgress(db, jobId, 'coding', 'SPEC.md written to project directory', 'info')
    }

    let previousErrors: string[] = []
    let done = false

    for (let i = 0; i < MAX_CODING_ITERATIONS && !done; i++) {
      await logProgress(db, jobId, 'coding', `Coding iteration ${i + 1} / ${MAX_CODING_ITERATIONS}...`, 'info')
      await db.from('jobs').update({ iteration_count: i + 1 }).eq('id', jobId)

      // Check if cancelled
      const { data: currentJob } = await db.from('jobs').select('status').eq('id', jobId).single()
      if (currentJob?.status === 'cancelled') return

      const filesToRead = [...plan.files_to_create, ...plan.files_to_modify]
      const currentFileContents = await executor.readFiles(project.target_path, filesToRead)

      const changes = await runCoderAgent(items, plan, previousErrors, currentFileContents, ai)
      await executor.writeFiles(project.target_path, changes)

      await logProgress(db, jobId, 'coding', `Applied ${changes.length} file changes — running tests...`, 'info')

      const testResult = await executor.runTests(project.target_path)

      if (testResult.success) {
        done = true
        await executor.createBranch(project.target_path, plan.branch_name)
        await db.from('jobs').update({ status: 'awaiting_review', branch_name: plan.branch_name }).eq('id', jobId)
        await logProgress(db, jobId, 'coding', `All tests passed — branch created: ${plan.branch_name}`, 'success')
      } else {
        previousErrors = testResult.errors
        await logProgress(db, jobId, 'coding', `${testResult.failed} test(s) failed — feeding back errors...`, 'warn')
      }
    }

    if (!done) {
      await db.from('jobs').update({ status: 'failed', error: `Tests still failing after ${MAX_CODING_ITERATIONS} iterations`, completed_at: new Date().toISOString() }).eq('id', jobId)
      await logProgress(db, jobId, 'coding', `Max iterations reached — job failed`, 'error')
    }
  } catch (err) {
    const msg = String(err)
    await db.from('jobs').update({ status: 'failed', error: msg, completed_at: new Date().toISOString() }).eq('id', jobId)
    await logProgress(db, jobId, 'coding', `Coding failed: ${msg}`, 'error')
  }
}

async function loadJobContext(jobId: string, db: SupabaseClient) {
  const { data: job } = await db.from('jobs').select('*').eq('id', jobId).single()
  if (!job) throw new Error('Job not found')

  const { data: project } = await db.from('projects').select('id, target_path, setup_mode').eq('id', job.project_id).single()
  if (!project) throw new Error('Project not found')

  const { data: req } = await db.from('requirements').select('raw_input').eq('id', job.requirement_id).single()
  if (!req) throw new Error('Requirement not found')

  const { data: itemRows } = await db.from('requirement_items').select('*').eq('requirement_id', job.requirement_id)
  const items: ParsedItem[] = (itemRows ?? []).map((r: Record<string, unknown>) => ({
    type: r.type as ParsedItem['type'],
    title: r.title as string,
    description: r.description as string,
    priority: r.priority as ParsedItem['priority'],
    source_text: r.source_text as string | null,
    nfr_category: r.nfr_category as ParsedItem['nfr_category'],
  }))

  return { job, project, req, items }
}
