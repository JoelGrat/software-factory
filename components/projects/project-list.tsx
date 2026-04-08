'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

type Health = 'critical' | 'warning' | 'healthy' | 'empty'
type ModelQuality = 'HIGH' | 'MEDIUM' | 'LOW' | null

interface Project {
  id: string
  name: string
  scan_status: string
  created_at: string
  componentCount: number
  unstableCount: number
  openChanges: number
  failedChanges: number
  highRiskChanges: number
  lastActivity: string | null
  avgConfidence: number
  health: Health
  modelQuality: ModelQuality
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-GB')
}

function suggestedAction(p: Project): { label: string; href: string } {
  if (p.scan_status === 'failed') return { label: 'Re-scan project', href: `/projects/${p.id}` }
  if (p.failedChanges > 0) return { label: 'Review failed change', href: `/projects/${p.id}` }
  if (p.highRiskChanges > 0) return { label: 'Review high-risk change', href: `/projects/${p.id}` }
  if (p.unstableCount > 0) return { label: 'Check unstable components', href: `/projects/${p.id}/system-model` }
  if (p.componentCount === 0) return { label: 'Run first scan', href: `/projects/${p.id}` }
  if (p.openChanges === 0) return { label: 'Create first change', href: `/projects/${p.id}/changes/new` }
  return { label: 'View dashboard', href: `/projects/${p.id}` }
}

const HEALTH_BORDER: Record<Health, string> = {
  critical: 'border-l-red-500/60',
  warning:  'border-l-amber-500/50',
  healthy:  'border-l-emerald-500/30',
  empty:    'border-l-white/10',
}

const HEALTH_BG: Record<Health, string> = {
  critical: 'bg-red-950/20',
  warning:  'bg-amber-950/10',
  healthy:  'bg-[#131b2e]',
  empty:    'bg-[#0f1624]',
}

