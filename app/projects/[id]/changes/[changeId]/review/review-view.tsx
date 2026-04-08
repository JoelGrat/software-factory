'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'

interface Task {
  id: string; description: string; status: string; order_index: number
  system_components: { name: string; type: string } | null
}
interface Commit { id: string; branch_name: string; commit_hash: string; created_at: string }
interface Change { id: string; project_id: string; title: string; intent: string; type: string; risk_level: string | null; status: string }
interface Project { id: string; name: string; repo_url: string | null }

export default function ReviewView({
  change,
  project,
  commit,
  tasks,
  filesModified,
  testsPassed,
  testsFailed,
  iterationCount,
}: {
  change: Change
  project: Project | null
  commit: Commit | null
  tasks: Task[]
  filesModified: string[]
  testsPassed: number
  testsFailed: number
  iterationCount: number
}) {
  const router = useRouter()
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const doneTasks = tasks.filter(t => t.status === 'done').length
  const githubCommitUrl = commit && project?.repo_url
    ? `${project.repo_url}/commit/${commit.commit_hash}`
    : null
  const githubCompareUrl = commit && project?.repo_url
    ? `${project.repo_url}/compare/main...${commit.branch_name}`
    : null

  async function handleApprove() {
    setApproving(true)
    setError(null)
    const res = await fetch(`/api/change-requests/${change.id}/approve`, { method: 'POST' })
    if (res.ok) {
      router.push(`/projects/${project?.id}/changes/${change.id}`)
    } else {
      const data = await res.json().catch(() => ({}))
      setError(data.error ?? 'Failed to approve')
      setApproving(false)
    }
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
          <span className="text-slate-200 font-medium">Review</span>
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
          <div className="max-w-2xl mx-auto space-y-6">

            {/* Header */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-widest font-bold text-indigo-400 font-headline mb-1">Review</p>
                <h1 className="text-2xl font-extrabold font-headline tracking-tight text-on-surface">{change.title}</h1>
                {change.intent && (
                  <p className="text-sm text-slate-500 mt-1">{change.intent}</p>
                )}
              </div>
              <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono text-orange-400 bg-orange-400/10 flex-shrink-0 mt-1">
                review
              </span>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-4 rounded-xl bg-[#131b2e] border border-white/5 divide-x divide-white/5">
              <div className="px-4 py-4">
                <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-1">Tasks</p>
                <p className="text-lg font-extrabold font-mono text-on-surface">{doneTasks}<span className="text-slate-600 text-sm font-normal">/{tasks.length}</span></p>
              </div>
              <div className="px-4 py-4">
                <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-1">Tests</p>
                <p className="text-lg font-extrabold font-mono text-green-400">{testsPassed}
                  {testsFailed > 0 && <span className="text-red-400 text-sm font-normal ml-1">+{testsFailed} fail</span>}
                </p>
              </div>
              <div className="px-4 py-4">
                <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-1">Files</p>
                <p className="text-lg font-extrabold font-mono text-on-surface">{filesModified.length}</p>
              </div>
              <div className="px-4 py-4">
                <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-1">Iterations</p>
                <p className="text-lg font-extrabold font-mono text-on-surface">{iterationCount}</p>
              </div>
            </div>

            {/* Commit card */}
            {commit ? (
              <div className="rounded-xl bg-[#131b2e] border border-white/5 overflow-hidden">
                <div className="px-5 py-4 border-b border-white/5">
                  <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline">Commit</p>
                </div>
                <div className="px-5 py-4 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-mono text-slate-300 truncate">{commit.branch_name}</p>
                    <p className="text-[11px] font-mono text-slate-600 mt-0.5">{commit.commit_hash.slice(0, 12)}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {githubCommitUrl && (
                      <a
                        href={githubCommitUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0f1929] border border-white/10 hover:border-white/20 text-slate-300 text-xs font-medium transition-colors"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>commit</span>
                        View commit
                      </a>
                    )}
                    {githubCompareUrl && (
                      <a
                        href={githubCompareUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0f1929] border border-white/10 hover:border-white/20 text-slate-300 text-xs font-medium transition-colors"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>compare_arrows</span>
                        Compare diff
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl bg-[#131b2e] border border-white/5 px-5 py-4">
                <p className="text-sm text-slate-600">No commit recorded for this execution.</p>
              </div>
            )}

            {/* Files modified */}
            {filesModified.length > 0 && (
              <div className="rounded-xl bg-[#131b2e] border border-white/5 overflow-hidden">
                <div className="px-5 py-4 border-b border-white/5">
                  <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline">Files Modified</p>
                </div>
                <div className="divide-y divide-white/5">
                  {filesModified.map(f => (
                    <div key={f} className="px-5 py-2.5 flex items-center gap-2">
                      <span className="material-symbols-outlined text-slate-600 flex-shrink-0" style={{ fontSize: '14px' }}>draft</span>
                      <span className="text-xs font-mono text-slate-400">{f}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tasks */}
            <div className="rounded-xl bg-[#131b2e] border border-white/5 overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline">Tasks</p>
                <span className="text-[10px] font-mono text-slate-500">{doneTasks}/{tasks.length} done</span>
              </div>
              <div className="divide-y divide-white/5">
                {tasks.map(task => (
                  <div key={task.id} className="px-5 py-3 flex items-start gap-3">
                    <div className="flex-shrink-0 mt-1.5">
                      {task.status === 'done'
                        ? <span className="h-2 w-2 rounded-full bg-green-400 block" />
                        : <span className="h-2 w-2 rounded-full bg-slate-700 block" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-300">{task.description}</p>
                      {task.system_components && (
                        <p className="text-[10px] font-mono text-slate-600 mt-0.5">
                          {task.system_components.name} · {task.system_components.type}
                        </p>
                      )}
                    </div>
                    <span className={`text-[10px] font-mono flex-shrink-0 capitalize ${task.status === 'done' ? 'text-green-400' : 'text-slate-600'}`}>
                      {task.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Action bar */}
            <div className="rounded-xl bg-[#131b2e] border border-white/5 p-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-slate-200">Ready to approve?</p>
                <p className="text-xs text-slate-500 mt-0.5">Approving marks this change as done. The branch stays open for manual merge.</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Link
                  href={`/projects/${project?.id}/changes/${change.id}/execution`}
                  className="px-4 py-2 rounded-lg bg-[#0f1929] border border-white/10 hover:border-white/20 text-slate-300 text-sm font-semibold font-headline transition-colors"
                >
                  Re-run
                </Link>
                <button
                  onClick={handleApprove}
                  disabled={approving}
                  className="px-5 py-2 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white text-sm font-bold font-headline transition-colors"
                >
                  {approving ? 'Approving…' : 'Approve'}
                </button>
              </div>
            </div>
            {error && (
              <p className="text-xs text-red-400 font-mono">{error}</p>
            )}

          </div>
        </main>
      </div>
    </div>
  )
}
