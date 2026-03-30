'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
// TODO: replaced in Plan 2/3/4 — old types removed in migration 006
/* eslint-disable @typescript-eslint/no-explicit-any */
// import type { Job, LogEntry, JobStatus } from '@/lib/supabase/types' // removed in migration 006
import { JobShell } from '@/components/agent/job-shell'
import { StepIndicator } from '@/components/agent/step-indicator'

const PHASES: { key: string; label: string; icon: string; statuses: any[] }[] = [
  { key: 'planning', label: 'Planning', icon: 'manage_search', statuses: ['plan_loop', 'awaiting_plan_approval'] },
  { key: 'coding', label: 'Coding', icon: 'terminal', statuses: ['coding'] },
  { key: 'review', label: 'Review', icon: 'fact_check', statuses: ['awaiting_review', 'done'] },
]

function phaseStatus(phase: typeof PHASES[0], job: any): 'pending' | 'active' | 'done' | 'failed' {
  if (job.status === 'failed' || job.status === 'cancelled') {
    if (phase.statuses.includes(job.status as any)) return 'failed'
    const phaseIdx = PHASES.findIndex(p => p.key === phase.key)
    const jobPhaseIdx = PHASES.findIndex(p => p.statuses.some(s => s === job.status))
    return phaseIdx < jobPhaseIdx ? 'done' : 'pending'
  }
  if (phase.statuses.includes(job.status)) return 'active'
  const phaseIdx = PHASES.findIndex(p => p.key === phase.key)
  const jobPhaseIdx = PHASES.findIndex(p => p.statuses.some(s => s === job.status))
  if (jobPhaseIdx === -1) return 'pending'
  return phaseIdx < jobPhaseIdx ? 'done' : 'pending'
}

const logLevelColor: Record<string, string> = {
  info: '#c7c4d7',
  warn: '#f59e0b',
  error: '#ffb4ab',
  success: '#22c55e',
}

const logLevelIcon: Record<string, string> = {
  info: 'info',
  warn: 'warning',
  error: 'error',
  success: 'check_circle',
}


interface Props {
  jobId: string
  projectId: string
  projectName: string
  initialJob: any
  initialLogs: any[]
}

