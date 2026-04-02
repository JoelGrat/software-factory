// app/projects/[id]/changes/[changeId]/execution/execution-view.tsx
'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'

interface Snapshot {
  id: string; iteration: number; files_modified: string[]
  tests_passed: number; tests_failed: number; error_summary: string | null
  termination_reason: string | null; planned_files: string[]
  propagated_files: string[]; plan_divergence: boolean; partial_success: boolean
}

interface TraceEntry {
  id: string; iteration: number; task_id: string; context_mode: string
  strategy_used: string; failure_type: string | null; confidence: number | null
}

interface Task {
  id: string; description: string; status: string
  failure_type: string | null; last_error: string | null; order_index: number
  system_components: { name: string; type: string } | null
}

interface Change { id: string; title: string; status: string; risk_level: string | null }
interface Project { id: string; name: string }

const STATUS_POLLING = ['executing']

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    executing: 'bg-blue-100 text-blue-800', review: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800', done: 'bg-gray-100 text-gray-700',
  }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  )
}

function taskStatusDot(status: string) {
  if (status === 'done') return <span className="w-2 h-2 rounded-full bg-green-500 inline-block mr-2" />
  if (status === 'failed') return <span className="w-2 h-2 rounded-full bg-red-500 inline-block mr-2" />
  return <span className="w-2 h-2 rounded-full bg-gray-300 inline-block mr-2" />
}

export default function ExecutionView({ change, project }: { change: Change; project: Project | null }) {
  const router = useRouter()
  const [status, setStatus] = useState(change.status)
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [traces, setTraces] = useState<TraceEntry[]>([])

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
  const plannedCount = latestSnapshot?.planned_files.length ?? 0
  const propagatedCount = latestSnapshot?.propagated_files.length ?? 0
  const planDivergence = latestSnapshot?.plan_divergence ?? false

  return (
    <div className="min-h-screen bg-gray-50 flex">
      <LeftNav projectName={project?.name} />
      <div className="flex-1 flex flex-col">
        <header className="bg-white border-b px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">{change.title}</h1>
            <p className="text-sm text-gray-500 mt-0.5">Execution</p>
          </div>
          <div className="flex items-center gap-3">
            {statusBadge(status)}
            <ProfileAvatar />
          </div>
        </header>

        <main className="flex-1 p-6 max-w-4xl mx-auto w-full space-y-6">

          {/* Plan divergence warning */}
          {planDivergence && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
              <strong>Execution deviating from plan</strong> — propagation expanded scope beyond threshold. Human approval required to continue.
            </div>
          )}

          {/* Scope tracker */}
          {(plannedCount > 0 || propagatedCount > 0) && (
            <div className="bg-white rounded-lg border p-4">
              <h2 className="text-sm font-medium text-gray-700 mb-3">Execution Scope</h2>
              <div className="flex gap-6 text-sm">
                <div><span className="text-gray-500">Planned files:</span> <span className="font-medium">{plannedCount}</span></div>
                {propagatedCount > 0 && (
                  <div><span className="text-gray-500">Added via propagation:</span> <span className="font-medium text-amber-600">+{propagatedCount}</span></div>
                )}
                <div><span className="text-gray-500">Iterations:</span> <span className="font-medium">{snapshots.length}</span></div>
              </div>
            </div>
          )}

          {/* Task list */}
          <div className="bg-white rounded-lg border">
            <div className="px-5 py-4 border-b">
              <h2 className="text-sm font-medium text-gray-700">Tasks</h2>
            </div>
            <ul className="divide-y">
              {tasks.map(task => (
                <li key={task.id} className="px-5 py-3">
                  <div className="flex items-start gap-2">
                    <div className="mt-1.5">{taskStatusDot(task.status)}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-800">{task.description}</p>
                      {task.system_components && (
                        <p className="text-xs text-gray-400 mt-0.5">
                          {task.system_components.name} · {task.system_components.type}
                        </p>
                      )}
                      {task.status === 'failed' && task.last_error && (
                        <pre className="mt-2 text-xs text-red-700 bg-red-50 rounded p-2 overflow-x-auto whitespace-pre-wrap">
                          {task.last_error.slice(0, 300)}
                        </pre>
                      )}
                    </div>
                    <div className="text-xs text-gray-400 capitalize">{task.status}</div>
                  </div>
                </li>
              ))}
              {tasks.length === 0 && (
                <li className="px-5 py-6 text-center text-sm text-gray-400">Loading tasks…</li>
              )}
            </ul>
          </div>

          {/* Iterations */}
          {snapshots.length > 0 && (
            <div className="bg-white rounded-lg border">
              <div className="px-5 py-4 border-b">
                <h2 className="text-sm font-medium text-gray-700">Iterations</h2>
              </div>
              <ul className="divide-y">
                {snapshots.map(snap => (
                  <li key={snap.id} className="px-5 py-3 flex items-center justify-between text-sm">
                    <span className="text-gray-700">Iteration {snap.iteration}</span>
                    <div className="flex items-center gap-4 text-gray-500">
                      <span>{snap.tests_passed} passed · {snap.tests_failed} failed</span>
                      <span>{snap.files_modified.length} files</span>
                      {snap.termination_reason && (
                        <span className={`capitalize ${snap.termination_reason === 'passed' ? 'text-green-600' : 'text-red-500'}`}>
                          {snap.termination_reason}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Action buttons */}
          {(status === 'review') && (
            <div className="flex justify-end">
              <button
                onClick={() => router.push(`/projects/${project?.id}/changes/${change.id}/review` )}
                className="px-4 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-700"
              >
                Go to Review
              </button>
            </div>
          )}

          {status === 'executing' && (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              Executing… polling every 2 seconds
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
