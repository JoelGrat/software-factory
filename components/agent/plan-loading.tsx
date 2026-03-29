'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { JobShell } from '@/components/agent/job-shell'
import { StepIndicator } from '@/components/agent/step-indicator'
import { LogFeed } from '@/components/agent/log-feed'
import type { FeedEntry } from '@/components/agent/log-feed'

interface Props {
  jobId: string
  projectId: string
  projectName: string
  initialError?: string
}

export function PlanLoading({ jobId, projectId, projectName, initialError }: Props) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [logs, setLogs] = useState<FeedEntry[]>([])

  useEffect(() => {
    if (initialError) return

    let intervalId: ReturnType<typeof setInterval>

    const poll = async () => {
      const res = await fetch(`/api/jobs/${jobId}`)
      if (!res.ok) return
      const { job, logs: newLogs } = await res.json()
      if (newLogs) setLogs(newLogs as FeedEntry[])
      if (job.status === 'awaiting_plan_approval') {
        router.refresh()
      } else if (job.status === 'failed') {
        clearInterval(intervalId)
        setError(job.error ?? 'Planning failed — unknown error')
      } else if (job.status === 'cancelled') {
        clearInterval(intervalId)
        router.push(`/projects/${projectId}/requirements`)
      }
    }

    intervalId = setInterval(poll, 2000)
    return () => clearInterval(intervalId)
  }, [jobId, projectId, router, initialError])

  const latestMessage = logs.length > 0
    ? logs[logs.length - 1].message
    : 'Analyzing requirements...'

  const sidebar = (
    <div className="flex flex-col h-full">
      <LogFeed logs={logs} />
    </div>
  )

  return (
    <JobShell
      projectName={projectName}
      projectId={projectId}
      jobId={jobId}
      sidebar={sidebar}
      sidebarTitle={`Activity Log (${logs.length})`}
    >
      <div className="max-w-4xl mx-auto space-y-8">
        <StepIndicator current={3} />
        {error ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <span className="material-symbols-outlined text-error mb-4" style={{ fontSize: '40px' }}>error</span>
            <h2 className="text-xl font-extrabold font-headline text-white mb-2">Planning Failed</h2>
            <p className="text-slate-400 text-sm max-w-md font-mono bg-surface-container px-4 py-3 rounded-lg border border-error/20 mt-2">{error}</p>
            <button
              onClick={() => router.push(`/projects/${projectId}/requirements`)}
              className="mt-6 px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200 border border-white/10 hover:border-white/20 transition-all"
            >
              Back to Requirements
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <span className="relative flex h-5 w-5 mb-6">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-5 w-5 bg-indigo-400" />
            </span>
            <h2 className="text-2xl font-extrabold font-headline text-white mb-2">Generating Plan</h2>
            <p className="text-slate-400 text-sm">{latestMessage}</p>
            <p className="text-slate-600 text-xs mt-2 font-mono">This takes about 30–60 seconds</p>
          </div>
        )}
      </div>
    </JobShell>
  )
}
