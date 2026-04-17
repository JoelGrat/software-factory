'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'
import { ChangeStepBar } from '@/components/app/change-step-bar'
import { ExecutionLiveStrip } from '@/components/app/execution-live-strip'

function str(v: unknown, fallback = ''): string {
  return v != null ? String(v) : fallback
}

function lines(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join('\n')
}

function formatEventAsLog(e: { event_type: string; iteration: number; payload?: Record<string, unknown> }): { level: 'success' | 'error' | 'info' | 'dim'; message: string } {
  const t = e.event_type
  const p = e.payload ?? {}
  const iter = e.iteration > 0 ? ` [task ${e.iteration + 1}]` : ''

  // ── Execution lifecycle ───────────────────────────────────────────────────
  if (t === 'execution.started') return { level: 'info', message: 'Execution started' }
  if (t === 'execution.completed') return { level: 'success', message: 'Execution complete' }
  if (t === 'execution.blocked') return { level: 'error', message: `Blocked — ${str(p.reason, 'unknown')}` }
  if (t === 'execution.cancelled') return { level: 'dim', message: 'Cancelled' }

  // ── Task lifecycle ────────────────────────────────────────────────────────
  if (t === 'task.started') {
    const title = str(p.title)
    const files = (p.files as string[] | undefined) ?? []
    const deps = (p.dependsOn as string[] | undefined) ?? []
    return {
      level: 'info',
      message: lines(
        `─── Task ${e.iteration + 1}: ${title}`,
        files.length > 0 ? `    files: ${files.join(', ')}` : null,
        deps.length > 0  ? `    deps:  ${deps.join(', ')}` : null,
      ),
    }
  }

  if (t === 'task.files_written') {
    const files = (p.files as string[] | undefined) ?? []
    const newCount = p.newFileCount as number | undefined
    if (files.length === 0) return { level: 'dim', message: 'No files written' }
    return {
      level: 'info',
      message: lines(
        `Files written (${files.length}${newCount != null ? `, ${newCount} new` : ''}):`,
        ...files.map(f => `  + ${f}`),
      ),
    }
  }

  if (t === 'task.validation_started') {
    return { level: 'dim', message: `${iter} Validating…` }
  }

  if (t === 'task.validation_passed') {
    return { level: 'success', message: `${iter} Validation passed` }
  }

  if (t === 'task.validation_failed') {
    const failureType = str(p.failureType, 'unknown')
    const summary = str(p.summary, 'validation failed')
    const errors = (p.errors as string[] | undefined) ?? []
    return {
      level: 'error',
      message: lines(
        `${iter} ${failureType}: ${summary}`,
        ...errors.map(e => `  ${e}`),
      ),
    }
  }

  if (t === 'task.repair_started') {
    const strategy = str(p.strategy, 'inline')
    const attempt = typeof p.attempt === 'number' ? p.attempt : null
    return {
      level: 'info',
      message: `${iter} Repair ${attempt != null ? `#${attempt + 1}` : ''} · strategy: ${strategy}`,
    }
  }

  if (t === 'task.repair_completed') {
    const success = p.success as boolean | undefined
    return {
      level: success ? 'success' : 'dim',
      message: `${iter} Repair ${success ? 'succeeded' : 'did not resolve errors'}`,
    }
  }

  if (t === 'task.completed') {
    const ms = typeof p.durationMs === 'number' ? ` · ${(p.durationMs / 1000).toFixed(1)}s` : ''
    return { level: 'success', message: `${iter} Task done${ms}` }
  }

  if (t === 'task.failed') {
    const reason = str(p.reason, str(p.stuckReason, 'failed'))
    return { level: 'error', message: `${iter} Task failed — ${reason}` }
  }

  if (t === 'task.blocked') {
    return { level: 'dim', message: `${iter} Task blocked` }
  }

  // ── Inline repair ─────────────────────────────────────────────────────────
  if (t === 'repair.inline.started') {
    const strategy = str(p.strategy, 'targeted')
    const errorCount = typeof p.errorCount === 'number' ? ` · ${p.errorCount} error${p.errorCount !== 1 ? 's' : ''}` : ''
    const files = (p.files as string[] | undefined) ?? []
    return {
      level: 'info',
      message: lines(
        `${iter} Inline repair [${strategy}]${errorCount}`,
        files.length > 0 ? `    targeting: ${files.join(', ')}` : null,
      ),
    }
  }

  if (t === 'repair.inline.succeeded') {
    const patched = (p.filesPatched as string[] | undefined) ?? []
    const rationale = str(p.rationale)
    return {
      level: 'success',
      message: lines(
        `${iter} Repair applied (${patched.length} file${patched.length !== 1 ? 's' : ''})`,
        ...patched.map(f => `  ✓ ${f}`),
        rationale ? `  "${rationale}"` : null,
      ),
    }
  }

  if (t === 'repair.inline.failed') {
    const rationale = str(p.rationale)
    return {
      level: 'error',
      message: lines(
        `${iter} Repair produced no fix`,
        rationale ? `  "${rationale}"` : null,
      ),
    }
  }

  if (t === 'repair.phase.started')   return { level: 'info',    message: `${iter} Test repair started…` }
  if (t === 'repair.phase.succeeded') return { level: 'success', message: `${iter} Test repair applied` }
  if (t === 'repair.phase.failed')    return { level: 'error',   message: `${iter} Test repair failed` }
  if (t === 'repair.escalated')       return { level: 'error',   message: `${iter} Repair escalated — stuck` }

  // ── Baseline ──────────────────────────────────────────────────────────────
  if (t === 'baseline.started')       return { level: 'dim',  message: 'Baseline check…' }
  if (t === 'baseline.clean')         return { level: 'dim',  message: 'Baseline clean' }
  if (t === 'baseline.pre_existing')  return { level: 'dim',  message: `Baseline: ${str(p.count, '?')} pre-existing test failure${p.count !== 1 ? 's' : ''} (filtered)` }
  if (t === 'baseline.tsc_pre_existing') return { level: 'dim', message: `Baseline: ${str(p.count, '?')} pre-existing TS error${p.count !== 1 ? 's' : ''} (filtered)` }
  if (t === 'baseline.blocked')       return { level: 'error', message: `Baseline blocked — ${str(p.reason, 'unresolvable')}` }
  if (t === 'baseline.repaired')      return { level: 'info',  message: 'Baseline repaired' }

  // ── Commit ────────────────────────────────────────────────────────────────
  if (t === 'commit.green')   return { level: 'success', message: `Green commit — ${str(p.sha, '').slice(0, 8) || 'pushed'}` }
  if (t === 'commit.wip')     return { level: 'info',    message: `WIP commit — ${str(p.reason)}` }
  if (t === 'commit.skipped') return { level: 'dim',     message: `Commit skipped — ${str(p.reason)}` }
  if (t === 'commit.failed')  return { level: 'error',   message: `Commit failed — ${str(p.reason)}` }

  // ── Free-form log lines ───────────────────────────────────────────────────
  if (t === 'log.info')    return { level: 'info',    message: str(p.message) }
  if (t === 'log.success') return { level: 'success', message: str(p.message) }
  if (t === 'log.error')   return { level: 'error',   message: str(p.message) }

  // ── Legacy / catch-all ────────────────────────────────────────────────────
  if (t === 'iteration.stuck')     return { level: 'error', message: `Stuck — ${str(p.reason, 'unknown')}` }
  if (t === 'iteration.completed') return { level: 'dim',   message: 'Iteration complete' }
  if (t === 'phase.skipped')       return { level: 'dim',   message: `Phase skipped — ${str(p.reason)}` }

  return { level: 'dim', message: t }
}

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

