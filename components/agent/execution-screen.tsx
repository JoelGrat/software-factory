'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Job, LogEntry, JobStatus } from '@/lib/supabase/types'

const PHASES: { key: string; label: string; statuses: JobStatus[] }[] = [
  { key: 'planning', label: 'Planning', statuses: ['plan_loop', 'awaiting_plan_approval'] },
  { key: 'coding', label: 'Coding', statuses: ['coding'] },
  { key: 'review', label: 'Review', statuses: ['awaiting_review', 'done'] },
]

function phaseStatus(phase: typeof PHASES[0], job: Job): 'pending' | 'active' | 'done' | 'failed' {
  if (job.status === 'failed' || job.status === 'cancelled') {
    if (phase.statuses.includes(job.status as JobStatus)) return 'failed'
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

const levelColor: Record<string, string> = {
  info: 'var(--text-secondary)',
  warn: '#f59e0b',
  error: '#ef4444',
  success: '#22c55e',
}

interface Props {
  jobId: string
  projectId: string
  initialJob: Job
  initialLogs: LogEntry[]
}

export function ExecutionScreen({ jobId, projectId, initialJob, initialLogs }: Props) {
  const router = useRouter()
  const [job, setJob] = useState<Job>(initialJob)
  const [logs, setLogs] = useState<LogEntry[]>(initialLogs)
  const db = createClient()

  useEffect(() => {
    const jobChannel = db
      .channel(`job-${jobId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'jobs', filter: `id=eq.${jobId}` }, payload => {
        const updated = payload.new as Job
        setJob(updated)
        if (updated.status === 'awaiting_plan_approval') {
          router.push(`/projects/${projectId}/jobs/${jobId}/plan`)
        }
        if (updated.status === 'awaiting_review') {
          router.push(`/projects/${projectId}/jobs/${jobId}/review`)
        }
      })
      .subscribe()

    const logsChannel = db
      .channel(`logs-${jobId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'job_logs', filter: `job_id=eq.${jobId}` }, payload => {
        setLogs(prev => [...prev, payload.new as LogEntry])
      })
      .subscribe()

    return () => {
      db.removeChannel(jobChannel)
      db.removeChannel(logsChannel)
    }
  }, [jobId, projectId, router])

  const isFailed = job.status === 'failed' || job.status === 'cancelled'

  return (
    <div style={{ background: 'var(--bg-base)', minHeight: '100vh', padding: '2rem' }}>
      <div style={{ maxWidth: '800px', margin: '0 auto' }}>
        {/* Phase indicator */}
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem', alignItems: 'center' }}>
          {PHASES.map((phase, i) => {
            const ps = phaseStatus(phase, job)
            return (
              <div key={phase.key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{
                  width: '24px', height: '24px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px',
                  background: ps === 'done' ? '#22c55e' : ps === 'active' ? 'var(--accent)' : ps === 'failed' ? '#ef4444' : 'var(--bg-elevated)',
                  color: ps === 'active' || ps === 'done' || ps === 'failed' ? '#000' : 'var(--text-muted)',
                }}>
                  {ps === 'done' ? '✓' : ps === 'failed' ? '✗' : i + 1}
                </div>
                <span style={{ fontSize: '13px', color: ps === 'active' ? 'var(--text-primary)' : 'var(--text-muted)', fontFamily: 'var(--font-jetbrains)' }}>
                  {phase.label}
                </span>
                {i < PHASES.length - 1 && <span style={{ color: 'var(--border-strong)', margin: '0 0.25rem' }}>→</span>}
              </div>
            )
          })}
        </div>

        {/* Iteration counter */}
        {job.status === 'coding' && (
          <div style={{ marginBottom: '1rem', fontSize: '13px', color: 'var(--text-muted)', fontFamily: 'var(--font-jetbrains)' }}>
            Iteration {job.iteration_count} / 10
          </div>
        )}

        {/* Log feed */}
        <div style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '12px',
          padding: '1.25rem',
          fontFamily: 'var(--font-jetbrains)',
          fontSize: '13px',
          minHeight: '400px',
          maxHeight: '600px',
          overflowY: 'auto',
        }}>
          {logs.length === 0 && (
            <span style={{ color: 'var(--text-muted)' }}>Waiting for agent to start...</span>
          )}
          {logs.map(log => (
            <div key={log.id} style={{ marginBottom: '0.375rem', color: levelColor[log.level] ?? 'var(--text-secondary)' }}>
              <span style={{ color: 'var(--text-muted)', marginRight: '0.75rem' }}>
                {new Date(log.created_at).toLocaleTimeString()}
              </span>
              {log.message}
            </div>
          ))}
        </div>

        {/* Failure state */}
        {isFailed && job.error && (
          <div style={{ marginTop: '1.5rem', padding: '1rem', background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444', borderRadius: '8px' }}>
            <p style={{ color: '#ef4444', fontSize: '13px', fontFamily: 'var(--font-jetbrains)' }}>{job.error}</p>
            <button
              onClick={async () => {
                await fetch(`/api/jobs/${jobId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'retry' }) })
              }}
              style={{ marginTop: '0.75rem', padding: '0.5rem 1rem', background: 'var(--accent)', color: '#000', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', border: 'none' }}
            >
              Retry
            </button>
          </div>
        )}

        {/* Plan approval prompt */}
        {job.status === 'awaiting_plan_approval' && (
          <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
            <p style={{ color: 'var(--text-muted)', marginBottom: '0.75rem', fontSize: '13px' }}>Plan is ready for your review.</p>
            <button
              onClick={() => router.push(`/projects/${projectId}/jobs/${jobId}/plan`)}
              style={{ padding: '0.75rem 1.5rem', background: 'var(--accent)', color: '#000', borderRadius: '8px', fontSize: '14px', cursor: 'pointer', border: 'none', fontFamily: 'var(--font-jetbrains)' }}
            >
              Review Plan →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
