'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Job, TestResult } from '@/lib/supabase/types'
import { JobShell } from '@/components/agent/job-shell'
import { StepIndicator } from '@/components/agent/step-indicator'

function DiffViewer({ diff }: { diff: string }) {
  if (!diff) return <p className="text-outline text-xs font-mono">No diff available.</p>
  return (
    <pre className="font-mono text-xs leading-relaxed overflow-x-auto m-0">
      {diff.split('\n').map((line, i) => {
        const color = line.startsWith('+') ? '#22c55e' : line.startsWith('-') ? '#ffb4ab' : line.startsWith('@@') ? '#93c5fd' : '#c7c4d7'
        return <span key={`line-${i}`} style={{ display: 'block', color }}>{line}</span>
      })}
    </pre>
  )
}

interface Props {
  jobId: string
  projectId: string
  projectName: string
  job: Job
  diff: string
  testResult: TestResult | null
}

export function ReviewScreen({ jobId, projectId, projectName, job, diff, testResult }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const isDone = job.status === 'done'

  async function approve() {
    setLoading(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve_review' }),
      })
      if (!res.ok) { setActionError('Failed to approve. Please try again.'); return }
      router.push(`/projects/${projectId}/requirements`)
    } catch {
      setActionError('Failed to approve. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function retry() {
    setLoading(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry' }),
      })
      if (!res.ok) { setActionError('Failed to start retry. Please try again.'); return }
      router.push(`/projects/${projectId}/jobs/${jobId}/execution`)
    } catch {
      setActionError('Failed to start retry. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Count diff lines for stats
  const addedLines = diff.split('\n').filter(l => l.startsWith('+')).length
  const removedLines = diff.split('\n').filter(l => l.startsWith('-')).length

  const sidebar = (
    <div className="p-5 space-y-4">
      {/* Test results */}
      {testResult && (
        <div className="space-y-2">
          <div className="text-[10px] text-outline uppercase font-bold mb-2">Test Results</div>
          <div className="flex items-center gap-3 p-3 bg-surface-container rounded-lg border border-[#22c55e]/20">
            <span className="material-symbols-outlined text-[#22c55e] text-[18px]">check_circle</span>
            <div>
              <div className="text-lg font-bold font-headline text-[#22c55e]">{testResult.passed}</div>
              <div className="text-[10px] text-outline">Passed</div>
            </div>
          </div>
          {testResult.failed > 0 && (
            <div className="flex items-center gap-3 p-3 bg-surface-container rounded-lg border border-error/20">
              <span className="material-symbols-outlined text-error text-[18px]">cancel</span>
              <div>
                <div className="text-lg font-bold font-headline text-error">{testResult.failed}</div>
                <div className="text-[10px] text-outline">Failed</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Branch */}
      <div className="p-3 bg-surface-container rounded-lg border border-outline-variant/10">
        <div className="text-[10px] text-outline uppercase font-bold mb-2">Branch</div>
        <code className="text-xs font-mono text-indigo-300 break-all">{job.branch_name ?? 'not yet created'}</code>
      </div>

      {/* Diff stats */}
      {diff && (
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 bg-surface-container rounded-lg border border-[#22c55e]/10 text-center">
            <div className="text-[10px] text-outline font-bold mb-1">Added</div>
            <div className="text-lg font-bold font-headline text-[#22c55e]">+{addedLines}</div>
          </div>
          <div className="p-3 bg-surface-container rounded-lg border border-error/10 text-center">
            <div className="text-[10px] text-outline font-bold mb-1">Removed</div>
            <div className="text-lg font-bold font-headline text-error">-{removedLines}</div>
          </div>
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
      sidebarTitle="Review Summary"
    >
      <div className="max-w-4xl mx-auto space-y-8">
        <StepIndicator current={4} />

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-extrabold font-headline tracking-tight text-white mb-2">
              Review Changes
            </h1>
            <p className="text-on-surface-variant text-sm">
              Branch: <code className="font-mono text-indigo-300">{job.branch_name ?? 'not yet created'}</code>
            </p>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0 ml-6">
            {isDone ? (
              <div className="flex items-center gap-2 px-4 py-2 bg-[#22c55e]/10 rounded-lg border border-[#22c55e]/20">
                <span className="material-symbols-outlined text-[#22c55e] text-[18px]">verified</span>
                <span className="text-sm font-bold text-[#22c55e]">Approved</span>
              </div>
            ) : (
              <>
                <button
                  onClick={retry}
                  disabled={loading}
                  className="text-xs font-bold text-outline hover:text-white transition-colors uppercase tracking-widest px-4 py-2 disabled:opacity-60"
                >
                  Retry Coding
                </button>
                <button
                  onClick={approve}
                  disabled={loading}
                  className="bg-gradient-to-br from-primary to-primary-container text-on-primary-container px-6 py-2.5 rounded-lg font-headline font-extrabold text-sm flex items-center gap-2 shadow-[0_4px_20px_rgba(189,194,255,0.2)] hover:scale-[1.02] transition-transform active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed disabled:scale-100"
                >
                  {loading ? 'Working...' : 'Approve → Done'}
                  {!loading && <span className="material-symbols-outlined text-[16px]">verified</span>}
                </button>
              </>
            )}
          </div>
        </div>
        {actionError && <p className="text-xs text-error font-mono -mt-4">{actionError}</p>}

        {/* Test results */}
        {testResult && (
          <div className="bg-surface-container rounded-xl p-5 border border-outline-variant/10">
            <h2 className="font-headline font-bold text-sm mb-4 flex items-center gap-2 text-on-surface">
              <span className="material-symbols-outlined text-indigo-400">biotech</span>
              Test Results
            </h2>
            <div className="flex gap-4">
              <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-lowest rounded-lg border border-[#22c55e]/20">
                <span className="material-symbols-outlined text-[#22c55e] text-[20px]">check_circle</span>
                <div>
                  <div className="text-xl font-bold font-headline text-[#22c55e]">{testResult.passed}</div>
                  <div className="text-[10px] text-outline uppercase font-bold">Passed</div>
                </div>
              </div>
              {testResult.failed > 0 && (
                <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-lowest rounded-lg border border-error/20">
                  <span className="material-symbols-outlined text-error text-[20px]">cancel</span>
                  <div>
                    <div className="text-xl font-bold font-headline text-error">{testResult.failed}</div>
                    <div className="text-[10px] text-outline uppercase font-bold">Failed</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Diff viewer */}
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden shadow-2xl">
          <div className="flex items-center justify-between px-4 py-2.5 bg-surface-container-high/50 border-b border-outline-variant/10">
            <div className="flex items-center gap-2">
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-error/40" />
                <div className="w-2.5 h-2.5 rounded-full bg-tertiary/40" />
                <div className="w-2.5 h-2.5 rounded-full bg-primary/40" />
              </div>
              <span className="ml-4 text-[10px] font-bold text-outline font-mono">GIT_DIFF</span>
            </div>
            {diff && (
              <div className="flex items-center gap-4 text-[10px] font-bold">
                <span className="text-[#22c55e]">+{addedLines}</span>
                <span className="text-error">-{removedLines}</span>
              </div>
            )}
          </div>
          <div className="p-5 max-h-[500px] overflow-y-auto no-scrollbar">
            <DiffViewer diff={diff} />
          </div>
        </div>
      </div>
    </JobShell>
  )
}