interface TaskRow {
  id: string
  description: string
  order_index: number
  status: string
  failure_reason: string | null
  blocked_by_task_id: string | null
  completed_at: string | null
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
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [cancelState, setCancelState] = useState<'idle' | 'requesting' | 'cancelled' | 'committing' | 'force_failed'>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Track the status we arrived with — only auto-redirect if we *transition* to 'review'
  const initialStatusRef = useRef(change.status)

  const poll = useCallback(async () => {
    const res = await fetch(`/api/change-requests/${change.id}/execute/events`)
    if (!res.ok) return
    const data = await res.json()
    setChangeStatus(data.changeStatus ?? change.status)
    setRun(data.run ?? null)
    setEvents(data.events ?? [])
    if (data.tasks) setTasks(data.tasks)
    // Restore cancel state from server — handles page refresh while cancellation is in flight
    if (data.run?.cancellationRequested) {
      setCancelState(prev => prev === 'idle' ? 'cancelled' : prev)
    }
  }, [change.id, change.status])

  // Polling with visibility-aware interval.
  // Poll whenever the run is active OR the change is in executing state (run row may not exist yet).
  const shouldPoll = run?.status === 'running' || changeStatus === 'executing'

  useEffect(() => {
    poll()
    if (!shouldPoll) return

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
  }, [poll, shouldPoll])