const HEALTH_BADGE: Record<Health, { label: string; cls: string }> = {
  critical: { label: '⚠ Critical',  cls: 'text-red-300 bg-red-500/15 border-red-500/30' },
  warning:  { label: '⚠ Warning',   cls: 'text-amber-300 bg-amber-500/15 border-amber-500/30' },
  healthy:  { label: '● Healthy',   cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  empty:    { label: '○ Empty',     cls: 'text-slate-500 bg-slate-500/10 border-slate-500/20' },
}

const MODEL_BADGE: Record<NonNullable<ModelQuality>, { label: string; cls: string }> = {
  HIGH:   { label: 'Model: HIGH',   cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  MEDIUM: { label: 'Model: MED',    cls: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  LOW:    { label: 'Model: LOW',    cls: 'text-red-400 bg-red-500/10 border-red-500/20' },
}

type Filter = 'all' | 'attention' | 'active' | 'idle'

export function ProjectList({ projects: initial }: { projects: Project[] }) {
  const [projects, setProjects] = useState(initial)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const router = useRouter()

  async function handleDelete(id: string) {
    setDeleting(id)
    await fetch(`/api/projects/${id}`, { method: 'DELETE' })
    setProjects(prev => prev.filter(p => p.id !== id))
    setDeleting(null)
    router.refresh()
  }

  const WEEK_MS = 7 * 24 * 60 * 60 * 1000
  const filtered = projects.filter(p => {
    if (filter === 'attention') return p.health === 'critical' || p.health === 'warning'
    if (filter === 'active') {
      const t = p.lastActivity ?? p.created_at
      return Date.now() - new Date(t).getTime() < WEEK_MS
    }
    if (filter === 'idle') {
      const t = p.lastActivity ?? p.created_at
      return Date.now() - new Date(t).getTime() >= WEEK_MS
    }
    return true
  })

  const attentionCount = projects.filter(p => p.health === 'critical' || p.health === 'warning').length

  if (!projects.length) {
    return (
      <div className="rounded-xl p-12 text-center bg-[#131b2e] border border-white/5">
        <p className="text-sm text-slate-500">No projects yet. Create one to get started.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex items-center gap-2">
        {([['all', 'All'], ['attention', `Needs attention`], ['active', 'Active'], ['idle', 'Idle']] as [Filter, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`text-xs px-3 py-1.5 rounded-full font-bold font-mono transition-all flex items-center gap-1.5 ${
              filter === key
                ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                : 'bg-white/5 text-slate-400 hover:bg-white/10 border border-white/5'
            }`}
          >
            {label}
            {key === 'attention' && attentionCount > 0 && (
              <span className="text-[10px] rounded-full bg-red-500/20 text-red-300 px-1.5 py-0.5 border border-red-500/20">{attentionCount}</span>
            )}
          </button>
        ))}
      </div>

      {/* Project cards */}
      <div className="space-y-2">
        {filtered.map(p => {
          const healthBadge = HEALTH_BADGE[p.health]
          const action = suggestedAction(p)
          const activityTime = p.lastActivity ?? p.created_at

          return (
            <div
              key={p.id}
              className={`group rounded-xl border border-l-4 transition-all hover:brightness-110 ${HEALTH_BORDER[p.health]} ${HEALTH_BG[p.health]} border-r-white/5 border-t-white/5 border-b-white/5`}
            >
              {/* Main content — clickable area */}
              <Link href={`/projects/${p.id}`} className="block px-5 pt-4 pb-3">
                {/* Row 1: name + badges */}
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <span className="font-bold text-sm text-on-surface font-headline">{p.name}</span>
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono border ${healthBadge.cls}`}>
                    {healthBadge.label}
                  </span>
                  {p.modelQuality && (
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono border ${MODEL_BADGE[p.modelQuality].cls}`}>
                      {MODEL_BADGE[p.modelQuality].label}
                    </span>
                  )}
                </div>

                {/* Row 2: stats */}
                <div className="flex items-center gap-3 text-[11px] font-mono text-slate-500 flex-wrap mb-2">
                  {p.componentCount > 0 ? (
                    <span>{p.componentCount} component{p.componentCount !== 1 ? 's' : ''}</span>
                  ) : (
                    <span className="text-slate-600">No model yet</span>
                  )}
                  {p.openChanges > 0 && (
                    <span className="text-slate-400">{p.openChanges} open</span>
                  )}
                  {p.highRiskChanges > 0 && (
                    <span className="text-red-400">{p.highRiskChanges} high-risk</span>
                  )}
                  {p.unstableCount > 0 && (
                    <span className="text-amber-400">{p.unstableCount} unstable</span>
                  )}
                  {p.failedChanges > 0 && (
                    <span className="text-red-400">{p.failedChanges} failed</span>
                  )}
                  {p.componentCount === 0 && p.openChanges === 0 && (
                    <span className="text-slate-600 italic">No activity yet</span>
                  )}
                </div>

                {/* Row 3: activity + suggestion */}
                <div className="flex items-center gap-2 text-[11px] text-slate-600">
                  <span>Last active {timeAgo(activityTime)}</span>
                  {p.health !== 'empty' && p.health !== 'healthy' && (
                    <>
                      <span>·</span>
                      <span className={p.health === 'critical' ? 'text-red-400' : 'text-amber-400'}>
                        → {action.label}
                      </span>
                    </>
                  )}
                </div>
              </Link>

              {/* Row 4: actions footer */}
              <div className="px-5 pb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/projects/${p.id}/changes/new`}
                    onClick={e => e.stopPropagation()}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 border border-indigo-500/20 transition-colors"
                  >
                    New Change
                  </Link>
                  {p.componentCount > 0 && (
                    <Link
                      href={`/projects/${p.id}/system-model`}
                      onClick={e => e.stopPropagation()}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-white/5 text-slate-400 hover:bg-white/10 border border-white/5 transition-colors"
                    >
                      View Model
                    </Link>
                  )}
                </div>

                <button
                  onClick={() => handleDelete(p.id)}
                  disabled={deleting === p.id}
                  className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-400/10 transition-all disabled:opacity-40"
                  title="Delete project"
                >
                  {deleting === p.id
                    ? <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>hourglass_empty</span>
                    : <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
                  }
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {filtered.length === 0 && (
        <div className="rounded-xl p-8 text-center bg-[#131b2e] border border-white/5">
          <p className="text-sm text-slate-500">No projects match this filter.</p>
        </div>
      )}
    </div>
  )
}
