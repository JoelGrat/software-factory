'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { AgentPlan, PlanTask } from '@/lib/supabase/types'
import { JobShell } from '@/components/agent/job-shell'
import { StepIndicator } from '@/components/agent/step-indicator'

interface Props {
  jobId: string
  projectId: string
  projectName: string
  plan: AgentPlan
}

export function PlanScreen({ jobId, projectId, projectName, plan }: Props) {
  const router = useRouter()
  const [approving, setApproving] = useState(false)
  const [approveError, setApproveError] = useState<string | null>(null)

  async function approvePlan() {
    setApproving(true)
    setApproveError(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve_plan' }),
      })
      if (!res.ok) { setApproveError('Failed to approve plan. Please try again.'); return }
      router.push(`/projects/${projectId}/jobs/${jobId}/execution`)
    } catch {
      setApproveError('Failed to approve plan. Please try again.')
    } finally {
      setApproving(false)
    }
  }

  async function cancel() {
    try {
      await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      })
    } catch { /* best-effort */ }
    router.push(`/projects/${projectId}/requirements`)
  }

  const sidebar = (
    <div className="p-5 space-y-4">
      <div className="p-3 bg-surface-container rounded-lg border border-outline-variant/10">
        <div className="text-[10px] text-outline uppercase font-bold mb-1">Branch</div>
        <code className="text-xs font-mono text-indigo-300 break-all">{plan.branch_name || 'not yet created'}</code>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 bg-surface-container rounded-lg border border-outline-variant/10 text-center">
          <div className="text-[10px] text-outline uppercase font-bold mb-1">Create</div>
          <div className="text-xl font-bold font-headline text-[#22c55e]">{plan.files_to_create.length}</div>
        </div>
        <div className="p-3 bg-surface-container rounded-lg border border-outline-variant/10 text-center">
          <div className="text-[10px] text-outline uppercase font-bold mb-1">Modify</div>
          <div className="text-xl font-bold font-headline text-[#f59e0b]">{plan.files_to_modify.length}</div>
        </div>
      </div>

      <div className="p-3 bg-surface-container rounded-lg border border-outline-variant/10">
        <div className="text-[10px] text-outline uppercase font-bold mb-1">Tasks</div>
        <div className="text-xl font-bold font-headline text-indigo-100">{plan.tasks.length}</div>
      </div>

      {plan.test_approach && (
        <div className="p-3 bg-surface-container rounded-lg border border-outline-variant/10">
          <div className="text-[10px] text-outline uppercase font-bold mb-2">Test Approach</div>
          <p className="text-xs text-on-surface-variant leading-relaxed">{plan.test_approach}</p>
        </div>
      )}
    </div>
  )

  return (
    <JobShell
      projectName={projectName}
      projectId={projectId}
      jobId={jobId}
      sidebar={sidebar}
      sidebarTitle="Plan Summary"
    >
      <div className="max-w-4xl mx-auto space-y-8">
        <StepIndicator current={3} />

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-extrabold font-headline tracking-tight text-white mb-2">
              Review Implementation Plan
            </h1>
            <p className="text-on-surface-variant text-sm">
              Branch: <code className="font-mono text-indigo-300">{plan.branch_name || 'not yet created'}</code>
            </p>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0 ml-6">
            <button
              onClick={cancel}
              className="text-xs font-bold text-outline hover:text-white transition-colors uppercase tracking-widest px-4 py-2"
            >
              Cancel
            </button>
            <button
              onClick={approvePlan}
              disabled={approving}
              className="bg-gradient-to-br from-primary to-primary-container text-on-primary-container px-6 py-2.5 rounded-lg font-headline font-extrabold text-sm flex items-center gap-2 shadow-[0_4px_20px_rgba(189,194,255,0.2)] hover:scale-[1.02] transition-transform active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed disabled:scale-100"
            >
              {approving ? 'Approving...' : 'Approve Plan'}
              {!approving && <span className="material-symbols-outlined text-[16px]">arrow_forward</span>}
            </button>
          </div>
        </div>

        {approveError && (
          <p className="text-xs text-error font-mono">{approveError}</p>
        )}

        {/* Files */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-surface-container rounded-xl p-4 border border-outline-variant/10">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-[#22c55e] mb-3">
              Create ({plan.files_to_create.length})
            </h3>
            {plan.files_to_create.length === 0
              ? <p className="text-xs text-outline font-mono">None</p>
              : plan.files_to_create.map(f => (
                  <div key={f} className="text-xs text-on-surface-variant font-mono mb-1">+ {f}</div>
                ))}
          </div>
          <div className="bg-surface-container rounded-xl p-4 border border-outline-variant/10">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-[#f59e0b] mb-3">
              Modify ({plan.files_to_modify.length})
            </h3>
            {plan.files_to_modify.length === 0
              ? <p className="text-xs text-outline font-mono">None</p>
              : plan.files_to_modify.map(f => (
                  <div key={f} className="text-xs text-on-surface-variant font-mono mb-1">~ {f}</div>
                ))}
          </div>
        </div>

        {/* Tasks */}
        <div>
          <h2 className="font-headline font-bold text-on-surface mb-4 flex items-center gap-2">
            <span className="material-symbols-outlined text-indigo-400 text-[20px]">checklist</span>
            Tasks ({(plan.tasks as PlanTask[]).length})
          </h2>
          <div className="space-y-3">
            {(plan.tasks as PlanTask[]).map((task, i) => (
              <div key={task.id} className="bg-surface-container rounded-xl p-4 border border-outline-variant/10">
                <div className="flex gap-3 items-start">
                  <span className="text-xs font-mono text-indigo-400 min-w-[20px] mt-0.5">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-on-surface mb-1">{task.title}</p>
                    <p className="text-xs text-on-surface-variant mb-2">{task.description}</p>
                    <div className="flex gap-1.5 flex-wrap">
                      {task.files.map(f => (
                        <span key={f} className="text-[10px] text-outline font-mono bg-surface-container-high px-1.5 py-0.5 rounded">{f}</span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </JobShell>
  )
}