  // Redirect to review only when the status *transitions* to 'review' during this visit.
  // If we arrived with status already 'review' (user navigated back after completion),
  // don't redirect — let them view the execution history.
  useEffect(() => {
    if (changeStatus === 'review' && initialStatusRef.current !== 'review') {
      router.push(`/projects/${project?.id}/changes/${change.id}/review`)
    }
  }, [changeStatus, router, project?.id, change.id])

  // Elapsed timer
  useEffect(() => {
    if (elapsedRef.current) clearInterval(elapsedRef.current)
    if (run?.status === 'running' && !run.cancellationRequested && run.startedAt) {
      const start = new Date(run.startedAt).getTime()
      elapsedRef.current = setInterval(() => setElapsedMs(Date.now() - start), 1000)
    } else {
      setElapsedMs(0)
    }
    return () => { if (elapsedRef.current) clearInterval(elapsedRef.current) }
  }, [run?.status, run?.cancellationRequested, run?.startedAt])

  async function handleStart(fromTaskId?: string) {
    setStarting(true)
    setStartError(null)
    setCancelState('idle')
    const res = await fetch(`/api/change-requests/${change.id}/execute`, {
      method: 'POST',
      ...(fromTaskId ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromTaskId }) } : {}),
    })
    if (res.ok) {
      setChangeStatus('executing') // optimistic — keeps polling alive while run row is being created
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

  const runActive = run?.status === 'running'
  const runDone = run && run.status !== 'running'

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summary = run?.summary as any

  function getTaskUiState(
    task: TaskRow,
    taskEvents: LiveEvent[],
  ): 'queued' | 'running' | 'repairing' | 'done' | 'failed' | 'blocked' {
    if (task.status === 'done') return 'done'
    if (task.status === 'failed') return 'failed'
    if (task.status === 'blocked') return 'blocked'

    const lastEvent = taskEvents[taskEvents.length - 1]
    if (!lastEvent) return 'queued'
    if (lastEvent.event_type === 'task.repair_started') return 'repairing'
    if (lastEvent.event_type === 'task.started' || lastEvent.event_type === 'task.validation_started') return 'running'
    return 'queued'
  }

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
        <main className="flex-1 overflow-hidden flex">
          {/* Main content */}
          <div className="flex-1 overflow-y-auto p-10">
          <div className="max-w-3xl mx-auto space-y-4">
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
                summary.status === 'cancelled' ? 'bg-slate-500/10 border-slate-500/20' :
                'bg-red-500/10 border-red-500/20'
              }`}>
                <span className={`material-symbols-outlined ${
                  summary.status === 'success' ? 'text-green-400' :
                  summary.status === 'wip'     ? 'text-yellow-400' :
                  summary.status === 'cancelled' ? 'text-slate-400' :
                  'text-red-400'
                }`} style={{ fontSize: '20px' }}>
                  {summary.status === 'success' ? 'check_circle' : summary.status === 'wip' ? 'warning' : summary.status === 'cancelled' ? 'stop_circle' : 'cancel'}
                </span>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-slate-200">
                    {summary.status === 'success' && `Done in ${summary.iterationsUsed} iteration${summary.iterationsUsed !== 1 ? 's' : ''}`}
                    {summary.status === 'wip' && `WIP commit — ${summary.finalFailureType ?? 'checks incomplete'}`}
                    {summary.status === 'budget_exceeded' && `Budget exceeded — ${summary.iterationsUsed} iterations used`}
                    {summary.status === 'blocked' && `Blocked — ${summary.finalFailureType ?? 'stuck detector fired'}`}
                    {summary.status === 'cancelled' && `Cancelled`}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5 font-mono">
                    {summary.filesChanged?.length ?? 0} files · {summary.repairsAttempted ?? 0} repairs · {Math.round((summary.durationMs ?? 0) / 1000)}s
                  </p>
                </div>
                {summary.status === 'cancelled' && (
                  <button
                    onClick={() => handleStart()}
                    disabled={starting}
                    className="flex-shrink-0 px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white text-sm font-bold font-headline transition-colors"
                  >
                    {starting ? 'Starting…' : 'Run again'}
                  </button>
                )}
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

            {/* Task list */}
            {tasks.length > 0 && (
              <div className="rounded-xl bg-[#131b2e] border border-white/5 overflow-hidden">
                <div className="divide-y divide-white/5">
                  {tasks.map(task => {
                    const taskEvents = events.filter(e =>
                      (e.payload as { taskId?: string } | undefined)?.taskId === task.id
                    )
                    const uiState = getTaskUiState(task, taskEvents)

                    const statusColors: Record<string, string> = {
                      done:      'text-green-400 bg-green-400/10',
                      failed:    'text-red-400 bg-red-400/10',
                      blocked:   'text-slate-500 bg-slate-500/10',
                      running:   'text-indigo-400 bg-indigo-400/10',
                      repairing: 'text-amber-400 bg-amber-400/10',
                      queued:    'text-slate-600 bg-slate-700/30',
                    }

                    const blockedByIndex = task.blocked_by_task_id
                      ? tasks.findIndex(t => t.id === task.blocked_by_task_id) + 1
                      : null

                    return (
                      <div key={task.id} className="px-5 py-4">
                        <div className="flex items-start gap-3">
                          <span className={`mt-0.5 flex-shrink-0 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${statusColors[uiState] ?? statusColors['queued']}`}>
                            {uiState}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-slate-200 leading-snug">{task.description}</p>

                            {/* Blocked reason */}
                            {uiState === 'blocked' && blockedByIndex && (
                              <p className="mt-1 text-xs text-slate-500">
                                Blocked by task {blockedByIndex}
                              </p>
                            )}

                            {/* Failure reason + retrigger */}
                            {uiState === 'failed' && (
                              <div className="mt-2 flex items-start gap-3 flex-wrap">
                                {task.failure_reason && (
                                  <p className="text-xs text-red-400 font-mono leading-snug break-all">{task.failure_reason}</p>
                                )}
                                <button
                                  onClick={() => handleStart(task.id)}
                                  disabled={starting}
                                  className="flex-shrink-0 px-3 py-1 rounded border border-white/10 text-xs text-slate-400 hover:text-slate-200 hover:border-white/20 font-bold transition-colors disabled:opacity-50"
                                >
                                  {starting ? 'Starting…' : 'Retrigger'}
                                </button>
                              </div>
                            )}

                            {/* Live events for active task */}
                            {(uiState === 'running' || uiState === 'repairing') && taskEvents.length > 0 && (
                              <div className="mt-2 space-y-0.5">
                                {taskEvents.slice(-3).map(e => (
                                  <p key={`${e.id}`} className="text-[11px] text-slate-600 font-mono">
                                    {e.event_type}
                                  </p>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* Run summary footer */}
                {run?.summary && (() => {
                  const trs = (run.summary as { taskRunSummary?: { finalStatus: string; completedTasks: string[]; failedTasks: string[]; blockedTasks: string[]; totalTasks: number } }).taskRunSummary
                  if (!trs) return null
                  return (
                    <div className="px-5 py-4 border-t border-white/5 flex items-center gap-4 text-xs text-slate-500">
                      <span className={`font-bold ${
                        trs.finalStatus === 'success' ? 'text-green-400' :
                        trs.finalStatus === 'partial' ? 'text-amber-400' :
                        'text-red-400'
                      }`}>
                        {trs.finalStatus.toUpperCase()}
                      </span>
                      <span>{trs.completedTasks.length}/{trs.totalTasks} tasks completed</span>
                      {trs.failedTasks.length > 0 && (
                        <span className="text-red-400">{trs.failedTasks.length} failed</span>
                      )}
                      {trs.blockedTasks.length > 0 && (
                        <span>{trs.blockedTasks.length} blocked</span>
                      )}
                    </div>
                  )
                })()}
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
                  onClick={() => handleStart()}
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
                  onClick={() => handleStart()}
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
          </div>

          {/* Log sidebar */}
          <div className="w-80 flex-shrink-0 border-l border-white/5 flex flex-col bg-[#080f1e]">
            <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between flex-shrink-0">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline">Execution Log</p>
              {runActive && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-60" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-400" />
                </span>
              )}
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] space-y-0.5">
              {events.length === 0 && (
                <p className="text-slate-700 py-4 text-center">
                  {run ? 'No events yet…' : 'Events will appear once execution starts.'}
                </p>
              )}
              {events.map(e => {
                const { level, message } = formatEventAsLog(e)
                const msgLines = message.split('\n')
                return (
                  <div key={e.id} className={`py-0.5 leading-relaxed ${
                    level === 'success' ? 'text-green-400' :
                    level === 'error'   ? 'text-red-400'   :
                    level === 'dim'     ? 'text-slate-600' :
                    'text-slate-300'
                  }`}>
                    {msgLines.map((line, i) => (
                      <div key={i} className="flex gap-2">
                        <span className="flex-shrink-0 text-slate-700 select-none w-3">
                          {i === 0 ? (level === 'success' ? '✓' : level === 'error' ? '✗' : '›') : ''}
                        </span>
                        <span className="whitespace-pre-wrap break-words min-w-0">{line}</span>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
