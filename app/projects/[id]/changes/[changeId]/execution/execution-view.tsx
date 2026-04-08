'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'

interface Snapshot {
  id: string; iteration: number; files_modified: string[]
  tests_passed: number; tests_failed: number; error_summary: string | null
  termination_reason: string | null; planned_files: string[]
  propagated_files: string[]; plan_divergence: boolean; partial_success: boolean
  duration_ms: number | null
}

interface TraceEntry {
  id: string; iteration: number; task_id: string; context_mode: string
  failure_type: string | null; confidence: number | null
}

interface Task {
  id: string; description: string; status: string
  failure_type: string | null; last_error: string | null; order_index: number
  system_components: { name: string; type: string } | null
}

interface Change { id: string; title: string; status: string; risk_level: string | null }
interface Project { id: string; name: string }

const STATUS_POLLING = ['executing']

const STATUS_COLORS: Record<string, string> = {
  planned:   'text-purple-400 bg-purple-400/10',
  executing: 'text-amber-400 bg-amber-400/10',
  review:    'text-orange-400 bg-orange-400/10',
  done:      'text-green-400 bg-green-400/10',
  failed:    'text-red-400 bg-red-400/10',
}

function Badge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono ${colorClass}`}>
      {label}
    </span>
  )
}

export default function ExecutionView({ change, project }: { change: Change; project: Project | null }) {
  const router = useRouter()
  const [status, setStatus] = useState(change.status)
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [traces, setTraces] = useState<TraceEntry[]>([])
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  const poll = useCallback(async () => {
    const res = await fetch(`/api/change-requests/${change.id}/execute`)
    if (!res.ok) return
    const data = await res.json()
    setStatus(data.status)
    setSnapshots(data.snapshots ?? [])
    setTasks(data.tasks ?? [])
    setTraces(data.traces ?? [])
  }, [change.id])

  useEffect(() => {
    poll()
    if (!STATUS_POLLING.includes(status)) return
    const timer = setInterval(poll, 2000)
    return () => clearInterval(timer)
  }, [status, poll])

  const latestSnapshot = snapshots[snapshots.length - 1]
  const latestTraceByTask = new Map<string, TraceEntry>()
  for (const t of traces) latestTraceByTask.set(t.task_id, t)
  const failureTypeByIteration = new Map<number, string>()
  for (const t of traces) {
    if (t.failure_type && !failureTypeByIteration.has(t.iteration))
      failureTypeByIteration.set(t.iteration, t.failure_type)
  }

  const plannedCount = latestSnapshot?.planned_files.length ?? 0
  const propagatedCount = latestSnapshot?.propagated_files.length ?? 0
  const planDivergence = latestSnapshot?.plan_divergence ?? false

  const failureSnapshot = status === 'failed'
    ? (snapshots.find(s => s.error_summary) ?? latestSnapshot)
    : null

  function diagnoseError(msg: string | null): { title: string; steps: string[] } {
    if (!msg) return { title: 'Unknown error', steps: ['Check server logs for details.'] }
    const m = msg.toLowerCase()
    if (m.includes('dockerdesktoplinuxengine') || m.includes('cannot connect to the docker daemon') || (m.includes('docker') && m.includes('daemon'))) {
      return {
        title: 'Docker is not running',
        steps: [
          'Open Docker Desktop and wait until the engine shows "Running".',
          'Verify Docker is ready: run `docker info` in a terminal.',
          'Then click Retry below.',
        ],
      }
    }
    if (m.includes('no repository configured') || m.includes('repo_url')) {
      return {
        title: 'No repository configured',
        steps: ['Go to Project Settings → Repository and set a valid GitHub URL.'],
      }
    }
    if (m.includes('no access token configured')) {
      return {
        title: 'No access token configured',
        steps: ['Go to Project Settings → Repository and add a GitHub access token with read/write access.'],
      }
    }
    if (m.includes('failed to install git') || m.includes('git: not found')) {
      return {
        title: 'Git installation failed',
        steps: [
          'The Docker container could not install git — check that Docker has internet access.',
          'If running behind a proxy, configure Docker Desktop with your proxy settings.',
        ],
      }
    }
    if (m.includes('git clone') || m.includes('authentication') || m.includes('403') || m.includes('401')) {
      return {
        title: 'Repository access failed',
        steps: [
          'Check the repo URL and access token in Project Settings → Repository.',
          'Ensure the token has read/write (push) access to the repository.',
        ],
      }
    }
    if (m.includes('npm install') || m.includes('enoent') || m.includes('package')) {
      return {
        title: 'Dependency installation failed',
        steps: [
          'Verify the repository has a valid package.json.',
          'Check for network issues or private package registry access.',
        ],
      }
    }
    if (m.includes('error ts') || m.includes('error TS') || /\(\d+,\d+\): error/.test(m)) {
      return {
        title: 'TypeScript type check failed',
        steps: [
          'The repository has type errors that must be fixed before execution can proceed.',
          'Review the error detail below to find the affected files.',
        ],
      }
    }
    if (m.includes('no approved plan found')) {
      return {
        title: 'No approved plan found',
        steps: ['Go back to the change and approve the plan before executing.'],
      }
    }
    return {
      title: 'Execution failed',
      steps: ['Check the error details below and server logs for more context.'],
    }
  }

  const doneTasks = tasks.filter(t => t.status === 'done').length
  const failedTasks = tasks.filter(t => t.status === 'failed').length

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
          <Link href={`/projects/${project?.id}/changes/${change.id}`} className="text-slate-400 hover:text-slate-200 transition-colors font-medium truncate max-w-[160px]">
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
        <main className="flex-1 overflow-y-auto bg-[#0b1326] p-10">
          <div className="max-w-3xl mx-auto space-y-6">

            {/* Page header */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-widest font-bold text-indigo-400 font-headline mb-1">Execution</p>
                <h1 className="text-2xl font-extrabold font-headline tracking-tight text-on-surface">{change.title}</h1>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <Badge label={status} colorClass={STATUS_COLORS[status] ?? 'text-slate-400 bg-slate-400/10'} />
                {change.risk_level && (
                  <Badge
                    label={`${change.risk_level} risk`}
                    colorClass={change.risk_level === 'high' ? 'text-red-400 bg-red-400/10' : change.risk_level === 'medium' ? 'text-amber-400 bg-amber-400/10' : 'text-green-400 bg-green-400/10'}
                  />
                )}
              </div>
            </div>

            {/* Execute CTA */}
            {status === 'planned' && (
              <div className="rounded-xl bg-[#131b2e] border border-white/5 overflow-hidden">
                <div className="p-6 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-slate-200 mb-1">Plan approved — ready to execute</p>
                    <p className="text-xs text-slate-500">The AI agent will work through each task and run tests after every iteration.</p>
                  </div>
                  <button
                    disabled={starting}
                    onClick={async () => {
                      setStarting(true)
                      setStartError(null)
                      const res = await fetch(`/api/change-requests/${change.id}/execute`, { method: 'POST' })
                      if (res.ok) {
                        setStatus('executing')
                      } else {
                        const data = await res.json().catch(() => ({}))
                        setStartError(data.detail ?? data.error ?? 'Failed to start execution')
                      }
                      setStarting(false)
                    }}
                    className="flex-shrink-0 px-5 py-2.5 rounded-lg bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white text-sm font-bold font-headline transition-colors"
                  >
                    {starting ? 'Checking…' : 'Execute'}
                  </button>
                </div>
                {startError && (
                  <div className="flex items-start gap-2.5 px-6 py-3 border-t border-red-400/10 bg-red-400/5">
                    <span className="material-symbols-outlined text-red-400 flex-shrink-0 mt-0.5" style={{ fontSize: '15px' }}>error</span>
                    <div>
                      <p className="text-xs font-semibold text-red-300">Docker is not running</p>
                      <p className="text-[11px] text-red-400/70 mt-0.5">Start Docker Desktop, wait until the engine shows "Running", then try again.</p>
                      {startError && <p className="text-[10px] font-mono text-red-400/50 mt-1">{startError}</p>}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Executing pulse */}
            {status === 'executing' && (
              <div className="flex items-center gap-3 text-sm text-slate-400">
                <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-60" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-400" />
                </span>
                Executing — updating every 2 seconds
              </div>
            )}

            {/* Failure card */}
            {status === 'failed' && (() => {
              const errorMsg = failureSnapshot?.error_summary ?? null
              const { title, steps } = diagnoseError(errorMsg)
              return (
                <div className="rounded-xl bg-[#131b2e] border border-red-400/20 overflow-hidden">
                  <div className="flex items-center gap-3 px-5 py-4 border-b border-red-400/10">
                    <span className="material-symbols-outlined text-red-400 flex-shrink-0" style={{ fontSize: '18px' }}>error</span>
                    <div>
                      <p className="text-sm font-semibold text-red-300">{title}</p>
                      <p className="text-[10px] text-red-400/60 font-mono mt-0.5">iteration {failureSnapshot?.iteration ?? 0} · {failureSnapshot?.termination_reason ?? 'unknown'}</p>
                    </div>
                  </div>
                  <div className="px-5 py-4 space-y-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-2">What to do</p>
                      <ol className="space-y-1">
                        {steps.map((step, i) => (
                          <li key={i} className="flex items-start gap-2 text-xs text-slate-400">
                            <span className="flex-shrink-0 font-mono text-slate-600">{i + 1}.</span>
                            {step}
                          </li>
                        ))}
                      </ol>
                    </div>
                    {errorMsg && (
                      <div>
                        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-2">Error detail</p>
                        <pre className="text-[10px] text-red-400/70 bg-red-400/5 border border-red-400/10 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                          {errorMsg.slice(0, 600)}
                        </pre>
                      </div>
                    )}
                    <div className="pt-1 space-y-2">
                      <button
                        disabled={starting}
                        onClick={async () => {
                          setStarting(true)
                          setStartError(null)
                          const res = await fetch(`/api/change-requests/${change.id}/execute`, { method: 'POST' })
                          if (res.ok) {
                            setStatus('executing'); setSnapshots([]); setTasks([]); setTraces([])
                          } else {
                            const data = await res.json().catch(() => ({}))
                            setStartError(data.detail ?? data.error ?? 'Failed to start execution')
                          }
                          setStarting(false)
                        }}
                        className="px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white text-xs font-bold font-headline transition-colors"
                      >
                        {starting ? 'Checking…' : 'Retry Execution'}
                      </button>
                      {startError && (
                        <p className="text-[10px] font-mono text-red-400/70">{startError}</p>
                      )}
                    </div>
                  </div>
                </div>
              )
            })()}

            {/* Plan divergence warning */}
            {planDivergence && (
              <div className="rounded-xl p-4 bg-amber-400/5 border border-amber-400/20 flex items-start gap-3">
                <span className="material-symbols-outlined text-amber-400 flex-shrink-0" style={{ fontSize: '18px' }}>warning</span>
                <div>
                  <p className="text-sm font-semibold text-amber-300">Execution deviating from plan</p>
                  <p className="text-xs text-amber-400/70 mt-0.5">Propagation expanded scope beyond threshold. Human approval required to continue.</p>
                </div>
              </div>
            )}

            {/* Scope stats */}
            {(plannedCount > 0 || propagatedCount > 0 || snapshots.length > 0) && (
              <div className="grid grid-cols-3 rounded-xl bg-[#131b2e] border border-white/5 divide-x divide-white/5">
                <div className="px-5 py-4">
                  <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-1">Planned Files</p>
                  <p className="text-lg font-extrabold font-mono text-on-surface">{plannedCount}</p>
                </div>
                <div className="px-5 py-4">
                  <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-1">Propagated</p>
                  <p className={`text-lg font-extrabold font-mono ${propagatedCount > 0 ? 'text-amber-400' : 'text-on-surface'}`}>
                    {propagatedCount > 0 ? `+${propagatedCount}` : '0'}
                  </p>
                </div>
                <div className="px-5 py-4">
                  <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-1">Iterations</p>
                  <p className="text-lg font-extrabold font-mono text-on-surface">{snapshots.length}</p>
                </div>
              </div>
            )}

            {/* Tasks */}
            <div className="rounded-xl bg-[#131b2e] border border-white/5 overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline">Tasks</p>
                {tasks.length > 0 && (
                  <span className="text-[10px] font-mono text-slate-500">
                    {doneTasks}/{tasks.length} done{failedTasks > 0 && ` · ${failedTasks} failed`}
                  </span>
                )}
              </div>
              <div className="divide-y divide-white/5">
                {tasks.length === 0 ? (
                  <div className="px-5 py-8 text-center text-sm text-slate-600">
                    {status === 'planned' ? 'Tasks will appear once execution starts.' : 'Loading tasks…'}
                  </div>
                ) : tasks.map(task => {
                  const trace = latestTraceByTask.get(task.id)
                  return (
                    <div key={task.id} className="px-5 py-3.5 flex items-start gap-3">
                      <div className="flex-shrink-0 mt-1">
                        {task.status === 'done' ? (
                          <span className="h-2 w-2 rounded-full bg-green-400 block" />
                        ) : task.status === 'failed' ? (
                          <span className="h-2 w-2 rounded-full bg-red-400 block" />
                        ) : (
                          <span className="h-2 w-2 rounded-full bg-slate-700 block" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-300">{task.description}</p>
                        {task.system_components && (
                          <p className="text-[10px] font-mono text-slate-600 mt-0.5">
                            {task.system_components.name} · {task.system_components.type}
                          </p>
                        )}
                        {trace && (
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-400/10 text-indigo-300">
                              {trace.context_mode}
                            </span>
                            {trace.confidence != null && (
                              <span className="text-[10px] font-mono text-slate-500">{trace.confidence}% confidence</span>
                            )}
                          </div>
                        )}
                        {task.status === 'failed' && (
                          <div className="mt-2 space-y-1">
                            {task.failure_type && (
                              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-400/10 text-red-400">
                                {task.failure_type}
                              </span>
                            )}
                            {task.last_error && (
                              <pre className="text-[10px] text-red-400/80 bg-red-400/5 border border-red-400/10 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
                                {task.last_error.slice(0, 300)}
                              </pre>
                            )}
                          </div>
                        )}
                      </div>
                      <span className={`text-[10px] font-mono flex-shrink-0 capitalize ${
                        task.status === 'done' ? 'text-green-400' :
                        task.status === 'failed' ? 'text-red-400' : 'text-slate-600'
                      }`}>
                        {task.status}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Iterations */}
            {snapshots.length > 0 && (
              <div className="rounded-xl bg-[#131b2e] border border-white/5 overflow-hidden">
                <div className="px-5 py-4 border-b border-white/5">
                  <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline">Iterations</p>
                </div>
                <div className="divide-y divide-white/5">
                  {snapshots.map(snap => (
                    <div key={snap.id} className="px-5 py-3 flex items-center justify-between">
                      <span className="text-sm text-slate-400 font-mono">Iteration {snap.iteration}</span>
                      <div className="flex items-center gap-4">
                        <span className="text-xs font-mono text-slate-500">
                          <span className="text-green-400">{snap.tests_passed} passed</span>
                          {snap.tests_failed > 0 && <> · <span className="text-red-400">{snap.tests_failed} failed</span></>}
                        </span>
                        <span className="text-xs font-mono text-slate-600">{snap.files_modified.length} files</span>
                        {snap.duration_ms && (
                          <span className="text-xs font-mono text-slate-600">{(snap.duration_ms / 1000).toFixed(1)}s</span>
                        )}
                        {snap.termination_reason && (
                          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded capitalize ${
                            snap.termination_reason === 'passed'
                              ? 'text-green-400 bg-green-400/10'
                              : 'text-red-400 bg-red-400/10'
                          }`}>
                            {snap.termination_reason}
                          </span>
                        )}
                        {failureTypeByIteration.get(snap.iteration) && (
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-400/10 text-red-400">
                            {failureTypeByIteration.get(snap.iteration)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Review CTA */}
            {(status === 'review' || latestSnapshot?.partial_success) && (
              <div className="rounded-xl p-5 bg-[#131b2e] border border-white/5 flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-slate-200 mb-1">Execution complete</p>
                  <p className="text-xs text-slate-500">Review the changes before merging.</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    disabled={starting}
                    onClick={async () => {
                      setStarting(true)
                      setStartError(null)
                      const res = await fetch(`/api/change-requests/${change.id}/execute`, { method: 'POST' })
                      if (res.ok) {
                        setStatus('executing'); setSnapshots([]); setTasks([]); setTraces([])
                      } else {
                        const data = await res.json().catch(() => ({}))
                        setStartError(data.detail ?? data.error ?? 'Failed to start execution')
                      }
                      setStarting(false)
                    }}
                    className="px-4 py-2 rounded-lg bg-[#0f1929] border border-white/10 hover:border-white/20 text-slate-300 text-sm font-semibold font-headline transition-colors disabled:opacity-50"
                  >
                    {starting ? 'Starting…' : 'Re-run'}
                  </button>
                  <button
                    onClick={() => router.push(`/projects/${project?.id}/changes/${change.id}/review`)}
                    className="px-4 py-2 rounded-lg bg-green-500 hover:bg-green-400 text-white text-sm font-bold font-headline transition-colors"
                  >
                    Go to Review
                  </button>
                </div>
              </div>
            )}

          </div>
        </main>
      </div>
    </div>
  )
}
