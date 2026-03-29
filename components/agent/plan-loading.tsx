'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { JobShell } from '@/components/agent/job-shell'
import { StepIndicator } from '@/components/agent/step-indicator'

interface Props {
  jobId: string
  projectId: string
  projectName: string
  initialError?: string
}

export function PlanLoading({ jobId, projectId, projectName, initialError }: Props) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(initialError ?? null)

  useEffect(() => {
    if (initialError) return  // already failed, no need to poll

    const poll = async () => {
      const res = await fetch(`/api/jobs/${jobId}`)
      if (!res.ok) return
      const { job } = await res.json()
      if (job.status === 'awaiting_plan_approval') {
        router.refresh()
      } else if (job.status === 'failed') {
        setError(job.error ?? 'Planning failed — unknown error')
      } else if (job.status === 'cancelled') {
        router.push(`/projects/${projectId}/requirements`)
      }
    }

    const id = setInterval(poll, 2000)
    return () => clearInterval(id)
  }, [jobId, projectId, router])

  const sidebar = (
    <div className="p-5 space-y-4">
      <div className="p-3 bg-surface-container rounded-lg border border-white/5">
        <p className="text-[10px] text-slate-500 uppercase font-bold font-headline mb-2">Status</p>
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2 flex-shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-400" />
          </span>
          <span className="text-xs text-indigo-300 font-semibold">Generating plan...</span>
        </div>
      </div>
    </div>
  )

  return (
    <JobShell projectName={projectName} projectId={projectId} jobId={jobId} sidebar={sidebar} sidebarTitle="Plan Summary">
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
            <p className="text-slate-400 text-sm">Analyzing requirements and project structure...</p>
            <p className="text-slate-600 text-xs mt-2 font-mono">This takes about 30–60 seconds</p>
          </div>
        )}
      </div>
    </JobShell>
  )
}