export function ExecutionScreen({ jobId, projectId, projectName, initialJob, initialLogs }: Props) {
  const router = useRouter()
  const [job, setJob] = useState<any>(initialJob)
  const [logs, setLogs] = useState<any[]>(initialLogs)
  const [retryLoading, setRetryLoading] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  const dbRef = useRef(createClient())
  const logsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  useEffect(() => {
    const jobChannel = dbRef.current
      .channel(`job-${jobId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'jobs', filter: `id=eq.${jobId}` }, payload => {
        const updated = payload.new as any
        setJob(updated)
        if (updated.status === 'awaiting_plan_approval') {
          router.push(`/projects/${projectId}/jobs/${jobId}/plan`)
        }
        if (updated.status === 'awaiting_review') {
          router.push(`/projects/${projectId}/jobs/${jobId}/review`)
        }
      })
      .subscribe()

    const logsChannel = dbRef.current
      .channel(`logs-${jobId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'job_logs', filter: `job_id=eq.${jobId}` }, payload => {
        setLogs(prev => [...prev, payload.new as any])
      })
      .subscribe()

    return () => {
      dbRef.current.removeChannel(jobChannel)
      dbRef.current.removeChannel(logsChannel)
    }
  }, [jobId, projectId, router])

  const isFailed = job.status === 'failed' || job.status === 'cancelled'

  async function handleRetry() {
    setRetryLoading(true)
    setRetryError(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry' }),
      })
      if (!res.ok) setRetryError('Failed to retry. Please try again.')
    } catch {
      setRetryError('Failed to retry. Please try again.')
    } finally {
      setRetryLoading(false)
    }
  }

  async function handleCancel() {
    try {
      await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      })
    } catch { /* best-effort */ }
    router.push(`/projects/${projectId}/requirements`)
  }

  const currentPhaseLabel = PHASES.find(p => p.statuses.includes(job.status as any))?.label ?? 'Processing'
  const sidebar = (
    <div className="flex flex-col h-full">
      {/* Live log feed */}
      <div className="flex-1 overflow-y-auto no-scrollbar p-4 space-y-1 font-mono text-[11px]">
        {logs.length === 0 && (
          <div className="flex items-center gap-2 text-outline">
            <span className="material-symbols-outlined text-[14px] animate-pulse">hourglass_empty</span>
            <span>Waiting for agent to start...</span>
          </div>
        )}
        {logs.map(log => (
          <div key={log.id} className="flex items-start gap-2 py-0.5">
            <span
              className="material-symbols-outlined text-[12px] mt-0.5 flex-shrink-0"
              style={{ color: logLevelColor[log.level] ?? '#c7c4d7' }}
            >
              {logLevelIcon[log.level] ?? 'circle'}
            </span>
            <div className="flex-1 min-w-0">
              <span className="text-outline mr-2">{new Date(log.created_at).toLocaleTimeString()}</span>
              <span style={{ color: logLevelColor[log.level] ?? '#c7c4d7' }}>{log.message}</span>
            </div>
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  )

  return (
    <JobShell
      projectName={projectName}
      projectId={projectId}
      jobId={jobId}
      sidebar={sidebar}
      sidebarTitle={`Agent Activity Log (${logs.length})`}
    >
      <div className="max-w-4xl mx-auto space-y-8">
        <StepIndicator current={4} />

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-2">
              {!isFailed && (
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-indigo-400" />
                </span>
              )}
              <h1 className="text-3xl font-extrabold font-headline tracking-tight text-white">
                {isFailed ? 'Execution Failed' : 'Executing Plan'}
              </h1>
            </div>
            <p className="text-on-surface-variant text-sm">
              {isFailed
                ? 'The agent encountered an error. Review the logs and retry.'
                : `${currentPhaseLabel}${job.status === 'coding' ? ` — Iteration ${job.iteration_count} / 10` : ''}`}
            </p>
          </div>
          {!isFailed && (
            <button
              onClick={handleCancel}
              className="text-xs font-bold text-outline hover:text-white transition-colors uppercase tracking-widest px-4 py-2 flex-shrink-0 ml-6"
            >
              Cancel
            </button>
          )}
          {isFailed && (
            <div className="flex-shrink-0 ml-6 flex flex-col items-end gap-1">
              <button
                onClick={handleRetry}
                disabled={retryLoading}
                className="bg-gradient-to-br from-primary to-primary-container text-on-primary-container px-6 py-2.5 rounded-lg font-headline font-extrabold text-sm flex items-center gap-2 shadow-[0_4px_20px_rgba(189,194,255,0.2)] hover:scale-[1.02] transition-transform active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed disabled:scale-100"
              >
                {retryLoading ? 'Retrying...' : 'Retry'}
                {!retryLoading && <span className="material-symbols-outlined text-[16px]">refresh</span>}
              </button>
              {retryError && <span className="text-[10px] text-error font-mono">{retryError}</span>}
            </div>
          )}
        </div>

        {/* Phase cards */}
        <div className="grid grid-cols-3 gap-4">
          {PHASES.map(phase => {
            const ps = phaseStatus(phase, job)
            return (
              <div
                key={phase.key}
                className={[
                  'p-4 rounded-xl border transition-all',
                  ps === 'active'
                    ? 'bg-indigo-500/10 border-indigo-500/40 shadow-[0_0_20px_rgba(99,102,241,0.1)]'
                    : ps === 'done'
                      ? 'bg-surface-container border-outline-variant/10'
                      : ps === 'failed'
                        ? 'bg-error-container/10 border-error/30'
                        : 'bg-surface-container border-outline-variant/10 opacity-40',
                ].join(' ')}
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className={[
                    'w-8 h-8 rounded-lg flex items-center justify-center',
                    ps === 'active' ? 'bg-indigo-500/20' : ps === 'done' ? 'bg-primary/20' : ps === 'failed' ? 'bg-error/20' : 'bg-surface-container-high',
                  ].join(' ')}>
                    {ps === 'done'
                      ? <span className="material-symbols-outlined text-primary text-[18px]">check</span>
                      : ps === 'failed'
                        ? <span className="material-symbols-outlined text-error text-[18px]">close</span>
                        : <span className={`material-symbols-outlined text-[18px] ${ps === 'active' ? 'text-indigo-400' : 'text-outline'}`}>{phase.icon}</span>
                    }
                  </div>
                  <span className={`font-headline font-bold text-sm ${ps === 'active' ? 'text-indigo-300' : ps === 'done' ? 'text-on-surface-variant' : ps === 'failed' ? 'text-error' : 'text-outline'}`}>
                    {phase.label}
                  </span>
                </div>
                <div className={`text-[10px] font-bold uppercase tracking-widest ${ps === 'active' ? 'text-indigo-400' : ps === 'done' ? 'text-primary/60' : ps === 'failed' ? 'text-error/60' : 'text-outline/40'}`}>
                  {ps === 'active' ? 'In Progress' : ps === 'done' ? 'Complete' : ps === 'failed' ? 'Failed' : 'Pending'}
                </div>
              </div>
            )
          })}
        </div>

        {/* Iteration progress */}
        {job.status === 'coding' && (
          <div className="bg-surface-container rounded-xl p-5 border border-outline-variant/10">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-on-surface-variant">Coding Iteration</span>
              <span className="font-mono text-sm font-bold text-indigo-300">{job.iteration_count} / 10</span>
            </div>
            <div className="h-1.5 bg-surface-container-high rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-indigo-500 to-primary rounded-full transition-all duration-700"
                style={{ width: `${(job.iteration_count / 10) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Failure state */}
        {isFailed && (
          <div className="bg-error-container/10 rounded-xl p-6 border border-error/30">
            <div className="flex items-start gap-3 mb-4">
              <span className="material-symbols-outlined text-error text-[24px] flex-shrink-0">error</span>
              <div>
                <h3 className="font-headline font-bold text-error mb-1">Execution Error</h3>
                <p className="text-sm text-on-surface-variant font-mono leading-relaxed">
                  {job.error ?? 'Job failed or was cancelled.'}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Plan approval prompt */}
        {job.status === 'awaiting_plan_approval' && (
          <div className="bg-surface-container rounded-xl p-6 border border-outline-variant/10 text-center">
            <span className="material-symbols-outlined text-indigo-400 text-[32px] mb-3 block">event_note</span>
            <p className="text-on-surface-variant text-sm mb-4">The agent has produced a plan and is waiting for your review.</p>
            <button
              onClick={() => router.push(`/projects/${projectId}/jobs/${jobId}/plan`)}
              className="bg-gradient-to-br from-primary to-primary-container text-on-primary-container px-8 py-3 rounded-lg font-headline font-extrabold text-sm inline-flex items-center gap-2"
            >
              Review Plan
              <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
            </button>
          </div>
        )}
      </div>
    </JobShell>
  )
}
