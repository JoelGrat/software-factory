'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'
import { ChangeStepBar } from '@/components/app/change-step-bar'
import { ExecutionLiveStrip } from '@/components/app/execution-live-strip'
import { ExecutionIterationCard } from '@/components/app/execution-iteration-card'

interface LiveEvent {
  id: string
  seq: number
  iteration: number
  event_type: string
  phase?: string
  payload?: Record<string, unknown>
  created_at: string
}

interface RunData {
  id: string
  status: string
  summary?: Record<string, unknown>
  startedAt: string
  endedAt?: string
  cancellationRequested: boolean
}

interface Change {
  id: string
  title: string
  status: string
  risk_level: string | null
}

interface Project { id: string; name: string }

export default function ExecutionView({ change, project }: { change: Change; project: Project | null }) {
  const router = useRouter()
  const [changeStatus, setChangeStatus] = useState(change.status)
  const [run, setRun] = useState<RunData | null>(null)
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [cancelState, setCancelState] = useState<'idle' | 'requesting' | 'cancelled' | 'committing' | 'force_failed'>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const poll = useCallback(async () => {
    const res = await fetch(`/api/change-requests/${change.id}/execute/events`)
    if (!res.ok) return
    const data = await res.json()
    setChangeStatus(data.changeStatus ?? change.status)
    setRun(data.run ?? null)
    setEvents(data.events ?? [])
  }, [change.id, change.status])

  // Polling with visibility-aware interval
  useEffect(() => {
    poll()
    if (run?.status !== 'running') return

    const timer = setInterval(() => {
      if (document.hidden) return
      poll()
    }, 2000)

    const onVisibility = () => {
      if (!document.hidden) poll()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [poll, run?.status])

  // Redirect to review when complete
  useEffect(() => {
    if (changeStatus === 'review') {
      router.push(`/projects/${project?.id}/changes/${change.id}/review`)
    }
  }, [changeStatus, router, project?.id, change.id])

  // Elapsed timer
  useEffect(() => {
    if (elapsedRef.current) clearInterval(elapsedRef.current)
    if (run?.status === 'running' && run.startedAt) {
      const start = new Date(run.startedAt).getTime()
      elapsedRef.current = setInterval(() => setElapsedMs(Date.now() - start), 1000)
    } else {
      setElapsedMs(0)
    }
    return () => { if (elapsedRef.current) clearInterval(elapsedRef.current) }
  }, [run?.status, run?.startedAt])

  async function handleStart() {
    setStarting(true)
    setStartError(null)
    const res = await fetch(`/api/change-requests/${change.id}/execute`, { method: 'POST' })
    if (res.ok) {
      await poll()
    } else {
      const data = await res.json().catch(() => ({}))
      setStartError(data.error ?? 'Failed to start execution')
    }
    setStarting(false)
  }

  async function handleCancel() {
    setCancelState('requesting')
    const res = await fetch(`/api/change-requests/${change.id}/cancel`, { method: 'POST' })
    if (res.ok) {
      setCancelState('cancelled')
    } else {
      setCancelState('force_failed')
    }
  }

  // Group events by iteration
  const iterationMap = new Map<number, LiveEvent[]>()
  for (const e of events) {
    const arr = iterationMap.get(e.iteration) ?? []
    arr.push(e)
    iterationMap.set(e.iteration, arr)
  }
  const iterations = [...iterationMap.entries()]
    .filter(([n]) => n > 0)
    .sort(([a], [b]) => a - b)

  const runActive = run?.status === 'running'
  const runDone = run && run.status !== 'running'

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summary = run?.summary as any

  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50 font-headline antialiased tracking-tight">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/projects" className="font-black text-indigo-400 tracking-tighter hover:text-indigo-300 transition-colors">
            FactoryOS
          </Link>
          <span className="text-slate-600">/</span>
          <Link href={`/projects/${project?.id}`} className="text-slate-400 hover:text-slate-200 transition-colors font-medium truncate max-w-[160px]">
            {project?.name}
          </Link>
          <span className="text-slate-600">/</span>
          <Link href={`/projects/${project?.id}/changes/${change.id}`} className="text-slate-400 hover:text-slate-200 transition-colors font-medium truncate max-w-[200px]">
            {change.title}
          </Link>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200 font-medium">Execution</span>
        </div>
        <div className="flex items-center gap-1">
          <Link href="/settings" className="p-2 text-slate-400 hover:text-slate-200 hover:bg-[#171f33] rounded-lg transition-all" title="Settings">
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>settings</span>
          </Link>
          <div className="w-px h-5 bg-white/10 mx-1" />
          <ProfileAvatar />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <LeftNav />
        <main className="flex-1 overflow-y-auto p-10">
          <div className="max-w-2xl mx-auto space-y-4">
            <ChangeStepBar projectId={project?.id ?? ''} changeId={change.id} current="execution" changeStatus={changeStatus} />

            {/* Title */}
            <div className="space-y-1">
              <h1 className="text-2xl font-extrabold tracking-tight text-on-surface leading-snug">{change.title}</h1>
              <p className="text-xs text-slate-500 font-mono">
                {run ? `Run ${run.id.slice(0, 8)} · ${run.status}` : 'No run yet'}
              </p>
            </div>

            {/* Live strip (running) */}
            {runActive && (
              <ExecutionLiveStrip
                events={events}
                runActive={true}
                elapsedMs={elapsedMs}
                cancelState={cancelState}
                onCancel={handleCancel}
              />
            )}

            {/* Final state banner (done) */}
            {runDone && summary && (
              <div className={`rounded-xl border px-5 py-4 flex items-center gap-3 ${
                summary.status === 'success' ? 'bg-green-500/10 border-green-500/20' :
                summary.status === 'wip'     ? 'bg-yellow-500/10 border-yellow-500/20' :
                'bg-red-500/10 border-red-500/20'
              }`}>
                <span className={`material-symbols-outlined ${
                  summary.status === 'success' ? 'text-green-400' :
                  summary.status === 'wip'     ? 'text-yellow-400' :
                  'text-red-400'
                }`} style={{ fontSize: '20px' }}>
                  {summary.status === 'success' ? 'check_circle' : summary.status === 'wip' ? 'warning' : 'cancel'}
                </span>
                <div>
                  <p className="text-sm font-semibold text-slate-200">
                    {summary.status === 'success' && `Done in ${summary.iterationsUsed} iteration${summary.iterationsUsed !== 1 ? 's' : ''}`}
                    {summary.status === 'wip' && `WIP commit — ${summary.finalFailureType ?? 'checks incomplete'}`}
                    {summary.status === 'budget_exceeded' && `Budget exceeded — ${summary.iterationsUsed} iterations used`}
                    {summary.status === 'blocked' && `Blocked — ${summary.finalFailureType ?? 'stuck detector fired'}`}
                    {summary.status === 'cancelled' && `Cancelled after ${summary.iterationsUsed} iteration${summary.iterationsUsed !== 1 ? 's' : ''}`}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5 font-mono">
                    {summary.filesChanged?.length ?? 0} files · {summary.repairsAttempted ?? 0} repairs · {Math.round((summary.durationMs ?? 0) / 1000)}s
                  </p>
                </div>
              </div>
            )}

            {/* Fallback when run ended but summary not available */}
            {runDone && !summary && (
              <div className="rounded-xl border border-white/10 px-5 py-4 flex items-center gap-3 bg-white/[0.02]">
                <span className="material-symbols-outlined text-slate-500" style={{ fontSize: '20px' }}>info</span>
                <p className="text-sm text-slate-400">
                  Run {run!.status} — no summary available.
                </p>
              </div>
            )}

            {/* Error panel */}
            {runDone && summary && ['blocked', 'budget_exceeded'].includes(summary.status) && (
              <div className="rounded-xl bg-[#131b2e] border border-red-500/20 overflow-hidden">
                <div className="px-5 py-4 border-b border-white/5">
                  <p className="text-xs font-bold uppercase tracking-widest text-red-400 font-headline">What happened</p>
                </div>
                <div className="px-5 py-4 space-y-2">
                  <p className="text-sm text-slate-300">{summary.finalFailureType ?? 'The execution could not complete.'}</p>
                  <p className="text-xs text-slate-500">
                    {summary.status === 'blocked'
                      ? 'Review the iteration history below to find the repeated failure pattern.'
                      : `All ${summary.iterationsUsed} iterations were used without passing all checks.`}
                  </p>
                  {summary.filesChanged?.length > 0 && (
                    <p className="text-xs font-mono text-slate-500">Files touched: {(summary.filesChanged as string[]).join(', ')}</p>
                  )}
                  <button
                    onClick={async () => {
                      await navigator.clipboard.writeText(JSON.stringify(events, null, 2))
                    }}
                    className="mt-2 text-[10px] font-mono text-slate-500 hover:text-slate-300 flex items-center gap-1"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>download</span>
                    Download run log
                  </button>
                </div>
              </div>
            )}

            {/* Iteration cards */}
            {iterations.length > 0 && (
              <div className="space-y-3">
                {iterations.map(([n, evs], i) => (
                  <ExecutionIterationCard
                    key={n}
                    iteration={n}
                    events={evs}
                    defaultExpanded={i === iterations.length - 1}
                  />
                ))}
              </div>
            )}

            {/* Empty state */}
            {!run && !starting && (
              <div className="rounded-xl bg-[#131b2e] border border-white/5 px-8 py-12 text-center space-y-4">
                <span className="material-symbols-outlined text-slate-600 block" style={{ fontSize: '40px' }}>play_circle</span>
                <div>
                  <p className="text-sm font-semibold text-slate-300">No executions yet</p>
                  <p className="text-xs text-slate-500 mt-1">Run this change to see live progress, iteration history, and repair evidence.</p>
                </div>
                <button
                  onClick={handleStart}
                  className="px-5 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white text-sm font-bold font-headline transition-colors"
                >
                  Run execution
                </button>
              </div>
            )}

            {/* Start button when run is done */}
            {runDone && (
              <div className="flex items-center justify-between rounded-xl bg-[#131b2e] border border-white/5 px-5 py-4">
                <p className="text-sm text-slate-400">Run again from the beginning</p>
                <button
                  onClick={handleStart}
                  disabled={starting}
                  className="px-4 py-2 rounded-lg bg-[#0f1929] border border-white/10 hover:border-white/20 text-slate-300 text-sm font-semibold font-headline transition-colors disabled:opacity-50"
                >
                  {starting ? 'Starting…' : 'Re-run'}
                </button>
              </div>
            )}

            {startError && (
              <p className="text-xs text-red-400 font-mono">{startError}</p>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
